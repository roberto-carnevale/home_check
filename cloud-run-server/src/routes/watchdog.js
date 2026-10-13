const crypto = require('crypto');
const router = require('express').Router();
const watchdog = require('../services/watchdog');
const { OAuth2Client } = require('google-auth-library');

const oauthClient = new OAuth2Client();

// Verify the request is from Cloud Scheduler.
// Accepts two auth schemes so both setup styles work:
//   1. OIDC token  — Cloud Scheduler native auth (GCP Console default).
//      The JWT audience must match the service host.
//      Optionally restrict to a specific service account via SCHEDULER_SA env var.
//   2. Static bearer token — legacy, matches WATCHDOG_TOKEN env var.
const verifyWatchdogToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'] || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!bearer) {
        console.error('[Watchdog] Missing Authorization header');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // --- Try OIDC first (Cloud Scheduler native auth) ---
    try {
        const audience = `https://${req.headers.host}`;
        const ticket = await oauthClient.verifyIdToken({ idToken: bearer, audience });
        const payload = ticket.getPayload();
        const allowedSA = process.env.SCHEDULER_SA;
        if (allowedSA && payload.email !== allowedSA) {
            console.error(`[Watchdog] OIDC caller ${payload.email} not in allowlist`);
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return next();
    } catch (_oidcErr) {
        // Not a valid OIDC token — fall through to static token check
    }

    // --- Fall back to static WATCHDOG_TOKEN ---
    const token = process.env.WATCHDOG_TOKEN;
    if (token && bearer.length === token.length &&
        crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(token))) {
        return next();
    }

    console.error('[Watchdog] Auth failed: token invalid or missing');
    return res.status(401).json({ error: 'Unauthorized' });
};

const handleWatchdogCheck = async (req, res) => {
    try {
        const result = await watchdog.checkWatchdog();
        res.status(200).json(result);
    } catch (error) {
        console.error('Watchdog check failed:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

// Wrap the async auth middleware so Express catches rejections
const asyncAuth = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', asyncAuth(verifyWatchdogToken), handleWatchdogCheck);
router.post('/', asyncAuth(verifyWatchdogToken), handleWatchdogCheck);

module.exports = router;
