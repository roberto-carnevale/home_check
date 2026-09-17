// SensorManager.cpp
// Implementation of the SensorManager class.
// Handles reading from hardware and computing statistics over a circular buffer.

#include "SensorManager.h"
#include "config.h"

// Constructor implementation
// Initializes pins, DHT instance, and dynamically allocates buffers
SensorManager::SensorManager(uint8_t dhtPin, uint8_t ldrPin, uint8_t pirPin, uint8_t tvocAddr, uint8_t windowSize)
    : _dhtPin(dhtPin), _ldrPin(ldrPin), _pirPin(pirPin), _tvocAddr(tvocAddr), _windowSize(windowSize),
      _dht(dhtPin, DHT_TYPE), _tvocReady(false),
      _last{0.0f, 0.0f, 0.0f, -1.0f, false},
      _headIndex(0), _count(0), _motionDetected(false) {

    // Allocate memory for temperature samples
    _tempBuffer = new float[_windowSize];
    // Allocate memory for humidity samples
    _humidityBuffer = new float[_windowSize];
    // Allocate memory for light samples
    _lightBuffer = new float[_windowSize];
    // Allocate memory for TVOC samples
    _tvocBuffer = new float[_windowSize];

    // Initialize buffers to zero for safety
    for(uint8_t i = 0; i < _windowSize; ++i) {
        _tempBuffer[i] = 0.0f;
        _humidityBuffer[i] = 0.0f;
        _lightBuffer[i] = 0.0f;
        _tvocBuffer[i] = 0.0f;
    }
}

// Destructor implementation
// Frees dynamically allocated arrays to prevent memory leaks
SensorManager::~SensorManager() {
    delete[] _tempBuffer;
    delete[] _humidityBuffer;
    delete[] _lightBuffer;
    delete[] _tvocBuffer;
}

// begin() implementation
// Starts the DHT sensor and configures GPIOs
void SensorManager::begin() {
    // Start the DHT sensor background processing
    _dht.begin();
    // Configure the SR505 PIR sensor pin as a digital input
    pinMode(_pirPin, INPUT);
    // Initialize the I2C bus on the configured pins. The AGS02MA library sets
    // its own (slow) clock on top of this, so no setClock() call here.
    Wire.begin(TVOC_SDA_PIN, TVOC_SCL_PIN);

    // Give the AGS02MA time to come up before talking to it: it is slow to
    // boot and will not answer immediately after power is applied.
    delay(200);

    // Hand the sensor over to the Adafruit driver, which owns the 20 kHz bus
    // speed, the inter-command delays and the CRC checking.
    _tvocReady = _ags.begin(&Wire, _tvocAddr);
    if (!_tvocReady) {
        Serial.printf("[TVOC] AGS02MA init FAILED at 0x%02X (check SDA=%d, SCL=%d, power)\n",
                      _tvocAddr, TVOC_SDA_PIN, TVOC_SCL_PIN);
        // Scan the whole bus: this separates "nothing is wired up" (no devices
        // at all -> power or SDA/SCL problem) from "the sensor is there but at
        // a different address" (some AGS02MA batches ship re-addressed).
        scanI2CBus();
    } else {
        // begin() only proves the address ACKs, which a miswired sensor can
        // still do. Reading the firmware version exercises a full
        // command/response cycle and is the check that actually catches it.
        uint32_t fw = _ags.getFirmwareVersion();
        if (fw == 0) {
            Serial.printf("[TVOC] AGS02MA answers at 0x%02X but register reads fail "
                          "(firmware version 0)\n", _tvocAddr);
            Serial.println("[TVOC] Wiring fault, not a config one: verify GND goes to "
                           "GND and VCC to 3.3V, then check the 10k pull-ups on SDA/SCL.");
        } else {
            Serial.printf("[TVOC] AGS02MA initialised at 0x%02X, firmware 0x%08X\n",
                          _tvocAddr, (unsigned)fw);
        }
    }

    // Allow sensors to stabilize before first reading
    delay(100);
}

// takeSample() implementation
// Reads environmental sensors and places data in circular buffers
bool SensorManager::takeSample() {
    // Read humidity as a float
    float h = _dht.readHumidity();
    // Read temperature as Celsius (default)
    float t = _dht.readTemperature();
    // Read light level as raw analog value
    float l = (float)analogRead(_ldrPin);

    // Check if DHT readings are valid numbers (not NaN)
    if (isnan(h) || isnan(t)) {
        // Log failure if DHT read failed
        Serial.println("[SENSOR] Failed to read from DHT sensor!");
        return false;
    }

    // Read TVOC from AGS02MA over I2C. A failed read is stored as -1 so that
    // getStats() can skip it: reporting 0 ppb would look like perfectly clean
    // air and hide the fault.
    int32_t tvocRaw = readTvocPpb();
    float tvoc = (tvocRaw >= 0) ? (float)tvocRaw : -1.0f;

    // Insert new data at the current head index
    _tempBuffer[_headIndex] = t;
    _humidityBuffer[_headIndex] = h;
    _lightBuffer[_headIndex] = l;
    _tvocBuffer[_headIndex] = tvoc;

    // Keep the raw sample for the display
    _last = {t, h, l, tvoc, true};

    // Advance head index circularly
    _headIndex = (_headIndex + 1) % _windowSize;

    // Increment count up to window size (caps at capacity)
    if (_count < _windowSize) {
        _count++;
    }

    // Print sampled values to Serial Monitor
    if (tvoc >= 0.0f) {
        Serial.printf("[SENSOR] Temp: %.1f°C | Humidity: %.1f%% | Light: %.0f | TVOC: %.0f ppb\n",
                      t, h, l, tvoc);
    } else {
        Serial.printf("[SENSOR] Temp: %.1f°C | Humidity: %.1f%% | Light: %.0f | TVOC: n/a\n",
                      t, h, l);
    }

    // Successfully took a sample
    return true;
}

// takePirSample() implementation
// Reads the PIR sensor state and marks motion when triggered
bool SensorManager::takePirSample() {
    int pirState = digitalRead(_pirPin);

    // If PIR pin reads HIGH, motion is detected. Keep it sticky until reported.
    if (pirState == HIGH) {
        _motionDetected = true;
        Serial.println("[SENSOR] Motion detected!");
        return true;
    }

    return false;
}

// Returns if motion was detected since the last reset
bool SensorManager::isMotionDetected() const {
    return _motionDetected;
}

// Resets the motion detected flag
void SensorManager::clearMotionFlag() {
    _motionDetected = false;
}

// hasEnoughData() implementation
// Returns true if buffer has at least 1 reading
bool SensorManager::hasEnoughData() const {
    return _count > 0;
}

// getLastReading() implementation
// Returns the most recent raw sample for the live display
LastReading SensorManager::getLastReading() const {
    return _last;
}

// getStats() implementation
// Iterates over valid data to compute min, max, and avg
AllStats SensorManager::getStats() const {
    AllStats stats;
    // Zero out count if empty
    stats.sampleCount = _count;
    
    // If no data, return zeroes
    if (_count == 0) {
        stats.temp = {0, 0, 0};
        stats.humidity = {0, 0, 0};
        stats.light = {0, 0, 0};
        stats.tvoc = {0, 0, 0};
        stats.tvocValid = false;
        return stats;
    }

    // Initialize min/max with the first valid entry (index 0)
    // We compute over all stored elements up to _count
    float sumT = 0, minT = _tempBuffer[0], maxT = _tempBuffer[0];
    float sumH = 0, minH = _humidityBuffer[0], maxH = _humidityBuffer[0];
    float sumL = 0, minL = _lightBuffer[0], maxL = _lightBuffer[0];

    // TVOC is tracked separately: failed I2C reads are stored as -1 and must be
    // excluded, so this series can have fewer samples than the others.
    float sumV = 0, minV = 0, maxV = 0;
    uint8_t countV = 0;

    // Loop through all valid samples in the buffer
    for (uint8_t i = 0; i < _count; i++) {
        // Accumulate sums for average calculation
        sumT += _tempBuffer[i];
        sumH += _humidityBuffer[i];
        sumL += _lightBuffer[i];

        // Update temperature min and max
        if (_tempBuffer[i] < minT) minT = _tempBuffer[i];
        if (_tempBuffer[i] > maxT) maxT = _tempBuffer[i];

        // Update humidity min and max
        if (_humidityBuffer[i] < minH) minH = _humidityBuffer[i];
        if (_humidityBuffer[i] > maxH) maxH = _humidityBuffer[i];

        // Update light min and max
        if (_lightBuffer[i] < minL) minL = _lightBuffer[i];
        if (_lightBuffer[i] > maxL) maxL = _lightBuffer[i];

        // Accumulate TVOC only for samples that were read successfully
        if (_tvocBuffer[i] >= 0.0f) {
            if (countV == 0) {
                minV = maxV = _tvocBuffer[i];
            } else {
                if (_tvocBuffer[i] < minV) minV = _tvocBuffer[i];
                if (_tvocBuffer[i] > maxV) maxV = _tvocBuffer[i];
            }
            sumV += _tvocBuffer[i];
            countV++;
        }
    }

    // Assign final calculated values to stats structures
    stats.temp = {minT, maxT, sumT / _count};
    stats.humidity = {minH, maxH, sumH / _count};
    stats.light = {minL, maxL, sumL / _count};

    // Only report TVOC if at least one read in the window succeeded
    stats.tvocValid = (countV > 0);
    stats.tvoc = stats.tvocValid ? SensorStats{minV, maxV, sumV / countV}
                                 : SensorStats{0, 0, 0};

    return stats;
}

// Scans the I2C bus and prints every address that ACKs.
// Only called when the AGS02MA fails to answer, as a wiring diagnostic.
void SensorManager::scanI2CBus() {
    Serial.println("[TVOC] Scanning I2C bus...");
    uint8_t found = 0;

    // 0x00-0x07 and 0x78-0x7F are reserved addresses, so skip them
    for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("[TVOC]   device found at 0x%02X\n", addr);
            found++;
        }
    }

    if (found == 0) {
        Serial.println("[TVOC]   no I2C devices at all: check 3.3V, GND, "
                       "SDA/SCL not swapped, and the 10k pull-ups to 3.3V");
    } else {
        Serial.printf("[TVOC]   %u device(s) on the bus but none at 0x%02X: "
                      "update AGS02MA_ADDR in config.h\n", found, _tvocAddr);
    }
}

// Reads TVOC concentration in ppb from the AGS02MA.
// Returns -1 when the reading could not be obtained.
int32_t SensorManager::readTvocPpb() {
    // Nothing to read if the sensor never initialised: retrying every cycle
    // would just spam the log with the same failure.
    if (!_tvocReady) {
        return -1;
    }

    // The sensor refuses commands issued while it is still converting, so a
    // single failure is not conclusive: retry a few times before giving up.
    for (uint8_t attempt = 0; attempt < TVOC_READ_ATTEMPTS; attempt++) {
        // Let the sensor settle between attempts; it only refreshes its
        // measurement every ~1.5s and rejects commands sent faster than that.
        if (attempt > 0) {
            delay(TVOC_RETRY_DELAY_MS);
        }

        uint32_t tvoc = _ags.getTVOC();

        // The library reports a failed read as 0, which it cannot distinguish
        // from a genuine zero. Real indoor air is never at exactly 0 ppb, so
        // treat 0 as a failed read rather than reporting implausibly clean air.
        if (tvoc > 0) {
            return (int32_t)tvoc;
        }
    }

    Serial.printf("[TVOC] No valid reading after %d attempts\n", TVOC_READ_ATTEMPTS);
    return -1;
}
