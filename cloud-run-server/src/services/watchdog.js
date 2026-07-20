// Import the mailer and webpush services
// The watchdog needs these to send emergency notifications when triggered
const mailer = require('./mailer');
const webpush = require('./webpush');

// Define the timeout duration in milliseconds
// 95 minutes ensures we have a bit of leeway if the sensor is supposed to report every 90 mins
const TIMEOUT_MS = 95 * 60 * 1000;

// Declare a module-level variable to hold the timer reference
// This allows us to clear and reset the same timer across multiple function calls
let watchdogTimer = null;

// Function to handle the watchdog triggering
// This is executed if the timer ever completes without being reset
const onWatchdogFire = () => {
    // Define the critical alert message
    // This indicates a complete failure of the sensor or network
    const alertMessage = 'CRITICAL: No data received from sensor for 95 minutes. Sensor may be offline or power is out.';
    console.error(alertMessage);

    // Send an email alert to the configured admins
    // We use a high-priority subject line
    mailer.sendAlert('Watchdog Timeout: Sensor Offline', alertMessage);

    // Send a push notification to all subscribed devices
    // This ensures users are notified immediately on their phones
    webpush.sendPushToAll('Sensor Offline', alertMessage);

    // Note: We do NOT automatically restart the watchdog here.
    // It will remain triggered until the sensor comes back online and resets it via data POST.
};

// Export the watchdog control functions
// These are called by the route handlers and server startup
module.exports = {
    // Function to reset the watchdog timer
    // Call this every time a valid data payload is received
    resetWatchdog() {
        // If a timer is already running, clear it
        // This prevents multiple timers from running simultaneously
        if (watchdogTimer) {
            clearTimeout(watchdogTimer);
        }

        // Start a new timer with the configured timeout duration
        // When it expires, it will call onWatchdogFire
        watchdogTimer = setTimeout(onWatchdogFire, TIMEOUT_MS);
        console.log(`Watchdog reset. Will fire in ${TIMEOUT_MS / 60000} minutes if no data received.`);
    },

    // Function to stop the watchdog timer completely
    // Useful for graceful server shutdowns or testing
    stopWatchdog() {
        // If the timer is active, clear it and set the reference to null
        // This cleanly removes the scheduled task from the Event Loop
        if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
            console.log('Watchdog stopped.');
        }
    }
};
