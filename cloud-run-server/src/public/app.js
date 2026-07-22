// --- VAPID Public Key ---
// This value is loaded from the server at runtime when the user subscribes.
let PUBLIC_VAPID_KEY = '';

// Array to store active PIR events locally
let activePirEvents = [];
let pirEnabled = false;

function updatePirButton() {
    const button = document.getElementById('pirToggleBtn');
    if (!button) return;

    button.textContent = pirEnabled ? 'Deactivate PIR' : 'Activate PIR';
    button.setAttribute('aria-pressed', String(pirEnabled));
}

async function loadPirState() {
    try {
        const response = await fetch('/api/pir');
        if (!response.ok) throw new Error('Failed to load PIR state');
        const state = await response.json();
        pirEnabled = state.enabled === true;
        updatePirButton();
    } catch (error) {
        console.error('Error loading PIR state:', error);
    }
}

const loadPushConfig = async () => {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) {
            console.warn('Failed to load push config');
            return;
        }

        const config = await response.json();
        PUBLIC_VAPID_KEY = config.publicVapidKey || '';
    } catch (err) {
        console.warn('Error loading push config:', err);
    }
};

loadPushConfig();
loadPirState();

// Utility function to convert the base64 VAPID key to a Uint8Array
// The push manager requires the applicationServerKey to be in this format
function urlBase64ToUint8Array(base64String) {
    // Pad the string with equals signs to make its length a multiple of 4
    // This fixes base64url encoding for standard base64 decoding
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    // Decode the base64 string into raw binary data
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    // Copy each character's char code into the typed array
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// --- Chart Setup ---
// We define common configuration options for all our Chart.js instances
// This ensures a consistent look and feel across the dashboard
const HOUR_MS = 60 * 60 * 1000;
const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;

const formatHourLabel = (timestamp) => new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
});

const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 }, // Disable animation for snappy live updates
    scales: {
        x: {
            type: 'linear',
            min: Date.now() - HISTORY_WINDOW_MS,
            max: Date.now(),
            ticks: {
                color: '#94a3b8',
                stepSize: HOUR_MS,
                callback: (value) => formatHourLabel(value)
            },
            grid: { color: '#334155' }
        },
        y: {
            // Ensure the Y axis scales properly with grid lines
            // We style the grid lines to match our dark theme
            grid: { color: '#334155' },
            ticks: { color: '#94a3b8' }
        }
    },
    plugins: {
        // Hide the legend since the card title already explains the metric
        legend: { display: false }
    }
};

// Helper to create a new Chart instance
// It takes a canvas context, a line color, and an initial dataset
const createChart = (ctx, color) => new Chart(ctx, {
    type: 'line',
    data: {
        datasets: [{
            data: [], // Actual sensor data points with x/y coordinates
            borderColor: color, // The line color
            backgroundColor: color + '33', // The fill color (with transparency)
            fill: true, // Fill the area under the line
            tension: 0.4, // Add some curve to the lines
            pointRadius: 2 // Make the data points small
        }]
    },
    // Spread the common options defined above
    options: { ...commonOptions }
});

// Initialize the three charts on their respective canvas elements
// We use different accent colors for visual distinction
const tempChart = createChart(document.getElementById('tempChart').getContext('2d'), '#ef4444'); // Red for temp
const humidityChart = createChart(document.getElementById('humidityChart').getContext('2d'), '#3b82f6'); // Blue for humidity
const lightChart = createChart(document.getElementById('lightChart').getContext('2d'), '#f59e0b'); // Amber for light

// Maximum number of data points to keep in the chart for scrolling
// 576 points corresponds to 48 hours of 5-minute interval data
const MAX_POINTS = 600;

// Helper function to update a specific chart with a new data point
// It pushes the new value and shifts old values out if necessary
const updateChart = (chart, timestamp, value) => {
    chart.data.datasets[0].data.push({ x: timestamp, y: value });

    // If we exceed MAX_POINTS, remove the oldest data point
    // This creates a scrolling effect over time
    if (chart.data.datasets[0].data.length > MAX_POINTS) {
        chart.data.datasets[0].data.shift();
    }

    chart.options.scales.x.min = Date.now() - HISTORY_WINDOW_MS;
    chart.options.scales.x.max = Date.now();

    // Tell Chart.js to re-render with the new data
    chart.update();
};

// --- Render PIR Log Events ---
function renderPirEvents(events) {
    const list = document.getElementById('pirEventList');
    if (!list) return;

    if (events.length === 0) {
        list.innerHTML = `<li class="event-item" style="justify-content: center; color: var(--text-muted);">No motion events logged in the last 48 hours</li>`;
        return;
    }

    list.innerHTML = events.map(event => {
        const timeStr = new Date(event.timestamp * 1000).toLocaleString();
        return `
            <li class="event-item">
                <div>
                    <span class="event-time">${timeStr}</span>
                </div>
                <span class="event-status">MOTION</span>
            </li>
        `;
    }).join('');
}

// --- Fetch History & Initialize charts/list ---
async function fetchAndInitData() {
    try {
        const response = await fetch('/api/history');
        if (!response.ok) throw new Error('Failed to load history');
        
        const data = await response.json();
        
        // Populate historical readings into the charts
        if (data.history && data.history.length > 0) {
            data.history.forEach(reading => {
                const timestamp = reading.timestamp * 1000;

                // Add points chronologically
                tempChart.data.datasets[0].data.push({ x: timestamp, y: reading.temperature.avg });
                humidityChart.data.datasets[0].data.push({ x: timestamp, y: reading.humidity.avg });
                lightChart.data.datasets[0].data.push({ x: timestamp, y: reading.light_raw.avg });
            });

            tempChart.options.scales.x.min = Date.now() - HISTORY_WINDOW_MS;
            tempChart.options.scales.x.max = Date.now();
            humidityChart.options.scales.x.min = Date.now() - HISTORY_WINDOW_MS;
            humidityChart.options.scales.x.max = Date.now();
            lightChart.options.scales.x.min = Date.now() - HISTORY_WINDOW_MS;
            lightChart.options.scales.x.max = Date.now();

            // Update charts after bulk inserts
            tempChart.update();
            humidityChart.update();
            lightChart.update();

            // Set last status message to the latest point
            const latest = data.history[data.history.length - 1];
            const timeLabel = new Date(latest.timestamp * 1000).toLocaleTimeString();
            document.getElementById('statusText').innerText =
                `Last updated: ${timeLabel} (from history) | Device: ${latest.device_id}`;
        } else {
            document.getElementById('statusText').innerText = 'No historical data found. Waiting for first message...';
        }

        // Render PIR activation list
        activePirEvents = data.pirEvents || [];
        renderPirEvents(activePirEvents);

    } catch (err) {
        console.error('Error fetching dashboard history:', err);
        document.getElementById('statusText').innerText = 'Error loading history. Waiting for updates...';
    }
}

// Run initial loading sequence
fetchAndInitData();

// --- Server-Sent Events (SSE) Setup ---
// Open a persistent connection to the server's SSE endpoint
// This allows the server to push data to us instantly
const eventSource = new EventSource('/api/sse');

// Listen for incoming messages on the SSE connection
// When the ESP32 posts data to the server, the server broadcasts it here
eventSource.onmessage = (event) => {
    // Parse the incoming JSON string into a JavaScript object
    const data = JSON.parse(event.data);

    // Format the current time as a readable string
    // Example: "14:30:45"
    const timeLabel = new Date().toLocaleTimeString();

    // Update the status text with the device ID and exact time
    // This confirms to the user that the system is alive
    document.getElementById('statusText').innerText =
        `Last updated: ${timeLabel} | Device: ${data.device_id}`;

    // Sync PIR button with Firestore-confirmed state from server
    if (typeof data.pir_enabled === 'boolean') {
        pirEnabled = data.pir_enabled;
        updatePirButton();
    }

    // Update all three charts with the new average values
    // We use the 'avg' property as it's the most stable metric
    const timestamp = data.timestamp * 1000;
    updateChart(tempChart, timestamp, data.temperature.avg);
    updateChart(humidityChart, timestamp, data.humidity.avg);
    updateChart(lightChart, timestamp, data.light_raw.avg);

    // If PIR motion was detected in this reading, dynamically add it to the log list
    if (data.motion_detected === true) {
        const newEvent = {
            device_id: data.device_id,
            timestamp: data.timestamp,
            temperature_avg: data.temperature.avg,
            humidity_avg: data.humidity.avg
        };
        
        // Add to front of local list
        activePirEvents.unshift(newEvent);
        
        // Limit local array to latest 10 events
        if (activePirEvents.length > 10) {
            activePirEvents.pop();
        }
        
        // Re-render the PIR alarms log list
        renderPirEvents(activePirEvents);
    }
};

// Handle potential SSE connection errors
// If the server goes down, the EventSource will automatically try to reconnect
eventSource.onerror = (err) => {
    console.error('SSE Error:', err);
    document.getElementById('statusText').innerText = 'Connection lost. Reconnecting...';
};

document.getElementById('pirToggleBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const nextState = !pirEnabled;
    button.disabled = true;

    try {
        const response = await fetch('/api/pir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: nextState })
        });
        if (!response.ok) throw new Error(`PIR update failed: ${response.status}`);

        pirEnabled = nextState;
        updatePirButton();
        document.getElementById('statusText').innerText =
            `PIR ${pirEnabled ? 'activation' : 'deactivation'} requested. Waiting for device...`;
    } catch (error) {
        console.error('PIR update error:', error);
        alert('Failed to update PIR state.');
    } finally {
        button.disabled = false;
    }
});

// --- Web Push Subscription Logic ---
// Handle the click event on the Subscribe button
document.getElementById('subscribeBtn').addEventListener('click', async () => {
    try {
        // First, check if Service Workers and Push API are supported by this browser
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            alert('Push notifications are not supported in this browser');
            return;
        }

        // Register our Service Worker script (sw.js)
        // The service worker runs in the background and handles incoming pushes
        const register = await navigator.serviceWorker.register('/sw.js');
        console.log('Service Worker registered');

        // Wait for the Service Worker to become fully active
        // We need it ready before we can subscribe to push notifications
        await navigator.serviceWorker.ready;

        // Ask the browser's Push Manager to create a subscription
        // userVisibleOnly ensures we always show a notification when a push arrives
        if (!PUBLIC_VAPID_KEY) {
            throw new Error('Push subscription cannot start because VAPID public key is missing');
        }

        const subscription = await register.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY)
        });

        // Send the resulting subscription object to our Node.js server
        // The server will save it to Firestore for future use
        const subscribeResponse = await fetch('/api/subscribe', {
            method: 'POST',
            body: JSON.stringify(subscription),
            headers: { 'Content-Type': 'application/json' }
        });

        if (!subscribeResponse.ok) {
            const errorBody = await subscribeResponse.text();
            throw new Error(`Subscription save failed: ${subscribeResponse.status} ${errorBody}`);
        }

        // Alert the user that the subscription was successful
        // They will now receive alerts for thresholds and watchdog timeouts
        alert('Subscribed successfully!');
    } catch (error) {
        // Catch and log any errors during the subscription flow
        // This could be due to the user denying permission
        console.error('Subscription error:', error);
        alert('Failed to subscribe.');
    }
});
