const crypto = require('crypto');
const router = require('express').Router();
const watchdog = require('../services/watchdog');

// Verify the request carries a valid watchdog bearer token.
// Cloud Scheduler sends this as an Authorization header.
const verifyWatchdogToken = (req, res, next) => {
    const token = process.env.WATCHDOG_TOKEN;
    if (!token) {
        console.error('WATCHDOG_TOKEN is not configured');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const authHeader = req.headers['authorization'] || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!bearer || bearer.length !== token.length ||
        !crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(token))) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
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

router.get('/', verifyWatchdogToken, handleWatchdogCheck);
router.post('/', verifyWatchdogToken, handleWatchdogCheck);

module.exports = router;
