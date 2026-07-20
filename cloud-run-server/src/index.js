// Load environment variables from the .env file
// This allows us to keep secrets out of the codebase
require('dotenv').config();

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

// Import the watchdog service
// This service monitors data freshness and sends alerts if data stops
const watchdog = require('./services/watchdog');

// Initialize the Express application
// This creates our main server object
const app = express();

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

// Serve static files from the public directory
// This serves our PWA dashboard (index.html, manifest.json, sw.js)
app.use(express.static(path.join(__dirname, 'public')));

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
app.get('/api/sse', (req, res) => {
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
app.get('/api/history', async (req, res) => {
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

// Mount the data route with the rate limiter applied first
// dataRouter is the Express Router from routes/data.js
app.use('/api/data', dataLimiter, dataRouter);

// Mount the subscribe route for Web Push subscription registration
app.use('/api/subscribe', subscribeRoutes);

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
