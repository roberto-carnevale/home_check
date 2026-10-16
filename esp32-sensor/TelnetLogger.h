// TelnetLogger.h
// Mirrors every Serial write to a single Telnet client on the local network,
// so the serial monitor is accessible over WiFi without a USB cable.
//
// Usage:
//   Connect:  telnet <ESP32-IP> 23
//   Use Log.printf / Log.println / Log.print everywhere instead of Serial.

#ifndef TELNET_LOGGER_H
#define TELNET_LOGGER_H

#include <Arduino.h>
#include <WiFiServer.h>
#include <WiFiClient.h>

class TelnetLogger : public Print {
public:
    explicit TelnetLogger(uint16_t port = 23);

    // Start the hardware UART — call once in setup() instead of Serial.begin()
    void begin(unsigned long baud);

    // Start the Telnet server — call after WiFi is connected (and on reconnect)
    void startServer();

    // Accept new clients and drop disconnected ones — call every loop()
    void handle();

    // Read one complete line from Serial or Telnet (non-blocking).
    // Returns the trimmed, lower-case command string, or "" if no line is ready yet.
    String readCommand();

    // printf-style formatting (Print base class does not provide this)
    int printf(const char *format, ...) __attribute__((format(printf, 2, 3)));

    // Core Print overrides — all print/println variants are derived from these
    size_t write(uint8_t c) override;
    size_t write(const uint8_t *buf, size_t size) override;

private:
    uint16_t   _port;
    WiFiServer _server;
    WiFiClient _client;
    bool       _serverStarted;

    // Line-accumulation buffers for non-blocking command reading
    String _serialBuf;
    String _telnetBuf;
};

// Global instance — include this header and use Log.printf() / Log.println()
extern TelnetLogger Log;

#endif // TELNET_LOGGER_H
