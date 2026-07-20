// Import the Express framework and supertest
// We use these to build a mock server for testing the middleware
const express = require('express');
const request = require('supertest');

// Import the validation middleware
// This contains the Joi schema logic we want to test
const validateMiddleware = require('../src/middleware/validate');

// Set up a simple Express application
// We mount the JSON parser, the validator, and a dummy success handler
const app = express();
app.use(express.json());
app.post('/test', validateMiddleware, (req, res) => res.status(200).send('OK'));

// Define the test suite for Payload Validation
// This groups all schema tests together
describe('Validation Middleware', () => {

    // Test case: A perfectly valid payload should pass
    it('should pass with a valid payload', async () => {
        // Construct a payload that exactly matches the expected Joi schema
        const validPayload = {
            device_id: "esp32-home-01",
            timestamp: 1721308800,
            window_minutes: 30,
            temperature: { min: 20, max: 25, avg: 22.5 },
            humidity: { min: 40, max: 50, avg: 45 },
            light_raw: { min: 100, max: 200, avg: 150 }
        };

        // Send the request to the mock server
        const res = await request(app).post('/test').send(validPayload);

        // We expect the middleware to call next(), resulting in a 200 OK
        expect(res.status).toBe(200);
    });

    // Test case: Missing a required field should fail
    it('should fail if a required field is missing', async () => {
        // Construct a payload but omit the required "humidity" field entirely
        const invalidPayload = {
            device_id: "esp32-home-01",
            timestamp: 1721308800,
            window_minutes: 30,
            temperature: { min: 20, max: 25, avg: 22.5 },
            // missing humidity
            light_raw: { min: 100, max: 200, avg: 150 }
        };

        // Send the bad request to the server
        const res = await request(app).post('/test').send(invalidPayload);

        // We expect a 400 Bad Request status code due to validation failure
        expect(res.status).toBe(400);
        // We also verify that the error response contains the Joi details
        expect(res.body).toHaveProperty('errors');
    });

    // Test case: Wrong data type should fail
    it('should fail if data types are incorrect', async () => {
        // Construct a payload where the timestamp is a string instead of a number
        const invalidPayload = {
            device_id: "esp32-home-01",
            timestamp: "this_is_not_a_number",
            window_minutes: 30,
            temperature: { min: 20, max: 25, avg: 22.5 },
            humidity: { min: 40, max: 50, avg: 45 },
            light_raw: { min: 100, max: 200, avg: 150 }
        };

        // Send the bad request
        const res = await request(app).post('/test').send(invalidPayload);

        // Expect validation to catch the type mismatch and return 400
        expect(res.status).toBe(400);
    });
});
