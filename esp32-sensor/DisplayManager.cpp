// DisplayManager.cpp
// Implementation of the rotating 7-segment display.

#include "DisplayManager.h"
#include "config.h"

// Segment patterns for the characters the library cannot encode itself.
// Bit order is SEG_A..SEG_G, so each constant is just the set of lit segments.
static const uint8_t CHAR_BLANK  = 0x00;
static const uint8_t CHAR_MINUS  = SEG_G;                            // -
static const uint8_t CHAR_DEGREE = SEG_A | SEG_B | SEG_F | SEG_G;    // °
static const uint8_t CHAR_C      = SEG_A | SEG_D | SEG_E | SEG_F;    // C
static const uint8_t CHAR_R      = SEG_E | SEG_G;                    // r
static const uint8_t CHAR_H      = SEG_C | SEG_E | SEG_F | SEG_G;    // h
static const uint8_t CHAR_B      = SEG_F | SEG_G | SEG_E | SEG_D | SEG_C;    // b
static const uint8_t CHAR_L      = SEG_E | SEG_F;                    // l
static const uint8_t CHAR_O      = SEG_C | SEG_D | SEG_E | SEG_G;    // o

// Number of screens in the rotation
static const uint8_t SCREEN_COUNT = 3;

DisplayManager::DisplayManager(uint8_t clkPin, uint8_t dioPin, uint8_t brightness)
    : _display(clkPin, dioPin), _brightness(brightness),
      _temperature(0.0f), _humidity(0.0f), _tvoc(-1.0f),
      _tvocValid(false), _hasData(false),
      _screen(0), _lastRotateMs(0) {
}

void DisplayManager::begin() {
    _display.setBrightness(_brightness);

    // Placeholder until the first sample lands, so a blank display is never
    // mistaken for a dead module
    const uint8_t waiting[] = { CHAR_MINUS, CHAR_MINUS, CHAR_MINUS, CHAR_MINUS };
    _display.setSegments(waiting);
}

void DisplayManager::setReadings(float temperature, float humidity, float tvocPpb, bool tvocValid) {
    _temperature = temperature;
    _humidity = humidity;
    _tvoc = tvocPpb;
    _tvocValid = tvocValid;

    // Redraw straight away rather than waiting for the next rotation tick, so
    // a fresh sample is visible as soon as it is taken
    bool firstData = !_hasData;
    _hasData = true;
    if (firstData) {
        _screen = 0;
    }
    renderCurrentScreen();
}

void DisplayManager::update(unsigned long nowMs) {
    // Nothing to rotate through until the first sample arrives
    if (!_hasData) {
        return;
    }

    if (nowMs - _lastRotateMs < DISPLAY_ROTATE_INTERVAL_MS) {
        return;
    }
    _lastRotateMs = nowMs;

    _screen = (_screen + 1) % SCREEN_COUNT;
    renderCurrentScreen();
}

void DisplayManager::renderCurrentScreen() {
    switch (_screen) {
        case 0: renderTemperature(); break;
        case 1: renderHumidity();    break;
        default: renderAirQuality(); break;
    }
}

// Temperature as two digits followed by the degree symbol and C, e.g. "26°C".
// Negative values use the first position for the minus sign, e.g. "-5°C".
void DisplayManager::renderTemperature() {
    int value = (int)lroundf(_temperature);

    // Two digit positions only: clamp rather than render a misleading number
    if (value > 99)  value = 99;
    if (value < -9)  value = -9;

    uint8_t segments[4];
    if (value < 0) {
        segments[0] = CHAR_MINUS;
        segments[1] = _display.encodeDigit(-value);
    } else if (value < 10) {
        // Leading blank reads better than a leading zero
        segments[0] = CHAR_BLANK;
        segments[1] = _display.encodeDigit(value);
    } else {
        segments[0] = _display.encodeDigit(value / 10);
        segments[1] = _display.encodeDigit(value % 10);
    }
    segments[2] = CHAR_DEGREE;
    segments[3] = CHAR_C;

    _display.setSegments(segments);
}

// Relative humidity as two digits followed by "rh", e.g. "54rh".
void DisplayManager::renderHumidity() {
    int value = (int)lroundf(_humidity);

    // Only two digit positions, so 100% shows as 99
    if (value > 99) value = 99;
    if (value < 0)  value = 0;

    uint8_t segments[4];
    if (value < 10) {
        segments[0] = CHAR_BLANK;
        segments[1] = _display.encodeDigit(value);
    } else {
        segments[0] = _display.encodeDigit(value / 10);
        segments[1] = _display.encodeDigit(value % 10);
    }
    segments[2] = CHAR_R;
    segments[3] = CHAR_H;

    _display.setSegments(segments);
}

// Air quality as up to three digits followed by "q", e.g. "100q".
// Above 999 ppb the value no longer fits, so the screen reads "lo q"
// (low quality). An unavailable reading shows "-- q" instead, which must not
// be confused with genuinely bad air.
void DisplayManager::renderAirQuality() {
    uint8_t segments[4];
    segments[3] = CHAR_B;

    if (!_tvocValid || _tvoc < 0.0f) {
        segments[0] = CHAR_MINUS;
        segments[1] = CHAR_MINUS;
        segments[2] = CHAR_BLANK;
        _display.setSegments(segments);
        return;
    }

    long value = lroundf(_tvoc);

    if (value > DISPLAY_TVOC_MAX_PPB) {
        segments[0] = CHAR_L;
        segments[1] = CHAR_O;
        segments[2] = CHAR_BLANK;
        _display.setSegments(segments);
        return;
    }

    if (value < 0) value = 0;

    // Right-aligned across the three digit positions, blanking leading zeros
    if (value >= 100) {
        segments[0] = _display.encodeDigit((value / 100) % 10);
        segments[1] = _display.encodeDigit((value / 10) % 10);
    } else if (value >= 10) {
        segments[0] = CHAR_BLANK;
        segments[1] = _display.encodeDigit((value / 10) % 10);
    } else {
        segments[0] = CHAR_BLANK;
        segments[1] = CHAR_BLANK;
    }
    segments[2] = _display.encodeDigit(value % 10);

    _display.setSegments(segments);
}
