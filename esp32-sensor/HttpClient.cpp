// HttpClient.cpp
// Implementation of HttpClient class.
// Uses WiFiClientSecure for TLS and mbedTLS for hashing/signing.

#include "HttpClient.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h> // ESP32 HTTP client library

// mbedTLS headers for cryptographic functions
#include "mbedtls/md.h"
#include "mbedtls/sha256.h"

// Constructor initialization
HttpClient::HttpClient(const char* host, uint16_t port, const char* path, const char* hmacSecret, const char* rootCa)
    : _host(host), _port(port), _path(path), _hmacSecret(hmacSecret), _rootCa(rootCa) {
    // Nothing more to initialize here
}

// SHA256 implementation using mbedTLS
// Takes a string, returns its SHA256 hash in hex format
String HttpClient::sha256Hex(const String& data) {
    // Buffer for binary hash output (32 bytes)
    byte hash[32];
    
    // Context structure for mbedTLS SHA256
    mbedtls_sha256_context ctx;
    
    // Initialize context
    mbedtls_sha256_init(&ctx);
    // Start SHA256 operation (0 = SHA256, not SHA224)
    mbedtls_sha256_starts(&ctx, 0);
    // Process the input string data
    mbedtls_sha256_update(&ctx, (const unsigned char*)data.c_str(), data.length());
    // Finish and write result into hash buffer
    mbedtls_sha256_finish(&ctx, hash);
    // Clean up context memory
    mbedtls_sha256_free(&ctx);

    // Convert binary hash to hex string
    String hexString = "";
    for (int i = 0; i < 32; i++) {
        char buf[3];
        // Format each byte as 2-character hex
        sprintf(buf, "%02x", hash[i]);
        hexString += buf;
    }
    return hexString;
}

// HMAC-SHA256 implementation using mbedTLS
// Signs a message with a key, returns hex string
String HttpClient::hmacSha256Hex(const String& key, const String& message) {
    // Buffer for binary HMAC output (32 bytes)
    byte hmacResult[32];
    
    // Context structure for mbedTLS Message Digest (MD)
    mbedtls_md_context_t ctx;
    
    // Initialize MD context
    mbedtls_md_init(&ctx);
    // Get info structure for SHA256 algorithm
    const mbedtls_md_info_t *md_info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    
    // Setup MD context with SHA256 info
    mbedtls_md_setup(&ctx, md_info, 1); // 1 = use HMAC
    // Start HMAC operation with provided key
    mbedtls_md_hmac_starts(&ctx, (const unsigned char *)key.c_str(), key.length());
    // Process the input message
    mbedtls_md_hmac_update(&ctx, (const unsigned char *)message.c_str(), message.length());
    // Finish and write result into hmacResult buffer
    mbedtls_md_hmac_finish(&ctx, hmacResult);
    // Clean up MD context memory
    mbedtls_md_free(&ctx);

    // Convert binary HMAC to hex string
    String hexString = "";
    for (int i = 0; i < 32; i++) {
        char buf[3];
        // Format each byte as 2-character hex
        sprintf(buf, "%02x", hmacResult[i]);
        hexString += buf;
    }
    return hexString;
}

// computeSignature implementation
// Combines timestamp and body hash, signs with HMAC
String HttpClient::computeSignature(const String& timestamp, const String& bodyHash) {
    // Format: timestamp + "." + bodyHash
    String messageToSign = timestamp + "." + bodyHash;
    // Sign using the shared secret
    String hmacHex = hmacSha256Hex(_hmacSecret, messageToSign);
    // Prepend 'sha256=' to match requested header format
    return "sha256=" + hmacHex;
}

// postJson implementation
// Sends signed POST request over HTTPS or plain HTTP (when no CA cert)
bool HttpClient::postJson(const String& jsonBody, unsigned long timestampUnix) {
    HTTPClient http;
    bool begun = false;

    // Choose secure or plain connection based on whether a CA cert was provided
    WiFiClientSecure *secureClient = nullptr;
    WiFiClient *plainClient = nullptr;

    if (_rootCa) {
        // TLS mode for remote server
        secureClient = new WiFiClientSecure;
        if (!secureClient) {
            Serial.println("[HTTP] Unable to create secure client");
            return false;
        }
        secureClient->setCACert(_rootCa);
        secureClient->setHandshakeTimeout(30);
        String url = String("https://") + _host + ":" + String(_port) + _path;
        Serial.print("[HTTP] Connecting to: ");
        Serial.println(url);
        begun = http.begin(*secureClient, url);
    } else {
        // Plain HTTP mode for local server
        plainClient = new WiFiClient;
        if (!plainClient) {
            Serial.println("[HTTP] Unable to create client");
            return false;
        }
        String url = String("http://") + _host + ":" + String(_port) + _path;
        Serial.print("[HTTP] Connecting to: ");
        Serial.println(url);
        begun = http.begin(*plainClient, url);
    }

    if (!begun) {
        Serial.println("[HTTP] Unable to connect to server");
        delete secureClient;
        delete plainClient;
        return false;
    }

    // Compute timestamp string
    String tsStr = String(timestampUnix);
    // Compute body hash
    String bodyHash = sha256Hex(jsonBody);
    // Compute final signature
    String signature = computeSignature(tsStr, bodyHash);

    const size_t bodyLength = jsonBody.length();
    if (bodyLength == 0) {
        Serial.println("[HTTP] Empty payload, skipping request");
        http.end();
        delete secureClient;
        delete plainClient;
        return false;
    }

    // Add headers.
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Timestamp", tsStr);
    http.addHeader("X-Signature", signature);

    http.setTimeout(15000);
    http.setReuse(false);

    Serial.print("[HTTP] Body length: ");
    Serial.println(bodyLength);

    // Execute POST request with body.
    // The String overload is more reliable on the ESP32 core than the raw-byte
    // overload and gives us a better chance of getting a real HTTP error code.
    int httpCode = http.POST(jsonBody);

    Serial.print("[HTTP] POST Result Code: ");
    Serial.println(httpCode);
    if (httpCode < 0) {
        Serial.print("[HTTP] POST error: ");
        Serial.println(http.errorToString(httpCode));
    }

    bool success = false;
    if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
        success = true;
    } else {
        String payload = http.getString();
        Serial.print("[HTTP] Error payload: ");
        Serial.println(payload);
    }

    // Clean up
    http.end();
    delete secureClient;
    delete plainClient;
    return success;
}
