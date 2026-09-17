// DisplayManager.h
// Drives a 4-digit TM1637 7-segment module, cycling through the sensor
// readings one screen at a time.

#ifndef DISPLAY_MANAGER_H
#define DISPLAY_MANAGER_H

#include <Arduino.h>
// TM1637 4-digit display library (avishorp)
#include <TM1637Display.h>

class DisplayManager {
public:
    // clkPin / dioPin are the module's CLK and DIO lines.
    // brightness runs from 0 (dimmest) to 7 (brightest).
    DisplayManager(uint8_t clkPin, uint8_t dioPin, uint8_t brightness);

    // Powers up the display and shows a placeholder until data arrives
    void begin();

    // Stores the values the next screens will show. Called after each sample.
    // tvocPpb is ignored unless tvocValid is true.
    void setReadings(float temperature, float humidity, float tvocPpb, bool tvocValid);

    // Advances to the next screen once the rotation interval has elapsed.
    // Call this on every loop() pass; it returns immediately when idle.
    void update(unsigned long nowMs);

private:
    TM1637Display _display;
    uint8_t _brightness;

    // Latest values to display
    float _temperature;
    float _humidity;
    float _tvoc;
    bool _tvocValid;
    bool _hasData;

    uint8_t _screen;              // 0 = temperature, 1 = humidity, 2 = air quality
    unsigned long _lastRotateMs;

    // Renders the screen selected by _screen
    void renderCurrentScreen();

    void renderTemperature();
    void renderHumidity();
    void renderAirQuality();
};

#endif // DISPLAY_MANAGER_H
