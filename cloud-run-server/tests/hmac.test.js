// Import necessary testing libraries and functions
// We use supertest to simulate HTTP requests without starting a real server
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

// Import the HMAC middleware we want to test
// This allows us to test it in isolation
const hmacMiddleware = require('../src/middleware/hmac');

// Create a mock Express app for testing purposes
// We only mount the middleware and a simple success route
const app = express();
app.use(express.json());
app.post('/test', hmacMiddleware, (req, res) => res.status(200).send('OK'));

// Define the test suite for the HMAC middleware
// This groups all related tests together
describe('HMAC Middleware', () => {
    // Set up the environment variables before running the tests
    // We define a test secret key to compute valid signatures
    beforeAll(() => {
        process.env.HMAC_SECRET_KEY = 'test_secret';
    });

    // Test case: Valid signature and timestamp should pass
    it('should pass with valid signature and timestamp', async () => {
        // Define the test payload
        const payload = { test: 'data' };
        const timestamp = Math.floor(Date.now() / 1000);

        // Compute the correct signature the same way the ESP32 would
        const bodyHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const stringToSign = `${timestamp}.${bodyHash}`;
        const signature = crypto.createHmac('sha256', 'test_secret').update(stringToSign).digest('hex');

        // Send the request and expect a 200 OK status
        const res = await request(app)
            .post('/test')
            .set('x-timestamp', timestamp.toString())
            .set('x-signature', signature)
            .send(payload);

        expect(res.status).toBe(200);
    });

    // Test case: Missing headers should fail
    it('should fail if headers are missing', async () => {
        // Send the request without any custom headers
        const res = await request(app)
            .post('/test')
            .send({ test: 'data' });

        // Expect a 401 Unauthorized status
        expect(res.status).toBe(401);
    });

    // Test case: Wrong secret key should fail
    it('should fail with incorrect signature', async () => {
        const payload = { test: 'data' };
        const timestamp = Math.floor(Date.now() / 1000);

        // Send random gibberish as the signature
        const res = await request(app)
            .post('/test')
            .set('x-timestamp', timestamp.toString())
            .set('x-signature', 'invalid_signature_hex')
            .send(payload);

        // Expect a 401 Unauthorized status
        expect(res.status).toBe(401);
    });

    // Test case: Expired timestamp should fail (Replay attack protection)
    it('should fail if timestamp is too old', async () => {
        const payload = { test: 'data' };
        // Subtract 400 seconds to make it older than the 300s max age
        const timestamp = Math.floor(Date.now() / 1000) - 400;

        // Compute a mathematically correct signature for the old timestamp
        const bodyHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const stringToSign = `${timestamp}.${bodyHash}`;
        const signature = crypto.createHmac('sha256', 'test_secret').update(stringToSign).digest('hex');

        // The middleware should reject it because it's too old
        const res = await request(app)
            .post('/test')
            .set('x-timestamp', timestamp.toString())
            .set('x-signature', signature)
            .send(payload);

        // Expect a 401 Unauthorized status
        expect(res.status).toBe(401);
    });
});
