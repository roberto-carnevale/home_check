// esp32-sensor.ino
// Main sketch for ESP32 sensor project.
// Handles WiFi, time sync, scheduling, and JSON assembly.

#include <Arduino.h>
#include <WiFi.h>
#include "time.h"
#include <ArduinoJson.h>

// Include custom headers
#include "config.h"
#include "SensorManager.h"
#include "HttpClient.h"

// NTP server for time synchronization
const char* ntpServer = "pool.ntp.org";
// No timezone offset needed since we want UTC timestamps
const long  gmtOffset_sec = 0;
// No daylight savings adjustment for strict UNIX timestamps
const int   daylightOffset_sec = 0;

// Global instances for sensor and HTTP clients
SensorManager* sensorMgr;
HttpClient* httpClient;


// Variables to track scheduling without using blocking delays
unsigned long lastSampleTime = 0;
unsigned long lastReportTime = 0;

// Track button state and last press time for manual test triggers with lockout
int lastButtonState = HIGH;
unsigned long lastButtonPressTime = 0;
const unsigned long BUTTON_LOCKOUT_MS = 2000UL; // 2 seconds lockout to prevent bouncing

// Function to connect or reconnect to WiFi
void connectWiFi() {
    // Only connect if not already connected
    if (WiFi.status() != WL_CONNECTED) {
        Serial.print("[WIFI] Connecting to ");
        Serial.println(WIFI_SSID);

        // Start connection process
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        
        // Wait until connected, printing dots
        while (WiFi.status() != WL_CONNECTED) {
            delay(500);
            Serial.print(".");
        }
        
        // Connection successful, print IP address
        Serial.println("\n[WIFI] Connected.");
        Serial.print("[WIFI] IP address: ");
        Serial.println(WiFi.localIP());
    }
}

// Function to synchronize system time via NTP
void syncTime() {
    Serial.println("[WIFI] Syncing time via NTP...");
    // Configure time library with NTP server
    configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
    
    // Struct to hold time info
    struct tm timeinfo;
    // Wait until time is obtained
    if (!getLocalTime(&timeinfo)) {
        Serial.println("[WIFI] Failed to obtain time");
        return;
    }
    Serial.println("[WIFI] Time synchronized successfully.");
}

// Helper to get current UNIX timestamp (seconds since epoch)
unsigned long getTimestamp() {
    time_t now;
    // Fetch time from system
    time(&now);
    return (unsigned long)now;
}

// Helper function to bundle, sign and send the sensor report
void sendReport(unsigned long ts) {
    if (sensorMgr->hasEnoughData()) {
        Serial.println("[HTTP] Preparing report...");
        
        // Get aggregated statistics
        AllStats stats = sensorMgr->getStats();

        // Create JSON document.
        // A larger buffer prevents serialization truncation if the payload grows
        // with additional fields or longer device identifiers.
        StaticJsonDocument<1024> doc;
        
        // Add basic device info
        doc["device_id"] = DEVICE_ID;
        doc["timestamp"] = ts;
        // Add reporting window in minutes
        doc["window_minutes"] = ROLLING_WINDOW;
        // Add motion detection alarm status
        bool motionFlag = sensorMgr->isMotionDetected();
        doc["motion_detected"] = motionFlag;
        if (motionFlag) {
            Serial.printf("[PIR] Motion event reported for device %s at timestamp %lu\n", DEVICE_ID, ts);
        }

        // Add temperature statistics object
        JsonObject tempObj = doc.createNestedObject("temperature");
        tempObj["min"] = stats.temp.min;
        tempObj["max"] = stats.temp.max;
        tempObj["avg"] = stats.temp.avg;

        // Add humidity statistics object
        JsonObject humObj = doc.createNestedObject("humidity");
        humObj["min"] = stats.humidity.min;
        humObj["max"] = stats.humidity.max;
        humObj["avg"] = stats.humidity.avg;

        // Add light statistics object
        JsonObject lightObj = doc.createNestedObject("light_raw");
        lightObj["min"] = stats.light.min;
        lightObj["max"] = stats.light.max;
        lightObj["avg"] = stats.light.avg;

        // Serialize JSON to string
        String jsonBody;
        serializeJson(doc, jsonBody);
        
        Serial.print("[HTTP] Payload: ");
        Serial.println(jsonBody);

        // POST JSON to server
        if (httpClient->postJson(jsonBody, ts)) {
            Serial.println("[HTTP] Report sent successfully.");
            sensorMgr->clearMotionFlag(); // Reset the sticky flag
        } else {
            Serial.println("[HTTP] Failed to send report.");
        }
    } else {
        Serial.println("[HTTP] Not enough data to report.");
    }
}

// Standard Arduino setup function
void setup() {
    // Initialize serial monitor for debugging
    Serial.begin(115200);
    delay(1000); // Give serial time to stabilize
    
    Serial.println("\n[SENSOR] Starting ESP32 Sensor Node...");

    // Configure mode switch pin and read it first to select WiFi + server
    pinMode(MODE_SWITCH_PIN, INPUT_PULLUP);
    delay(10); // let pull-up settle

    const char* host;
    uint16_t port;
    const char* caCert;

    if (digitalRead(MODE_SWITCH_PIN) == HIGH) {
        // Pin floating/HIGH → remote Cloud Run server
        host = SERVER_HOST_REMOTE;
        port = SERVER_PORT_REMOTE;
        caCert = ROOT_CA_CERT;
        Serial.println("[MODE] REMOTE server selected (GPIO19 HIGH)");
    } else {
        // Pin tied to GND → local development server
        host = SERVER_HOST_LOCAL;
        port = SERVER_PORT_LOCAL;
        caCert = nullptr;  // no TLS for local
        Serial.println("[MODE] LOCAL server selected (GPIO19 GND)");
    }

    Serial.print("[HTTP] Target: ");
    Serial.print(host);
    Serial.print(":");
    Serial.print(port);
    Serial.println(SERVER_PATH);

    // Connect to the selected WiFi network
    connectWiFi();

    // Synchronize time for HMAC signatures
    syncTime();

    // Configure the manual test button pin using internal pull-up
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // Instantiate SensorManager with config values
    sensorMgr = new SensorManager(DHT_PIN, LDR_PIN, PIR_PIN, ROLLING_WINDOW);
    // Initialize sensor hardware
    sensorMgr->begin();

    // Instantiate HttpClient with selected server
    httpClient = new HttpClient(host, port, SERVER_PATH, HMAC_SECRET, caCert);
}

// Standard Arduino loop function
void loop() {
    // Fetch current millis for scheduling
    unsigned long currentMillis = millis();

    // Reconnect to WiFi if connection is lost
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WIFI] Connection lost. Reconnecting...");
        connectWiFi();
    }

    // Check if it's time to take a new sensor sample
    if (currentMillis - lastSampleTime >= SAMPLE_INTERVAL_MS || lastSampleTime == 0) {
        lastSampleTime = currentMillis;
        Serial.println("[SENSOR] Taking sample...");
        
        // Read from sensors and store in circular buffer
        if (sensorMgr->takeSample()) {
            Serial.println("[SENSOR] Sample successful.");
        } else {
            Serial.println("[SENSOR] Sample failed.");
        }
    }

    // Check manual test button state (active low)
    int buttonState = digitalRead(BUTTON_PIN);
    
    // Check if we are outside the 2-second lockout/standby period
    if (currentMillis - lastButtonPressTime >= BUTTON_LOCKOUT_MS) {
        // Detect falling edge (transition from HIGH to LOW)
        if (buttonState == LOW && lastButtonState == HIGH) {
            Serial.println("[SENSOR] Manual test button pressed! Triggering report...");
            
            // Record current time to initiate the 2-second standby lockout
            lastButtonPressTime = currentMillis;
            
            // Force a sample so we have data if empty
            sensorMgr->takeSample();
            
            // Send report immediately
            unsigned long ts = getTimestamp();
            sendReport(ts);
            
            // Reset the report scheduling timer to avoid duplicate reports
            lastReportTime = currentMillis;
        }
        // Only update the last state when outside of lockout to prevent bounce transitions from registering
        lastButtonState = buttonState;
    } else {
        // During the lockout standby period, keep the last state aligned to prevent edge trigger issues after lockout ends
        lastButtonState = buttonState;
    }

    // Convert report interval from minutes to milliseconds
    unsigned long reportIntervalMs = REPORT_INTERVAL_MIN * 60 * 1000UL;

    // Check if it's time to report data to the server
    if (currentMillis - lastReportTime >= reportIntervalMs && lastReportTime != 0) {
        lastReportTime = currentMillis;
        
        // Send scheduled report
        unsigned long ts = getTimestamp();
        sendReport(ts);
    } else if (lastReportTime == 0) {
        // Initialize report time on first loop iteration
        lastReportTime = currentMillis;
    }
}
