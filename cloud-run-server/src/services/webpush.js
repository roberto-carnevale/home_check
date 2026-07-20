// Import the web-push library
// This module handles encrypting and sending VAPID-compliant push messages
const webpush = require('web-push');

// Import our Firestore service
// We need this to retrieve subscriptions and delete invalid ones
const firestore = require('./firestore');

// Initialize web-push with our VAPID details
// These keys authenticate our server to the push services (e.g. Mozilla/Google)
// The subject is usually a mailto: link for the server admin
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
} else {
    console.warn('VAPID keys not set. Web push notifications will not work.');
}

// Export the webpush service module
// This provides a clean interface for broadcasting push notifications
module.exports = {
    // Function to send a push notification to all subscribers
    // It takes a title and a body string for the notification payload
    async sendPushToAll(title, body) {
        try {
            // Fetch all active subscriptions from Firestore
            // We need the entire object including keys to encrypt the payload
            const subscriptions = await firestore.getAllSubscriptions();

            // If there are no subscribers, exit early
            // This saves processing time and prevents empty loops
            if (subscriptions.length === 0) {
                console.log('No push subscriptions found. Skipping push alerts.');
                return;
            }

            // Construct the payload as a JSON string
            // The service worker on the client side will parse this and show the UI
            const payload = JSON.stringify({ title, body });

            // Iterate over all subscriptions and attempt to send the push
            // We use Promise.allSettled to ensure all attempts finish, even if some fail
            const promises = subscriptions.map(async (sub) => {
                try {
                    // Send the notification using the web-push library
                    // We strip the 'id' field because web-push expects a clean subscription object
                    const { id, ...cleanSub } = sub;
                    await webpush.sendNotification(cleanSub, payload);
                    console.log(`Push sent successfully to endpoint: ${cleanSub.endpoint}`);
                } catch (err) {
                    // If sending fails, we check the HTTP status code
                    // A 410 or 404 indicates the subscription is no longer valid
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        console.log(`Subscription expired/invalid. Deleting: ${sub.id}`);
                        // Delete the dead subscription from Firestore to keep the DB clean
                        await firestore.deleteSubscription(sub.id);
                    } else {
                        // Log other unexpected errors (e.g., network issues)
                        console.error('Failed to send push notification:', err);
                    }
                }
            });

            // Wait for all push notification attempts to resolve
            // This ensures our asynchronous operations don't leak
            await Promise.allSettled(promises);
        } catch (error) {
            // Catch any high-level errors (like failing to fetch subscriptions)
            // We swallow the error so the main server execution is not interrupted
            console.error('Error in sendPushToAll:', error);
        }
    }
};
