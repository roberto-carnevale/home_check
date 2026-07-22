// Load environment variables from the .env file
// This allows us to keep secrets out of the codebase
require('dotenv').config();
const crypto = require('crypto');

// Import the Express framework
// Express makes it easy to build HTTP servers in Node.js
const express = require('express');

// Import the CORS middleware
// CORS is necessary if the frontend is hosted on a different domain
const cors = require('cors');

// Import the rate limit middleware
// This helps protect against brute-force and DDoS attacks
const rateLimit = require('express-rate-limit');

// Import path module to resolve static file directories
// This is a built-in Node.js module
const path = require('path');

// Import our custom route handlers
// These encapsulate the logic for specific endpoints
// data.js exports { router, setBroadcast } to avoid a circular dependency
const { router: dataRouter, setBroadcast } = require('./routes/data');
const subscribeRoutes = require('./routes/subscribe');
const watchdogRoutes = require('./routes/watchdog');
const hmacMiddleware = require('./middleware/hmac');
const firestore = require('./services/firestore');
const mailer = require('./services/mailer');

// Import the watchdog service
// This service monitors data freshness and sends alerts if data stops
const watchdog = require('./services/watchdog');

// Fail fast if required secrets are missing
const REQUIRED_SECRETS = ['HMAC_SECRET_KEY', 'SESSION_SECRET'];
for (const key of REQUIRED_SECRETS) {
    if (!process.env[key]) {
        console.error(`FATAL: ${key} environment variable is not set. Aborting.`);
        process.exit(1);
    }
}

// Initialize the Express application
// This creates our main server object
const app = express();

const publicDirectory = path.join(__dirname, 'public');
const LOGIN_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const getCookie = (req, name) => {
    const cookies = (req.headers.cookie || '').split(';');
    const cookie = cookies.find(value => value.trim().startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.trim().slice(name.length + 1)) : null;
};

const signSession = (expiresAt, token) => {
    const value = `${expiresAt}.${token}`;
    const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET)
        .update(value)
        .digest('hex');
    return `${value}.${signature}`;
};

const isAuthenticated = (req) => {
    const session = getCookie(req, 'hc_session');
    if (!session) return false;

    const parts = session.split('.');
    if (parts.length !== 3) return false;

    const [expiresAt, token, signature] = parts;
    if (!/^\d+$/.test(expiresAt) || Number(expiresAt) < Math.floor(Date.now() / 1000)) return false;

    const expected = signSession(expiresAt, token).split('.').pop();
    return signature.length === expected.length && crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
    );
};

const requireAuth = (req, res, next) => {
    if (isAuthenticated(req)) return next();
    if (req.path === '/' || req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login.html');
};

// Determine the port to listen on
// Default to 8080 if not specified in the environment
const PORT = process.env.PORT || 8080;

// Create a Set to hold all active SSE clients
// A Set is used to easily add and remove client Response objects
const sseClients = new Set();

// Define a rate limiter for the data endpoint
// 60 requests per 15 minutes is plenty for normal sensor operation
const dataLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes window
    max: 60, // Limit each IP to 60 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

// Rate limiter for login code requests: 3 per 15 minutes per IP
const authRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: 'Too many access code requests. Try again later.'
});

// Rate limiter for code verification: 5 attempts per 10 minutes per IP
const authVerifyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: 'Too many verification attempts. Try again later.'
});

// Configure CORS with explicit origin
// We restrict cross-origin requests to our allowed frontend domain
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || '*'
}));

// Parse incoming JSON payloads
// We limit the payload size to 10kb to prevent memory exhaustion attacks
// The verify callback saves the raw body buffer on the request so the HMAC
// middleware can hash the exact bytes the ESP32 signed (avoids re-serialization
// differences such as float formatting: 25.50 vs 25.5).
app.use(express.json({
    limit: '10kb',
    verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// Serve the login page and static assets without exposing the dashboard HTML.
app.use(express.static(publicDirectory, { index: false }));

app.get('/', requireAuth, (_req, res) => {
    res.sendFile(path.join(publicDirectory, 'index.html'));
});

app.post('/api/auth/request-code', authRequestLimiter, async (_req, res) => {
    const code = String(crypto.randomInt(100000, 1000000));
    try {
        await firestore.saveLoginChallenge({
            codeHash: crypto.createHash('sha256').update(code).digest('hex'),
            expiresAt: Date.now() + LOGIN_CHALLENGE_TTL_MS
        });
        await mailer.sendLoginCode(code);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error sending dashboard login code:', error);
        res.status(500).json({ error: 'Unable to send access code' });
    }
});

app.post('/api/auth/verify-code', authVerifyLimiter, async (req, res) => {
    const code = String(req.body.code || '');
    if (!/^\d{6}$/.test(code)) {
        return res.status(401).json({ error: 'Invalid access code' });
    }

    try {
        const challenge = await firestore.getLoginChallenge();
        const codeHash = crypto.createHash('sha256').update(code).digest('hex');
        const storedHash = challenge && challenge.codeHash;
        const valid = typeof storedHash === 'string' && storedHash.length === codeHash.length &&
            challenge.expiresAt > Date.now() &&
            crypto.timingSafeEqual(Buffer.from(codeHash), Buffer.from(storedHash));
        if (!valid) return res.status(401).json({ error: 'Invalid or expired access code' });

        await firestore.clearLoginChallenge();
        const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
        const session = signSession(expiresAt, crypto.randomBytes(24).toString('hex'));
        res.setHeader('Set-Cookie', `hc_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Path=/${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error verifying dashboard login code:', error);
        res.status(500).json({ error: 'Unable to verify access code' });
    }
});

// Broadcast function: sends a sensor reading to all connected SSE clients.
// Defined here (in index.js) because it owns the sseClients Set.
const broadcast = (data) => {
    // Serialize the data object once so all clients get the same string
    const message = `data: ${JSON.stringify(data)}\n\n`;

    // Iterate over each open SSE response object and write the event
    for (const client of sseClients) {
        client.write(message);
    }
};

// Inject the broadcast function into the data route module.
// This breaks the circular require: data.js never imports index.js.
setBroadcast(broadcast);

// Define the SSE endpoint for live real-time dashboard updates
// Clients connect here and keep the connection open
app.get('/api/sse', requireAuth, (req, res) => {
    // Set standard SSE headers
    // These headers tell the client to expect an ongoing stream of text
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Flush headers to the client immediately
    // This establishes the connection without waiting for data
    res.flushHeaders();

    // Add this new client to our Set of active clients
    // This ensures they will receive future broadcasts
    sseClients.add(res);

    // Handle client disconnection
    // When the client closes the tab or network drops, remove them
    req.on('close', () => {
        sseClients.delete(res);
    });
});

// Define the history endpoint for dashboard initial charts data and PIR alarm log
app.get('/api/history', requireAuth, async (req, res) => {
    try {
        const firestore = require('./services/firestore');
        const history = await firestore.get48HoursHistory();
        const pirEvents = await firestore.getLatest10PirEvents();
        res.status(200).json({ history, pirEvents });
    } catch (error) {
        console.error('Error fetching history:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Expose runtime configuration to the frontend
// The browser needs the VAPID public key to subscribe to push notifications.
app.get('/api/config', requireAuth, (req, res) => {
    res.status(200).json({
        publicVapidKey: process.env.VAPID_PUBLIC_KEY || ''
    });
});

// Return the desired PIR state for the dashboard.
app.get('/api/pir', requireAuth, async (_req, res) => {
    try {
        const command = await firestore.getPirCommand();
        res.status(200).json({ enabled: command.enabled === true });
    } catch (error) {
        console.error('Error fetching PIR state:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Update the desired PIR state from the dashboard.
app.post('/api/pir', requireAuth, async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    try {
        const command = await firestore.setPirCommand(req.body.enabled);
        res.status(200).json({ enabled: command.enabled });
    } catch (error) {
        console.error('Error updating PIR state:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// The ESP32 polls this signed endpoint for the latest dashboard command.
app.get('/api/pir/command', hmacMiddleware, async (_req, res) => {
    try {
        const command = await firestore.getPirCommand();
        const updatedAt = command.updatedAt
            ? (command.updatedAt.seconds || command.updatedAt._seconds || 0)
            : 0;
        res.status(200).json({ enabled: command.enabled === true, updated_at: updatedAt });
    } catch (error) {
        console.error('Error fetching PIR command:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Mount the data route with the rate limiter applied first
// dataRouter is the Express Router from routes/data.js
app.use('/api/data', dataLimiter, dataRouter);

// Mount the subscribe route for Web Push subscription registration
app.use('/api/subscribe', requireAuth, subscribeRoutes);

// Mount the watchdog check endpoint for Cloud Run scheduler polling
app.use('/api/watchdog', watchdogRoutes);

// Start the Express server
// Listen on the specified port and log a startup message
const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    // Start the watchdog timer as soon as the server is up
    // This ensures we expect data immediately upon startup
    watchdog.resetWatchdog();
});

// Handle graceful shutdown on SIGTERM (sent by Cloud Run)
// This ensures we close connections cleanly when stopping
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    // Stop the watchdog to prevent orphaned timers
    watchdog.stopWatchdog();
    // Close the server and end all active connections
    server.close(() => {
        console.log('HTTP server closed');
    });
});
