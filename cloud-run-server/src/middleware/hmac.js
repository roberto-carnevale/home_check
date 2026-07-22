// Import the built-in crypto module
// This is required to compute SHA256 hashes and HMACs
const crypto = require('crypto');

// Define the maximum allowed age for a request
// 300 seconds (5 minutes) provides a good balance between clock drift and replay protection
// Can be overridden via HMAC_MAX_AGE_SECONDS env var for local testing with clock drift
const MAX_AGE_SECONDS = parseInt(process.env.HMAC_MAX_AGE_SECONDS, 10) || 300;

// Export the HMAC middleware function
// This function acts as an Express middleware, intercepting the request
module.exports = function verifyHMAC(req, res, next) {
    // Retrieve the signature and timestamp from the headers
    // These are sent by the ESP32 sensor
    const signature = req.headers['x-signature'];
    const timestampStr = req.headers['x-timestamp'];

    // Ensure both headers are present
    // If either is missing, we immediately reject the request
    if (!signature || !timestampStr) {
        console.error('Missing HMAC headers');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Parse the timestamp into an integer
    // The timestamp should be in Unix epoch seconds
    const timestamp = parseInt(timestampStr, 10);

    // Check if the timestamp is a valid number
    // This prevents NaN errors down the line
    if (isNaN(timestamp)) {
        console.error('Invalid timestamp format');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Calculate the current time in seconds
    // Math.floor converts milliseconds to seconds
    const now = Math.floor(Date.now() / 1000);

    // Check the absolute difference between now and the timestamp
    // This prevents replay attacks with old payloads
    if (Math.abs(now - timestamp) > MAX_AGE_SECONDS) {
        console.error(`Timestamp out of bounds. Now: ${now}, TS: ${timestamp}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Use the raw body bytes the client actually sent (preserved by the verify
    // callback in express.json). This avoids re-serialization differences such as
    // float formatting (e.g. 25.50 → 25.5) that would break the hash.
    // Falls back to JSON.stringify for tests or if rawBody is unavailable.
    const bodyString = req.rawBody || (req.body === undefined ? '' : JSON.stringify(req.body));

    // Compute the SHA256 hash of the body
    // This ensures the body hasn't been tampered with
    const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');

    // Construct the string to be signed
    // We concatenate the timestamp and the body hash with a dot
    const stringToSign = `${timestamp}.${bodyHash}`;

    // Retrieve the secret key from environment variables
    // This key must match the one flashed on the ESP32
    const secret = process.env.HMAC_SECRET_KEY;

    if (!secret) {
        console.error('HMAC secret key is not set in environment variables');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    // Compute the expected HMAC-SHA256 signature
    // We use the secret to sign the stringToSign, outputting as hex
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(stringToSign)
        .digest('hex');

    // Strip the "sha256=" prefix if present (ESP32 sends "sha256=<hex>")
    const rawSignature = signature.startsWith('sha256=') ? signature.slice(7) : signature;

    // Convert both signatures to Buffer for constant-time comparison
    // This is crucial to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const actualBuffer = Buffer.from(rawSignature, 'hex');

    // Check if the lengths match before comparing
    // timingSafeEqual throws if lengths are different
    if (expectedBuffer.length !== actualBuffer.length) {
        console.error('Signature length mismatch');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Perform a constant-time comparison of the signatures
    // If they match, the request is authentic
    if (!crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
        console.error('HMAC signature verification failed');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // If everything is valid, proceed to the next middleware
    // This allows the request to reach the actual route handler
    next();
};
