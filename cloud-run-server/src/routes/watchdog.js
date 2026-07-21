const router = require('express').Router();
const watchdog = require('../services/watchdog');

const handleWatchdogCheck = async (req, res) => {
    try {
        const result = await watchdog.checkWatchdog();
        res.status(200).json(result);
    } catch (error) {
        console.error('Watchdog check failed:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

router.get('/', handleWatchdogCheck);
router.post('/', handleWatchdogCheck);

module.exports = router;
