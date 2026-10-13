// Import the express router
// This allows us to define modular route handlers
const router = require('express').Router();

// Import the middlewares and services
// These handle security, validation, database, and alerting
const hmacMiddleware = require('../middleware/hmac');
const validateMiddleware = require('../middleware/validate');
const firestore = require('../services/firestore');
const watchdog = require('../services/watchdog');
const mailer = require('../services/mailer');
const webpush = require('../services/webpush');

// Define the environmental alert thresholds
// These determine when we send emergency notifications
const THRESHOLDS = {
    tempHigh: 35,    // Trigger alert if temp goes above 35°C
    tempLow: 5,      // Trigger alert if temp drops below 5°C
    humidityHigh: 80, // Trigger alert if humidity exceeds 80%
    humidityLow: 20,  // Trigger alert if humidity drops below 20%
    lightLow: 50,     // Trigger alert if light is persistently low (power outage?)
    tvocHigh: 450     // Trigger alert if TVOC exceeds 450 ppb (poor air quality)
};

// Module-level reference to the SSE broadcast function.
// Set by index.js via setBroadcast() after the server starts.
// Using a setter avoids a circular require between data.js and index.js.
let broadcastFn = null;

// Setter called by index.js once the broadcast function is ready.
// This is the standard Node.js pattern for breaking circular dependencies.
const setBroadcast = (fn) => {
    broadcastFn = fn;
};

// Apply the HMAC and validation middlewares to this route
// The request must pass both before reaching the handler
router.post('/', hmacMiddleware, validateMiddleware, async (req, res) => {
    try {
        // Extract the validated payload from the request body
        // We know it's safe and formatted correctly because of Joi
        const data = req.body;

        // Save the reading to Firestore
        // This persists our historical data for later analysis
        await firestore.saveReading(data);

        // Reset the watchdog timer since we received valid data
        // This prevents the "No data received" alert from firing
        watchdog.resetWatchdog();

        // Reconcile PIR state between dashboard and ESP32.
        // If the device reports its local pir_enabled, sync it with Firestore and
        // get back the authoritative global state plus a flag indicating whether
        // the device needs to be corrected. For older firmware that omits the field,
        // fall back to a plain Firestore read.
        let pirEnabled;
        let needsPirSync = false;
        let pirCommandTs = 0;
        if (typeof data.pir_enabled === 'boolean') {
            // pir_state_ts is pirUpdatedAt on the device — the Unix timestamp of
            // the last button press or applied remote command, not the report time.
            const sync = await firestore.syncEsp32PirState(data.pir_enabled, data.pir_state_ts || 0)
                .catch(() => ({ globalEnabled: data.pir_enabled, needsSync: false, commandTs: 0 }));
            pirEnabled = sync.globalEnabled;
            needsPirSync = sync.needsSync;
            pirCommandTs = sync.commandTs || 0;
        } else {
            const pirCommand = await firestore.getPirCommand().catch(() => ({ enabled: false }));
            pirEnabled = pirCommand.enabled === true;
        }

        // Initialize an array to collect any triggered threshold alerts
        // We might have multiple alerts (e.g. cold AND dark)
        const alerts = [];

        // Check environmental thresholds
        if (data.temperature.avg > THRESHOLDS.tempHigh) {
            alerts.push(`High Temperature Alert: ${data.temperature.avg.toFixed(1)}°C`);
        }
        if (data.temperature.avg < THRESHOLDS.tempLow) {
            alerts.push(`Low Temperature Alert: ${data.temperature.avg.toFixed(1)}°C`);
        }
        if (data.humidity.avg > THRESHOLDS.humidityHigh) {
            alerts.push(`High Humidity Alert: ${data.humidity.avg.toFixed(1)}%`);
        }
        if (data.humidity.avg < THRESHOLDS.humidityLow) {
            alerts.push(`Low Humidity Alert: ${data.humidity.avg.toFixed(1)}%`);
        }
        if (data.tvoc && data.tvoc.avg > THRESHOLDS.tvocHigh) {
            alerts.push(`High TVOC Alert: ${data.tvoc.avg.toFixed(0)} ppb — poor air quality`);
        }

        // Process PIR motion
        if (data.motion_detected === true) {
            console.log(`PIR activated on device ${data.device_id} at ${new Date(data.timestamp * 1000).toISOString()}`);
            if (pirEnabled) {
                alerts.push('Motion Alert: Intrusion / Motion detected in monitored area!');
            }
        }

        // If any alerts were triggered, notify users via email and push.
        // We fire-and-forget (no await) so the ESP32 gets a fast response.
        if (alerts.length > 0) {
            const alertMessage = alerts.join('\n');
            console.log('Triggering alerts:', alertMessage);

            // Send email alert — iterates over all ALERT_EMAILS addresses
            mailer.sendAlert('Sensor Alarm Alert', alertMessage);

            // Push notification to all subscribed Android/Chrome devices
            webpush.sendPushToAll('Home Check Alert', alertMessage);
        }

        // Broadcast to SSE clients with current Firestore PIR state
        if (typeof broadcastFn === 'function') {
            broadcastFn({ ...data, pir_enabled: pirEnabled });
        }

        // If the device's local state diverges from the global state, piggyback
        // the correction on the response so it takes effect immediately instead
        // of waiting for the next 15-minute PIR command poll.
        // pir_command_ts is the server-side Unix timestamp of this decision so
        // the device can store it as pirUpdatedAt and stay clock-aligned for
        // future pir_state_ts comparisons.
        const response = needsPirSync
            ? { success: true, pir_command: pirEnabled, pir_command_ts: pirCommandTs }
            : { success: true };
        res.status(200).json(response);

    } catch (error) {
        // Log the full error server-side; never expose internals to the client
        console.error('Error processing sensor data:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Export both the router and the setBroadcast injector
// index.js calls setBroadcast() after creating the broadcast function
module.exports = { router, setBroadcast };
