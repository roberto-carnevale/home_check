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

        // Resolve PIR state FIRST: compare timestamps from the physical button
        // and the dashboard. The most recent toggle wins.
        let pirCommand = await firestore.getPirCommand().catch(() => ({ enabled: false }));
        if (typeof data.pir_enabled === 'boolean' && typeof data.pir_updated_at === 'number') {
            const fsSeconds = pirCommand.updatedAt
                ? (pirCommand.updatedAt.seconds || Math.floor(pirCommand.updatedAt._seconds || 0))
                : 0;
            if (data.pir_updated_at > fsSeconds) {
                pirCommand = await firestore.setPirCommand(data.pir_enabled);
            }
        }

        const pirEnabled = pirCommand.enabled === true;
        const pirUpdatedAt = pirCommand.updatedAt
            ? (pirCommand.updatedAt.seconds || pirCommand.updatedAt._seconds || 0)
            : 0;

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
            
            if (!pirEnabled && data.pir_enabled === true) {
                // The hardware triggered and thought it was armed, but the dashboard
                // recently disabled it. The hardware just hasn't polled the new state yet.
                // Send the welcome email, but NO intrusion push notification.
                mailer.sendAlert('Welcome Home', 'The PIR sensor see you entering, shuting down the alarm. Welcome home');
            } else if (pirEnabled) {
                // System is actually armed
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

        // Broadcast to SSE clients with the winning PIR state
        if (typeof broadcastFn === 'function') {
            broadcastFn({ ...data, pir_enabled: pirEnabled });
        }

        res.status(200).json({ success: true, pir_enabled: pirEnabled, pir_updated_at: pirUpdatedAt });

    } catch (error) {
        // Log the full error server-side; never expose internals to the client
        console.error('Error processing sensor data:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Export both the router and the setBroadcast injector
// index.js calls setBroadcast() after creating the broadcast function
module.exports = { router, setBroadcast };
