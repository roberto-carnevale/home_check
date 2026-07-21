// SensorManager.h
// Header file for managing the DHT22 and LDR sensors.
// Provides a circular buffer to compute rolling statistics.

#ifndef SENSOR_MANAGER_H
#define SENSOR_MANAGER_H

#include <Arduino.h>
// DHT sensor library (Adafruit)
#include <DHT.h>

// Structure to hold min, max, and avg for a single metric
struct SensorStats {
    float min;
    float max;
    float avg;
};

// Structure to hold all statistics plus sample count
struct AllStats {
    SensorStats temp;
    SensorStats humidity;
    SensorStats light;
    uint8_t sampleCount;
};

// The SensorManager class handles sampling and data aggregation
class SensorManager {
public:
    // Constructor initializes pins and window size
    // windowSize determines the capacity of the circular buffer
    SensorManager(uint8_t dhtPin, uint8_t ldrPin, uint8_t pirPin, uint8_t windowSize);
    
    // Destructor to clean up dynamically allocated memory
    ~SensorManager();

    // Initializes the hardware sensors
    void begin();

    // Takes a sample from the environmental sensors (DHT and LDR)
    // Returns true on success, false if the DHT read fails
    bool takeSample();

    // Takes a sample from the PIR motion sensor and returns true when motion is active
    bool takePirSample();

    // Calculates and returns rolling statistics over the window
    AllStats getStats() const;

    // Checks if we have at least one valid sample in the buffer
    bool hasEnoughData() const;

    // Returns if motion was detected since the last reset
    bool isMotionDetected() const;

    // Resets the motion detected flag
    void clearMotionFlag();

private:
    uint8_t _dhtPin;     // DHT sensor data pin
    uint8_t _ldrPin;     // LDR analog input pin
    uint8_t _pirPin;     // PIR digital input pin
    uint8_t _windowSize; // Maximum number of samples to store

    DHT _dht; // Adafruit DHT instance

    // Pointers to dynamically allocated circular buffers
    float* _tempBuffer;
    float* _humidityBuffer;
    float* _lightBuffer;

    uint8_t _headIndex;    // Current index to insert new sample
    uint8_t _count;        // Total number of valid samples stored
    volatile bool _motionDetected; // Tracks if motion was detected since last reset
};

#endif // SENSOR_MANAGER_H
