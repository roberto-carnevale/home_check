// Import the Firestore class from the Google Cloud SDK
// This is the official client library for Cloud Firestore
const { Firestore } = require('@google-cloud/firestore');

// Initialize the Firestore client instance
// It automatically picks up GOOGLE_APPLICATION_CREDENTIALS from the environment
// or uses Application Default Credentials when running in Cloud Run
const db = new Firestore();

// Export the Firestore service module
// This encapsulates all database operations
module.exports = {
    async saveLoginChallenge(challenge) {
        await db.collection('auth_challenges').doc('dashboard').set(challenge);
    },

    async getLoginChallenge() {
        const doc = await db.collection('auth_challenges').doc('dashboard').get();
        return doc.exists ? doc.data() : null;
    },

    async clearLoginChallenge() {
        await db.collection('auth_challenges').doc('dashboard').delete();
    },

    // Retrieve the desired PIR state for the sensor node.
    async getPirCommand() {
        const doc = await db.collection('device_commands').doc('pir').get();
        return doc.exists ? doc.data() : { enabled: false };
    },

    // Persist the desired PIR state from the dashboard.
    // Records dashboard_enabled/dashboard_updated_at and recomputes the global state.
    // Dashboard always wins because the user just clicked — it is the most recent source.
    async setPirCommand(enabled) {
        const now = Firestore.Timestamp.now();
        const command = {
            enabled,
            updated_at: now,
            dashboard_enabled: enabled,
            dashboard_updated_at: now,
        };
        await db.collection('device_commands').doc('pir').set(command, { merge: true });
        return command;
    },

    // Called when the ESP32 reports its local PIR state via POST /api/data.
    // Sequence:
    //   1. Read dashboard state from Firestore.
    //   2. Compare esp32StateTsSecs (pirUpdatedAt — when the button was pressed
    //      or the last remote command was applied on the device) against
    //      dashboard_updated_at (when the dashboard toggle was last clicked).
    //      Both are Unix seconds; both originate from server-aligned clocks
    //      (NTP on ESP32, Firestore server time on dashboard).
    //   3. Latest timestamp wins; dashboard wins on a tie or when esp32StateTsSecs
    //      is 0 (device just booted and has never intentionally changed state).
    //   4. Persist esp32 fields and the resolved global state.
    //   5. Return { globalEnabled, needsSync, commandTs } so the route can
    //      piggyback a correction + its server-side timestamp on the response,
    //      letting the device align its clock reference for future comparisons.
    async syncEsp32PirState(esp32Enabled, esp32StateTsSecs) {
        const ref = db.collection('device_commands').doc('pir');
        const snap = await ref.get();
        const stored = snap.exists ? snap.data() : {};

        const dashboardTs = stored.dashboard_updated_at
            ? (stored.dashboard_updated_at.seconds ?? stored.dashboard_updated_at._seconds ?? 0)
            : 0;

        // esp32StateTsSecs is pirUpdatedAt: the Unix timestamp of the last
        // intentional state change on the device (button press or applied sync).
        // 0 means the device just booted and has never changed state → dashboard wins.
        const esp32Ts = esp32StateTsSecs || 0;

        // Latest intentional-change timestamp wins; dashboard wins on tie or boot.
        const globalEnabled = esp32Ts > dashboardTs
            ? esp32Enabled
            : (stored.dashboard_enabled !== undefined ? stored.dashboard_enabled : esp32Enabled);

        const now = Firestore.Timestamp.now();
        await ref.set({
            esp32_enabled: esp32Enabled,
            esp32_updated_at: Firestore.Timestamp.fromMillis(esp32Ts * 1000),
            enabled: globalEnabled,
            updated_at: now,
        }, { merge: true });

        const commandTs = now.seconds ?? now._seconds ?? Math.floor(Date.now() / 1000);
        return { globalEnabled, needsSync: esp32Enabled !== globalEnabled, commandTs };
    },

    // Function to save a new sensor reading
    // It takes the parsed JSON data as input
    async saveReading(data) {
        // Reference the 'readings' collection in Firestore
        // This is where all historical sensor payloads live
        const collection = db.collection('readings');

        // Add the new document with a server-side timestamp
        // FieldValue.serverTimestamp() ensures the time is recorded accurately by Google's servers
        await collection.add({
            ...data,
            serverTimestamp: Firestore.FieldValue.serverTimestamp()
        });
        console.log('Reading saved to Firestore successfully.');
    },

    // Function to retrieve the latest sensor reading
    // Useful for initial dashboard load
    async getLatestReading() {
        // Query the 'readings' collection, ordering by timestamp descending
        // We limit to 1 to just get the most recent document
        const snapshot = await db.collection('readings')
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        // If the collection is empty, return null
        // This prevents errors on fresh deployments
        if (snapshot.empty) {
            return null;
        }

        // Extract and return the data from the first (and only) document
        // We use .data() to get the actual JavaScript object
        return snapshot.docs[0].data();
    },

    // Function to retrieve the current watchdog alert state
    // This allows Cloud Run instances to avoid duplicate notification floods
    async getWatchdogStatus() {
        const doc = await db.collection('watchdog_status').doc('current').get();
        return doc.exists ? doc.data() : null;
    },

    // Function to persist the last alerted reading timestamp
    // This prevents repeat alerts for the same stale reading.
    async setWatchdogStatus(status) {
        await db.collection('watchdog_status').doc('current').set(status);
    },

    // Function to save a new web push subscription
    // This takes the subscription object provided by the browser
    async saveSubscription(subscription) {
        // Reference the 'subscriptions' collection
        // We use the subscription endpoint as the document ID to prevent duplicates
        const collection = db.collection('subscriptions');

        // Query to see if this endpoint already exists
        // This avoids storing duplicate subscriptions for the same browser
        const existing = await collection.where('endpoint', '==', subscription.endpoint).get();

        // If the subscription doesn't exist, add it
        // Otherwise, we do nothing to save space
        if (existing.empty) {
            await collection.add(subscription);
            console.log('New web push subscription saved.');
        } else {
            console.log('Subscription already exists, skipping.');
        }
    },

    // Function to retrieve all active web push subscriptions
    // This is used when broadcasting an alert to all devices
    async getAllSubscriptions() {
        // Fetch all documents from the 'subscriptions' collection
        // In a massive app, you'd want to paginate this, but it's fine for home use
        const snapshot = await db.collection('subscriptions').get();

        // Map the query snapshot to an array of subscription objects
        // We also include the document ID so we can delete invalid ones later
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    },

    // Function to delete a subscription by its document ID
    // We use this to clean up expired or revoked push subscriptions
    async deleteSubscription(id) {
        // Reference the specific document and delete it
        // This keeps our database clean and prevents sending errors
        await db.collection('subscriptions').doc(id).delete();
        console.log(`Deleted invalid subscription: ${id}`);
    },

    // Function to retrieve the latest 48 hours of sensor readings
    // Ordered ascending by timestamp so they chart chronologically
    async get48HoursHistory() {
        // Calculate timestamp threshold in UNIX epoch seconds
        const fortyEightHoursAgo = Math.floor(Date.now() / 1000) - (48 * 60 * 60);

        // Firestore does not always have the composite index needed for the
        // timestamp ordering query on the free-tier project. Fetch a reasonable
        // window without ordering first, then sort in memory to keep the UI working.
        const snapshot = await db.collection('readings')
            .where('timestamp', '>=', fortyEightHoursAgo)
            .get();

        return snapshot.docs
            .map(doc => doc.data())
            .sort((a, b) => a.timestamp - b.timestamp);
    },

    // Function to retrieve the latest 10 PIR motion sensor events
    // Ordered descending by timestamp to show the most recent first
    async getLatest10PirEvents() {
        // Firestore can reject the composite index query here as well, so we
        // fetch recent matching docs and sort in memory instead.
        const snapshot = await db.collection('readings')
            .where('motion_detected', '==', true)
            .get();

        return snapshot.docs
            .map(doc => {
                const data = doc.data();
                return {
                    device_id: data.device_id,
                    timestamp: data.timestamp,
                    temperature_avg: data.temperature.avg,
                    humidity_avg: data.humidity.avg
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 10);
    },

    // Function to delete readings older than 48 hours
    // Run when the watchdog fires to keep only the dashboard retention window
    async deleteReadingsOlderThan48Hours() {
        const fortyEightHoursAgo = Math.floor(Date.now() / 1000) - (48 * 60 * 60);

        const snapshot = await db.collection('readings')
            .where('timestamp', '<', fortyEightHoursAgo)
            .get();

        if (snapshot.empty) {
            return;
        }

        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });

        await batch.commit();
        console.log(`Pruned ${snapshot.size} readings older than 48 hours.`);
    }
};
