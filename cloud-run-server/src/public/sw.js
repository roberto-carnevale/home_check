// Listen for the 'push' event
// This event is fired when the browser receives a web push notification from the server
self.addEventListener('push', function(event) {
    // Initialize default title and body
    // These act as fallbacks if the payload parsing fails
    let title = 'Home Check Alert';
    let body = 'You have a new alert from your home sensors.';

    // Check if the event contains payload data
    // If data is present, we parse it as JSON
    if (event.data) {
        try {
            // Parse the JSON string sent by the webpush service
            // This gives us the customized title and body
            const data = event.data.json();
            title = data.title || title;
            body = data.body || body;
        } catch (err) {
            // Catch JSON parsing errors
            // If the payload was plain text, we use it directly as the body
            console.error('Error parsing push data', err);
            body = event.data.text();
        }
    }

    // Define the notification options
    // We set the body text and an icon if desired
    const options = {
        body: body,
        // You can add icon, badge, and vibration patterns here
        // icon: '/icon.png'
    };

    // Instruct the Service Worker to show the notification
    // The event.waitUntil ensures the SW stays active until the notification is displayed
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// Listen for the 'notificationclick' event
// This handles user interactions when they click the notification popup
self.addEventListener('notificationclick', function(event) {
    // Close the notification immediately
    // This provides a responsive feel to the user
    event.notification.close();

    // Instruct the Service Worker to open the dashboard URL
    // We open the root path '/' so the user can see the latest sensor data
    event.waitUntil(
        clients.openWindow('/')
    );
});
