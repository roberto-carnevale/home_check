// esp32-sensor.ino
// Main sketch for ESP32 sensor project.
// Handles WiFi, time sync, scheduling, and JSON assembly.

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <ArduinoOTA.h>
#include "time.h"
#include <ArduinoJson.h>

// Include custom headers
#include "config.h"
#include "TelnetLogger.h"
#include "SensorManager.h"
#include "HttpClient.h"
#include "DisplayManager.h"

// NTP server for time synchronization
const char* ntpServer = "pool.ntp.org";
// No timezone offset needed since we want UTC timestamps
const long  gmtOffset_sec = 0;
// No daylight savings adjustment for strict UNIX timestamps
const int   daylightOffset_sec = 0;

// Global instances for sensor, HTTP and display
SensorManager* sensorMgr;
HttpClient* httpClient;
DisplayManager* displayMgr;


// Variables to track scheduling without using blocking delays
unsigned long lastSampleTime = 0;
unsigned long lastPirSampleTime = 0;
unsigned long lastPirReportTime = 0;
unsigned long lastReportTime = 0;
unsigned long lastPirCommandPollTime = 0;
unsigned long lastPirPresenceMs = 0;  // millis() of last PIR HIGH reading (alarm-off display hold)
const unsigned long PIR_REPORT_COOLDOWN_MS = 5UL * 60UL * 1000UL;

// Track button state and last press time for manual test triggers with lockout
int lastButtonState = HIGH;
unsigned long lastButtonPressTime = 0;
const unsigned long BUTTON_LOCKOUT_MS = 2000UL; // 2 seconds lockout to prevent bouncing

// Track PIR toggle button state and runtime enable/disable state
int lastToggleButtonState = LOW;
unsigned long lastToggleButtonPressTime = 0;
const unsigned long PIR_TOGGLE_LOCKOUT_MS = 250UL;
bool pirEnabled = false;
unsigned long pirUpdatedAt = 0; // Unix timestamp of last PIR toggle (physical or server)

// WiFi and NTP state. Both are retried from loop() rather than blocking setup,
// so the node still samples and responds to its buttons while offline.
bool timeSynced = false;
unsigned long lastWifiAttemptTime = 0;
unsigned long lastTimeSyncAttempt = 0;

// Translates a wl_status_t value into the reason the connection is failing,
// so the cause is visible without guessing from a row of dots.
const char* wifiStatusText(int status) {
    switch (status) {
        case WL_NO_SSID_AVAIL:   return "SSID not found (wrong name, or 5 GHz-only network)";
        case WL_CONNECT_FAILED:  return "connection refused (wrong password)";
        case WL_CONNECTION_LOST: return "connection lost";
        case WL_DISCONNECTED:    return "disconnected (router not responding yet)";
        case WL_IDLE_STATUS:     return "idle";
        default:                 return "unknown";
    }
}

// Connects or reconnects to WiFi, giving up after WIFI_CONNECT_TIMEOUT_MS.
// Returns true when connected. This must never block indefinitely: loop()
// calls it too, and an unattended node has to keep sampling and stay
// responsive to its buttons even while the network is down.
bool connectWiFi() {
    // Nothing to do if the link is already up
    if (WiFi.status() == WL_CONNECTED) {
        return true;
    }

    Log.print("[WIFI] Connecting to ");
    Log.println(WIFI_SSID);

    // Force station mode and drop any stale association: the ESP32 keeps
    // credentials in NVS and can otherwise keep retrying an old one.
    WiFi.mode(WIFI_STA);
    WiFi.disconnect(true);
    delay(100);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    // Wait for the link, printing dots, but only up to the timeout
    unsigned long startedAt = millis();
    while (WiFi.status() != WL_CONNECTED &&
           millis() - startedAt < WIFI_CONNECT_TIMEOUT_MS) {
        delay(500);
        Log.print(".");
    }
    Log.println();

    if (WiFi.status() != WL_CONNECTED) {
        Log.printf("[WIFI] Failed after %lus, status %d (%s)\n",
                      WIFI_CONNECT_TIMEOUT_MS / 1000,
                      WiFi.status(), wifiStatusText(WiFi.status()));
        return false;
    }

    // Connection successful, print IP address
    Log.println("[WIFI] Connected.");
    Log.print("[WIFI] IP address: ");
    Log.println(WiFi.localIP());
    return true;
}

// Function to synchronize system time via NTP.
// Returns true on success. The HMAC signature carries a timestamp the server
// checks for freshness, so an unsynced clock makes every report be rejected.
bool syncTime() {
    Log.println("[WIFI] Syncing time via NTP...");
    // Configure time library with NTP server
    configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);

    // Struct to hold time info
    struct tm timeinfo;
    // Wait until time is obtained
    if (!getLocalTime(&timeinfo)) {
        Log.println("[WIFI] Failed to obtain time");
        return false;
    }
    Log.println("[WIFI] Time synchronized successfully.");
    return true;
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
        Log.println("[HTTP] Preparing report...");
        
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
            Log.printf("[PIR] Motion event reported for device %s at timestamp %lu\n", DEVICE_ID, ts);
        }

        // Report current local alarm state AND the Unix timestamp of the last
        // intentional state change (button press or applied remote command).
        // The server compares pir_state_ts vs dashboard_updated_at to decide
        // which source is authoritative — data-arrival time is never used.
        doc["pir_enabled"]  = pirEnabled;
        doc["pir_state_ts"] = pirUpdatedAt;

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

        // Add TVOC statistics object (ppb), but only when the AGS02MA actually
        // answered during this window. The field is optional server-side, so
        // omitting it shows "--" on the dashboard instead of a fake 0 ppb.
        if (stats.tvocValid) {
            JsonObject tvocObj = doc.createNestedObject("tvoc");
            tvocObj["min"] = stats.tvoc.min;
            tvocObj["max"] = stats.tvoc.max;
            tvocObj["avg"] = stats.tvoc.avg;
        }

        // Serialize JSON to string
        String jsonBody;
        serializeJson(doc, jsonBody);
        
        Log.print("[HTTP] Payload: ");
        Log.println(jsonBody);

        String responseBody;
        if (httpClient->postJson(jsonBody, ts, responseBody)) {
            Log.println("[HTTP] Report sent successfully.");
            sensorMgr->clearMotionFlag(); // Reset the sticky flag

            // If the server detected a state divergence it piggybacks a
            // pir_command on the response — apply it immediately so we don't
            // have to wait for the next 15-minute poll.
            StaticJsonDocument<64> respDoc;
            if (deserializeJson(respDoc, responseBody) == DeserializationError::Ok &&
                respDoc["pir_command"].is<bool>()) {
                bool newPirState = respDoc["pir_command"].as<bool>();
                if (newPirState != pirEnabled) {
                    pirEnabled = newPirState;
                    // Use the server-provided command timestamp so our next
                    // pir_state_ts is server-clock-aligned and won't lose a
                    // future comparison against dashboard_updated_at.
                    pirUpdatedAt = respDoc["pir_command_ts"].is<unsigned long>()
                        ? respDoc["pir_command_ts"].as<unsigned long>()
                        : ts;
                    digitalWrite(PIR_LED_PIN, pirEnabled ? HIGH : LOW);
                    if (!pirEnabled) {
                        sensorMgr->clearMotionFlag();
                    } else {
                        lastPirPresenceMs = 0;
                        displayMgr->setActive(false);
                    }
                    Log.printf("[PIR] State synced via data response: %s\n",
                                  pirEnabled ? "enabled" : "disabled");
                }
            }
        } else {
            Log.println("[HTTP] Failed to send report.");
        }
    } else {
        Log.println("[HTTP] Not enough data to report.");
    }
}

// Configures OTA callbacks (called once) and starts the OTA server.
// Safe to call again after a WiFi reconnect — ArduinoOTA re-binds cleanly.
void startOTA() {
    ArduinoOTA.setHostname(OTA_HOSTNAME);
    ArduinoOTA.setPassword(OTA_PASSWORD);

    ArduinoOTA.onStart([]() {
        String type = (ArduinoOTA.getCommand() == U_FLASH) ? "sketch" : "filesystem";
        Log.println("[OTA] Starting update: " + type);
    });
    ArduinoOTA.onEnd([]() {
        Log.println("[OTA] Update complete — rebooting");
    });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        Log.printf("[OTA] Progress: %u%%\r", progress / (total / 100));
    });
    ArduinoOTA.onError([](ota_error_t error) {
        Log.printf("[OTA] Error[%u]: ", error);
        if      (error == OTA_AUTH_ERROR)    Log.println("Auth failed");
        else if (error == OTA_BEGIN_ERROR)   Log.println("Begin failed");
        else if (error == OTA_CONNECT_ERROR) Log.println("Connect failed");
        else if (error == OTA_RECEIVE_ERROR) Log.println("Receive failed");
        else if (error == OTA_END_ERROR)     Log.println("End failed");
    });

    ArduinoOTA.begin();
    Log.printf("[OTA] Ready — hostname: %s\n", OTA_HOSTNAME);
    Log.startServer();
}

// Standard Arduino setup function
void setup() {
    // Initialize serial monitor for debugging
    Log.begin(115200);
    delay(1000); // Give serial time to stabilize
    
    Log.println("\n[SENSOR] Starting ESP32 Sensor Node...");

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
        caCert = nullptr;  // use built-in CA bundle (like a browser)
        Log.println("[MODE] REMOTE server selected (GPIO19 HIGH)");
    } else {
        // Pin tied to GND → local development server
        host = SERVER_HOST_LOCAL;
        port = SERVER_PORT_LOCAL;
        caCert = nullptr;  // use built-in CA bundle
        Log.println("[MODE] LOCAL server selected (GPIO19 GND)");
    }

    Log.print("[HTTP] Target: ");
    Log.print(host);
    Log.print(":");
    Log.print(port);
    Log.println(SERVER_PATH);

    // Connect to the selected WiFi network. A failure here is not fatal:
    // loop() keeps retrying, and the sensors work regardless.
    if (connectWiFi()) {
        // Synchronize time for HMAC signatures
        timeSynced = syncTime();
        // Start OTA server so firmware can be pushed from Arduino IDE over WiFi
        startOTA();
    } else {
        Log.println("[WIFI] Continuing offline; will retry in the main loop.");
    }
    lastWifiAttemptTime = millis();
    lastTimeSyncAttempt = lastWifiAttemptTime;

    // Configure the manual test button pin using internal pull-up
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    pinMode(PIR_TOGGLE_PIN, INPUT_PULLUP);
    pinMode(PIR_LED_PIN, OUTPUT);
    digitalWrite(PIR_LED_PIN, LOW);

    // Instantiate SensorManager with config values
    sensorMgr = new SensorManager(DHT_PIN, LDR_PIN, PIR_PIN, AGS02MA_ADDR, ROLLING_WINDOW);
    // Initialize sensor hardware
    sensorMgr->begin();

    // Instantiate and start the rotating 7-segment display
    displayMgr = new DisplayManager(TM1637_CLK_PIN, TM1637_DIO_PIN, DISPLAY_BRIGHTNESS);
    displayMgr->begin();

    // Instantiate HttpClient with selected server
    httpClient = new HttpClient(host, port, SERVER_PATH, HMAC_SECRET, caCert);
}

// Standard Arduino loop function
void loop() {
    // Fetch current millis for scheduling
    unsigned long currentMillis = millis();

    // Service pending OTA requests. Must run on every loop pass while connected
    // so the IDE can push a new firmware image at any time.
    if (WiFi.status() == WL_CONNECTED) {
        ArduinoOTA.handle();
        Log.handle();
    }

    // Reconnect to WiFi if the link is down, but no more often than
    // WIFI_RETRY_INTERVAL_MS: each attempt costs a blocking timeout, and
    // retrying every pass would starve sampling and the button handling.
    if (WiFi.status() != WL_CONNECTED &&
        currentMillis - lastWifiAttemptTime >= WIFI_RETRY_INTERVAL_MS) {
        lastWifiAttemptTime = currentMillis;
        Log.println("[WIFI] Connection lost. Reconnecting...");
        if (connectWiFi()) {
            // The clock is lost across a long outage, so resync before the
            // next report rather than signing it with a stale timestamp.
            timeSynced = syncTime();
            // Re-register the OTA server after reconnecting
            startOTA();
        }
    }

    // Catch up on a time sync that failed earlier: without it every report
    // would be signed with an epoch timestamp and rejected by the server.
    // Rate-limited because getLocalTime() blocks for seconds when it fails.
    if (!timeSynced && WiFi.status() == WL_CONNECTED &&
        currentMillis - lastTimeSyncAttempt >= WIFI_RETRY_INTERVAL_MS) {
        lastTimeSyncAttempt = currentMillis;
        timeSynced = syncTime();
    }

    // Check if it's time to take a new environmental sensor sample
    if (currentMillis - lastSampleTime >= SAMPLE_INTERVAL_MS || lastSampleTime == 0) {
        lastSampleTime = currentMillis;
        Log.println("[SENSOR] Taking environmental sample...");
        
        // Read from DHT and LDR and store in circular buffer
        if (sensorMgr->takeSample()) {
            Log.println("[SENSOR] Environmental sample successful.");

            // Push the fresh values to the display
            LastReading latest = sensorMgr->getLastReading();
            displayMgr->setReadings(latest.temp, latest.humidity,
                                    latest.tvoc, latest.tvoc >= 0.0f);
        } else {
            Log.println("[SENSOR] Environmental sample failed.");
        }
    }

    // Advance the display rotation; returns immediately when it is not due
    displayMgr->update(currentMillis);

    // Toggle PIR monitoring on/off using GPIO27
    int toggleButtonState = digitalRead(PIR_TOGGLE_PIN);
    if (toggleButtonState == LOW && lastToggleButtonState == HIGH &&
        currentMillis - lastToggleButtonPressTime >= PIR_TOGGLE_LOCKOUT_MS) {
        lastToggleButtonPressTime = currentMillis;
        pirEnabled = !pirEnabled;
        pirUpdatedAt = getTimestamp();
        Log.printf("[PIR] Monitoring %s (physical toggle at %lu)\n", pirEnabled ? "enabled" : "disabled", pirUpdatedAt);
        if (!pirEnabled) {
            digitalWrite(PIR_LED_PIN, LOW);
        } else {
            digitalWrite(PIR_LED_PIN, HIGH);
            lastPirPresenceMs = 0;        // clear hold timer so display stays dark
            displayMgr->setActive(false); // alarm armed: blank the display immediately
        }
    }
    lastToggleButtonState = toggleButtonState;

    // Poll the dashboard command so PIR can also be controlled remotely.
    // Guard with timeSynced: without a valid NTP clock the HMAC timestamp
    // would be near epoch-0 and the server would reject it with 401.
    if (timeSynced && (currentMillis - lastPirCommandPollTime >= PIR_COMMAND_POLL_INTERVAL_MS || lastPirCommandPollTime == 0)) {
        lastPirCommandPollTime = currentMillis;
        bool requestedPirState = pirEnabled;
        unsigned long requestedPirTs = 0;
        if (httpClient->getPirCommand(requestedPirState, requestedPirTs, getTimestamp(), PIR_COMMAND_PATH) &&
            requestedPirTs > pirUpdatedAt && requestedPirState != pirEnabled) {
            pirEnabled = requestedPirState;
            pirUpdatedAt = requestedPirTs;
            digitalWrite(PIR_LED_PIN, pirEnabled ? HIGH : LOW);
            Log.printf("[PIR] Remote monitoring %s (ts %lu)\n", pirEnabled ? "enabled" : "disabled", pirUpdatedAt);
            if (!pirEnabled) {
                sensorMgr->clearMotionFlag();
            } else {
                lastPirPresenceMs = 0;        // clear hold timer so display stays dark
                displayMgr->setActive(false); // alarm armed: blank the display immediately
            }
        }
    }

    // Sample PIR every cycle regardless of alarm state.
    // Used both for the alarm trigger (when armed) and to drive the display.
    if (currentMillis - lastPirSampleTime >= PIR_SAMPLE_INTERVAL_MS || lastPirSampleTime == 0) {
        lastPirSampleTime = currentMillis;
        bool pirPresence = sensorMgr->takePirSample();

        // When alarm is off and PIR fires, refresh the presence timestamp so
        // the display hold timer starts (or extends) from this moment.
        if (!pirEnabled && pirPresence) {
            lastPirPresenceMs = currentMillis;
        }

        // Keep the display on for DISPLAY_PRESENCE_DURATION_MS after the last
        // detected motion. This prevents flicker when the PIR briefly goes LOW
        // between detections. When the alarm is armed the display stays dark.
        bool displayActive = !pirEnabled &&
                             lastPirPresenceMs > 0 &&
                             (currentMillis - lastPirPresenceMs < DISPLAY_PRESENCE_DURATION_MS);
        displayMgr->setActive(displayActive);

        // Alarm trigger: only when the system is armed
        if (pirEnabled && pirPresence &&
            (lastPirReportTime == 0 || currentMillis - lastPirReportTime >= PIR_REPORT_COOLDOWN_MS)) {
            Log.println("[PIR] Triggering immediate report due to active motion.");
            lastPirReportTime = currentMillis;
            unsigned long ts = getTimestamp();
            sendReport(ts);
        }
    }

    // Check manual test button state (active low)
    int buttonState = digitalRead(BUTTON_PIN);
    
    // Check if we are outside the 2-second lockout/standby period
    if (currentMillis - lastButtonPressTime >= BUTTON_LOCKOUT_MS) {
        // Detect falling edge (transition from HIGH to LOW)
        if (buttonState == LOW && lastButtonState == HIGH) {
            Log.println("[SENSOR] Manual test button pressed! Triggering report...");
            
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
