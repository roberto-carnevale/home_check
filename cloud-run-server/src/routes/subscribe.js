// Import the express router
// This allows us to define the subscription endpoint modularly
const router = require('express').Router();

// Import the firestore service
// We need this to persist the push subscription objects
const firestore = require('../services/firestore');

// Define the POST endpoint for new web push subscriptions
// This is called by the frontend PWA when a user opts in
router.post('/', async (req, res) => {
    try {
        // Extract the subscription object from the request body
        // The browser's push manager generates this object
        const subscription = req.body;

        // Validate the basic structure of the subscription object
        // It must have an endpoint URL and the necessary encryption keys
        if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.auth || !subscription.keys.p256dh) {
            console.warn('Invalid subscription object received');
            return res.status(400).json({ error: 'Invalid subscription object' });
        }

        // Save the validated subscription object to Firestore
        // We store it so we can push notifications to it later
        await firestore.saveSubscription(subscription);

        // Respond with a 201 Created status
        // This confirms to the client that they are successfully subscribed
        res.status(201).json({ success: true });
    } catch (error) {
        // Log any errors that occur during the database operation
        // This could happen due to network issues or missing permissions
        console.error('Error saving subscription:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Export the router so it can be mounted in index.js
// Modularity keeps the codebase maintainable
module.exports = router;
