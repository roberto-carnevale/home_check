// HttpClient.h
// Header file for HTTP communication.
// Handles secure HTTPS POST requests and HMAC-SHA256 signing.

#ifndef HTTP_CLIENT_H
#define HTTP_CLIENT_H

#include <Arduino.h>

// Class to handle server communication
class HttpClient {
public:
    // Constructor takes server details, shared secret, and root certificate
    HttpClient(const char* host, uint16_t port, const char* path, const char* hmacSecret, const char* rootCa);

    // POSTs a JSON string to the configured endpoint
    // Requires a timestamp header; signs the request for authentication
    // Returns true if server responds with 200 or 201
    bool postJson(const String& jsonBody, unsigned long timestampUnix);

private:
    // Server connection details
    const char* _host;
    uint16_t _port;
    const char* _path;
    
    // Security credentials
    const char* _hmacSecret;
    const char* _rootCa;

    // Computes HMAC signature based on timestamp and body hash
    String computeSignature(const String& timestamp, const String& bodyHash);
    
    // Calculates SHA256 hash of a string, returns hex string
    String sha256Hex(const String& data);
    
    // Calculates HMAC-SHA256 given a key and message, returns hex string
    String hmacSha256Hex(const String& key, const String& message);
};

#endif // HTTP_CLIENT_H
