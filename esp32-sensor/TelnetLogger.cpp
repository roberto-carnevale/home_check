// TelnetLogger.cpp
// Implementation of TelnetLogger — see TelnetLogger.h for usage.

#include "TelnetLogger.h"
#include <WiFi.h>
#include <stdarg.h>

// Global instance shared across all translation units
TelnetLogger Log;

TelnetLogger::TelnetLogger(uint16_t port)
    : _port(port), _server(port), _serverStarted(false) {}

void TelnetLogger::begin(unsigned long baud) {
    Serial.begin(baud);
}

void TelnetLogger::startServer() {
    _server.begin();
    _server.setNoDelay(true);
    _serverStarted = true;
    // This message intentionally goes to Serial only: the Telnet client is
    // not connected yet, and we want to know the IP from the physical port.
    Serial.printf("[TELNET] Log server on port %u — connect with: telnet %s %u\n",
                  _port, WiFi.localIP().toString().c_str(), _port);
}

void TelnetLogger::handle() {
    if (!_serverStarted) return;

    // Accept an incoming connection if we have none (or the previous one dropped)
    if (_server.hasClient()) {
        WiFiClient incoming = _server.available();
        if (!_client || !_client.connected()) {
            _client = incoming;
            // Notify physical Serial only; the new client hasn't received
            // anything yet so the line appears at the next log write.
            Serial.println("[TELNET] Client connected");
        } else {
            // Reject a second simultaneous session
            incoming.println("[TELNET] Already connected — only one session allowed.");
            incoming.stop();
        }
    }

    // Release a client that has gone away
    if (_client && !_client.connected()) {
        _client.stop();
        Serial.println("[TELNET] Client disconnected");
    }
}

size_t TelnetLogger::write(uint8_t c) {
    Serial.write(c);
    if (_client && _client.connected()) {
        _client.write(c);
    }
    return 1;
}

size_t TelnetLogger::write(const uint8_t *buf, size_t size) {
    Serial.write(buf, size);
    if (_client && _client.connected()) {
        _client.write(buf, size);
    }
    return size;
}

int TelnetLogger::printf(const char *format, ...) {
    // 512 bytes covers the largest log line (JSON payload)
    char buf[512];
    va_list args;
    va_start(args, format);
    int len = vsnprintf(buf, sizeof(buf), format, args);
    va_end(args);
    if (len > 0) {
        write(reinterpret_cast<const uint8_t *>(buf), static_cast<size_t>(len));
    }
    return len;
}
