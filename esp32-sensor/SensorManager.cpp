// SensorManager.cpp
// Implementation of the SensorManager class.
// Handles reading from hardware and computing statistics over a circular buffer.

#include "SensorManager.h"
#include "config.h"

// Constructor implementation
// Initializes pins, DHT instance, and dynamically allocates buffers
SensorManager::SensorManager(uint8_t dhtPin, uint8_t ldrPin, uint8_t pirPin, uint8_t windowSize)
    : _dhtPin(dhtPin), _ldrPin(ldrPin), _pirPin(pirPin), _windowSize(windowSize),
      _dht(dhtPin, DHT_TYPE), _headIndex(0), _count(0), _motionDetected(false) {
          
    // Allocate memory for temperature samples
    _tempBuffer = new float[_windowSize];
    // Allocate memory for humidity samples
    _humidityBuffer = new float[_windowSize];
    // Allocate memory for light samples
    _lightBuffer = new float[_windowSize];
    
    // Initialize buffers to zero for safety
    for(uint8_t i = 0; i < _windowSize; ++i) {
        _tempBuffer[i] = 0.0f;
        _humidityBuffer[i] = 0.0f;
        _lightBuffer[i] = 0.0f;
    }
}

// Destructor implementation
// Frees dynamically allocated arrays to prevent memory leaks
SensorManager::~SensorManager() {
    delete[] _tempBuffer;
    delete[] _humidityBuffer;
    delete[] _lightBuffer;
}

// begin() implementation
// Starts the DHT sensor and configures GPIOs
void SensorManager::begin() {
    // Start the DHT sensor background processing
    _dht.begin();
    // Configure the SR505 PIR sensor pin as a digital input
    pinMode(_pirPin, INPUT);
    // Allow sensor to stabilize before first reading
    delay(100); 
}

// takeSample() implementation
// Reads from sensors and places data in circular buffers
bool SensorManager::takeSample() {
    // Read humidity as a float
    float h = _dht.readHumidity();
    // Read temperature as Celsius (default)
    float t = _dht.readTemperature();
    // Read light level as raw analog value
    float l = (float)analogRead(_ldrPin);
    // Read digital state of the SR505 PIR motion sensor
    int pirState = digitalRead(_pirPin);

    // If PIR pin reads HIGH, motion is detected. Keep it sticky until reported.
    if (pirState == HIGH) {
        _motionDetected = true;
        Serial.println("[SENSOR] Motion detected!");
    }

    // Check if DHT readings are valid numbers (not NaN)
    if (isnan(h) || isnan(t)) {
        // Log failure if DHT read failed
        Serial.println("[SENSOR] Failed to read from DHT sensor!");
        return false;
    }

    // Insert new data at the current head index
    _tempBuffer[_headIndex] = t;
    _humidityBuffer[_headIndex] = h;
    _lightBuffer[_headIndex] = l;

    // Advance head index circularly
    _headIndex = (_headIndex + 1) % _windowSize;

    // Increment count up to window size (caps at capacity)
    if (_count < _windowSize) {
        _count++;
    }

    // Print sampled values to Serial Monitor
    Serial.printf("[SENSOR] Temp: %.1f°C | Humidity: %.1f%% | Light: %.0f | PIR: %s\n",
                  t, h, l, pirState == HIGH ? "ACTIVE" : "idle");

    // Successfully took a sample
    return true;
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
        return stats;
    }

    // Initialize min/max with the first valid entry (index 0)
    // We compute over all stored elements up to _count
    float sumT = 0, minT = _tempBuffer[0], maxT = _tempBuffer[0];
    float sumH = 0, minH = _humidityBuffer[0], maxH = _humidityBuffer[0];
    float sumL = 0, minL = _lightBuffer[0], maxL = _lightBuffer[0];

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
    }

    // Assign final calculated values to stats structures
    stats.temp = {minT, maxT, sumT / _count};
    stats.humidity = {minH, maxH, sumH / _count};
    stats.light = {minL, maxL, sumL / _count};

    return stats;
}
