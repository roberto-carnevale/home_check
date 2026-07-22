// Import the Joi validation library
// Joi provides a powerful schema description language and data validator
const Joi = require('joi');

// Define the schema for the sensor data payload
// This ensures we only accept data in the exact format we expect
const schema = Joi.object({
    // The device ID must be a non-empty string
    // This identifies which sensor sent the data
    device_id: Joi.string().required(),

    // The timestamp must be a valid integer
    // This is the Unix timestamp from the sensor's RTC
    timestamp: Joi.number().integer().required(),

    // The aggregation window in minutes
    // This tells us the period the min/max/avg cover
    window_minutes: Joi.number().integer().required(),

    // Temperature object containing min, max, and avg
    // All values must be numbers
    temperature: Joi.object({
        min: Joi.number().required(),
        max: Joi.number().required(),
        avg: Joi.number().required()
    }).required(),

    // Humidity object containing min, max, and avg
    // All values must be numbers
    humidity: Joi.object({
        min: Joi.number().required(),
        max: Joi.number().required(),
        avg: Joi.number().required()
    }).required(),

    // Raw light sensor reading object
    // These are raw ADC units, so they are typically integers
    light_raw: Joi.object({
        min: Joi.number().required(),
        max: Joi.number().required(),
        avg: Joi.number().required()
    }).required(),

    // Optional motion detection flag from SR505 PIR sensor
    motion_detected: Joi.boolean().optional(),

    // Optional effective PIR monitoring state reported by the device
    pir_enabled: Joi.boolean().optional(),

    // Unix timestamp (seconds) of the last physical PIR button toggle
    pir_updated_at: Joi.number().integer().optional()
});

// Export the validation middleware function
// This intercepts requests to validate the body against the schema
module.exports = function validatePayload(req, res, next) {
    // Validate the request body against our predefined schema
    // abortEarly: false ensures we get all validation errors, not just the first
    const { error } = schema.validate(req.body, { abortEarly: false });

    // If validation fails, return a 400 Bad Request
    // We map over the error details to provide a clean array of messages
    if (error) {
        const errorMessages = error.details.map(detail => detail.message);
        console.error('Validation errors:', errorMessages);
        return res.status(400).json({ errors: errorMessages });
    }

    // If validation succeeds, move to the next middleware
    // The data is now guaranteed to match our schema
    next();
};
