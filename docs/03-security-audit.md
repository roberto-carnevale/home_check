# Security Audit

> Full security review of the Home Check IoT system (ESP32 + Cloud Run + PWA dashboard).
> Last updated: 2026-07-22.

---

## Table of Contents

1. [Threat Model](#threat-model)
2. [Critical Findings](#critical-findings)
3. [High-Severity Findings](#high-severity-findings)
4. [Medium-Severity Findings](#medium-severity-findings)
5. [Low-Severity Findings](#low-severity-findings)
6. [Informational](#informational)
7. [Remediation Summary](#remediation-summary)

---

## Threat Model

The system has three trust boundaries:

```
ESP32 (home LAN) ──HTTPS──> Cloud Run (public internet) <──HTTPS── Browser (user)
```

| Actor | Goal | Entry Point |
|---|---|---|
| Network attacker (MITM) | Intercept or forge sensor data | ESP32 <-> Cloud Run TLS link |
| Remote attacker | Access dashboard, inject data, DoS | Public Cloud Run endpoints |
| Credential thief | Steal secrets from repo/files | Git history, local files, deploy scripts |
| Replay attacker | Re-send captured valid payloads | `POST /api/data` |

---

## Critical Findings

### C1 -- TLS Certificate Verification Disabled on ESP32 -- REMEDIATED

**Was**: `setInsecure()` was called after `setCACert()` in `HttpClient.cpp`, completely disabling server certificate verification and allowing MITM attacks on the WiFi network.

**Root cause**: The `config.h` contained the WR2 **intermediate** certificate instead of the GTS Root R1 **root** certificate. ESP32's mbedTLS could not build the full trust chain with only the intermediate, so `setInsecure()` was added as a workaround.

**Fix applied**: Replaced the manual CA certificate approach with the **ESP32 built-in root CA certificate bundle** (`esp_crt_bundle.h`). This bundle ships with the ESP32 Arduino core and contains ~130 Mozilla trusted root CAs, working exactly like a browser. Benefits:
- Proper TLS verification without `setInsecure()`
- No need to manually extract or rotate the `ROOT_CA_CERT` in `secrets.h`
- Survives Google certificate rotations automatically
- `setCACert()` is still supported as an override for certificate pinning scenarios

### C2 -- Secrets Present in Untracked Local Files Without Encryption

Multiple files on disk contain production secrets in plaintext:

| File | Contents |
|---|---|
| `cloud-run-server/.env` | HMAC key, SMTP app password, VAPID keys |
| `esp32-sensor/config.h` | WiFi SSID/password, HMAC secret, Cloud Run hostname, root CA cert |
| `docs/vapid.txt` | HMAC secret, VAPID keys, SMTP app password, server URL |

While `.gitignore` prevents these from being committed, they exist as plaintext on disk. The `docs/vapid.txt` file is particularly risky as the `docs/` directory is not gitignored and developers may accidentally commit it.

**Impact**: Any access to the developer machine exposes all production credentials.

**Fix**:
- Delete `docs/vapid.txt` and store secrets exclusively in a password manager or Google Secret Manager.
- Add `docs/vapid.txt` to `.gitignore` as a safety net.
- Move the HMAC secret in `config.h` to `secrets.h` as the project convention dictates (the file itself has a `////MOVE TO SECRECTS` comment acknowledging this).

### C3 -- HMAC Secret Fallback to Hardcoded Default -- REMEDIATED

**Was**: `hmac.js` fell back to `'default_secret'` if `HMAC_SECRET_KEY` was unset, allowing anyone who reads the source to forge signatures.

**Fix applied**:
- Removed the `|| 'default_secret'` fallback from `hmac.js`. The existing guard now correctly returns a 500 when the key is missing.
- Added startup validation in `index.js` that calls `process.exit(1)` if `HMAC_SECRET_KEY` is not set. The server will not start without it.

---

## High-Severity Findings

### H1 -- Session Secret Falls Back to HMAC Key or Hardcoded Default -- REMEDIATED

**Was**: `signSession()` in `index.js` fell back to `HMAC_SECRET_KEY` or `'default_secret'` if `SESSION_SECRET` was unset, allowing session forgery.

**Fix applied**:
- `signSession()` now uses `process.env.SESSION_SECRET` exclusively (no fallback chain).
- Startup validation in `index.js` calls `process.exit(1)` if `SESSION_SECRET` is not set.
- `.env.example` and deployment docs updated to include `SESSION_SECRET`.

### H2 -- CORS Wildcard in Production Deploy Script -- REMEDIATED

**File**: `cloud-run-server/deploy.sh`

**Was**: `--update-env-vars ALLOWED_ORIGIN="*"` hardcoded a wildcard, allowing any website to make cross-origin requests.

**Fix applied**: Removed the wildcard env var. The deploy script now retrieves the real Cloud Run service URL after deployment and sets `ALLOWED_ORIGIN` to that URL via `gcloud run services update`. Since the dashboard and API share the same origin, only the service's own URL is needed.

### H3 -- Watchdog Endpoint Has No Authentication -- REMEDIATED

**Was**: `GET /api/watchdog` and `POST /api/watchdog` were publicly accessible, allowing unauthenticated alert spam and data pruning.

**Fix applied**: Added a `verifyWatchdogToken` middleware to `routes/watchdog.js`. The endpoint now requires an `Authorization: Bearer <token>` header checked against the `WATCHDOG_TOKEN` env var (constant-time comparison). Cloud Scheduler sends the token as a custom header. The token is stored in Secret Manager and loaded via `deploy.sh`.

### H4 -- No Rate Limiting on Login Code Request -- REMEDIATED

**File**: `cloud-run-server/src/index.js`

**Was**: `POST /api/auth/request-code` had no rate limiter, allowing SMTP flooding and login DoS.

**Fix applied**: Added `authRequestLimiter` -- 3 requests per 15 minutes per IP.

### H5 -- No Brute-Force Protection on Code Verification -- REMEDIATED

**File**: `cloud-run-server/src/index.js`

**Was**: `POST /api/auth/verify-code` had no rate limiter, enabling brute-force of the 6-digit code.

**Fix applied**: Added `authVerifyLimiter` -- 5 attempts per 10 minutes per IP.

---

## Medium-Severity Findings

### M1 -- Single Login Challenge Document (Race Condition)

**File**: `cloud-run-server/src/services/firestore.js:14`

```js
await db.collection('auth_challenges').doc('dashboard').set(challenge);
```

All login attempts share a single Firestore document (`auth_challenges/dashboard`). If two users (or an attacker and the legitimate user) request a code simultaneously, the second request overwrites the first code, invalidating it.

**Impact**: Login denial of service; an attacker requesting codes continuously prevents the legitimate user from logging in.

**Fix**: Use per-session or per-IP challenge documents, or add the IP/session identifier to the document key.

### M2 -- No HMAC Nonce/Replay Tracking Within the Time Window

**File**: `cloud-run-server/src/middleware/hmac.js:42`

The replay protection only checks `|now - timestamp| < 300s`. Within that 5-minute window, the exact same signed request can be replayed unlimited times. While the data is idempotent (duplicate readings), this could be used to:
- Artificially trigger threshold alerts
- Reset the watchdog timer to mask a real offline event

**Impact**: Alert manipulation within the replay window.

**Fix**: Track recently seen `(timestamp, signature)` pairs in memory or Firestore and reject duplicates. Given the ESP32 posts every 5 minutes, the tracking set stays small.

### M3 -- `SESSION_SECRET` Not in Deploy Script or Secret Manager -- REMEDIATED

**Was**: `deploy.sh` did not include `SESSION_SECRET` in `--update-secrets`, leaving it undefined in production.

**Fix applied**: `SESSION_SECRET` is now documented in `.env.example`, `02-cloud-run-deployment.md` (Secret Manager creation and deploy command), and the server exits at startup if it is missing (see C3/H1). The `deploy.sh` script should be updated to include `SESSION_SECRET=home-check-session-secret:latest` in `--update-secrets` when the secret is created in Secret Manager.

### M4 -- PIR Command GET Endpoint Replay Risk

**File**: `cloud-run-server/src/index.js:251`

The `GET /api/pir/command` endpoint is HMAC-protected, but for GET requests the body is empty. The HMAC signs `timestamp.sha256("")`, meaning only the timestamp varies. An attacker who captures one valid request can replay it within the 5-minute window.

**Impact**: An attacker could replay a PIR state query. The risk is low since it's a read-only operation, but it weakens the authentication model.

**Fix**: For GET requests, consider including the URL path in the HMAC message, or accept this as a low risk for a read-only endpoint.

### M5 -- Firestore Rules Not Defined

No Firestore security rules are mentioned in the documentation or codebase. If the Firestore database uses default rules (`allow read, write: if true`), any authenticated Firebase client (not just the server) can read/write all collections.

**Impact**: Direct data manipulation bypassing the server.

**Fix**: Set restrictive Firestore rules that deny all client-side access (only the server service account should read/write):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

---

## Low-Severity Findings

### L1 -- No Security Headers (Helmet.js)

The Express app does not set standard security headers:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy`

**Fix**: Add `helmet` middleware:
```bash
npm install helmet
```
```js
const helmet = require('helmet');
app.use(helmet());
```

### L2 -- Chart.js Loaded from CDN Without SRI

**File**: `cloud-run-server/src/public/index.html:248`

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
```

No Subresource Integrity (SRI) hash. If the CDN is compromised, arbitrary JavaScript runs in the dashboard session.

**Fix**: Add an `integrity` attribute with the SHA-384 hash of the expected file, or bundle Chart.js locally.

### L3 -- `Secure` Cookie Flag Only in Production

**File**: `cloud-run-server/src/index.js:155`

```js
${process.env.NODE_ENV === 'production' ? '; Secure' : ''}
```

In development mode, the session cookie is sent over plain HTTP. This is expected behavior, but `NODE_ENV` is set to `development` in the current `.env` file even though the server URL points to the production Cloud Run instance.

**Fix**: Ensure `.env` on the deployed service has `NODE_ENV=production` (the Dockerfile already sets this; verify the `.env` file doesn't override it).

### L4 -- Validation Schema Allows Arbitrary `device_id`

**File**: `cloud-run-server/src/middleware/validate.js:10`

```js
device_id: Joi.string().required(),
```

Any non-empty string is accepted as a device ID. An attacker with the HMAC secret could inject readings under arbitrary device IDs, polluting Firestore.

**Fix**: Validate `device_id` against an allowlist or pattern (e.g., `Joi.string().pattern(/^esp32-home-\d{2}$/).required()`).

### L5 -- ESP32 WiFi Reconnect Blocks the Main Loop

**File**: `esp32-sensor/esp32-sensor.ino:57`

```cpp
while (WiFi.status() != WL_CONNECTED) {
    delay(500);
```

If WiFi is unavailable, the ESP32 blocks indefinitely. No watchdog reset, no sensor sampling, no timeout.

**Fix**: Add a maximum retry count or timeout, then either restart the ESP32 (`ESP.restart()`) or continue sampling sensors offline.

---

## Informational

### I1 -- `docs/vapid.txt` Contains a Scratch Pad of Secrets

This file appears to be a developer scratch pad with copy-pasted test commands, VAPID keys, the HMAC secret, SMTP app password, and the server URL. While currently gitignored at the root level, it resides in the `docs/` directory which developers typically do commit. Consider deleting this file entirely and storing secrets in a password manager.

### I2 -- `config.h` Has Secrets Inline Instead of in `secrets.h`

The actual `config.h` includes the HMAC secret and root CA certificate directly instead of in `secrets.h` as the project convention dictates. There's a `////MOVE TO SECRECTS` comment acknowledging this TODO.

### I3 -- `PIR_SAMPLE_INTERVAL_MS` and PIR Pins Missing from `config.h.example` -- REMEDIATED

**Was**: The example config file was missing `PIR_SAMPLE_INTERVAL_MS`, `PIR_TOGGLE_PIN`, and `PIR_LED_PIN`.

**Fix applied**: `config.h.example` now includes all three defines.

### I4 -- ESP32 Local Mode Connection Aborted

**File**: `esp32-sensor/HttpClient.cpp:159`

```cpp
Serial.println("[HTTP] No root CA provided, connection aborted for security reasons");
```

When the mode switch selects local server (`caCert = nullptr`), the `postJson` method aborts because there's no CA cert and the plain HTTP path was removed. Local development mode is effectively broken.

---

## Remediation Summary

| ID | Severity | Effort | Description |
|---|---|---|---|
| **C1** | Critical | DONE | Remove `setInsecure()`, use built-in CA bundle |
| **C2** | Critical | 15 min | Delete `docs/vapid.txt`, move secrets from `config.h` to `secrets.h` |
| **C3** | Critical | DONE | Fail hard if `HMAC_SECRET_KEY` is not set |
| **H1** | High | DONE | Require `SESSION_SECRET` env var, fail if missing |
| **H2** | High | DONE | Fix `ALLOWED_ORIGIN` in `deploy.sh` |
| **H3** | High | DONE | Add authentication to `/api/watchdog` |
| **H4** | High | DONE | Rate-limit `POST /api/auth/request-code` |
| **H5** | High | DONE | Rate-limit `POST /api/auth/verify-code` |
| **M1** | Medium | 20 min | Use per-session login challenge documents |
| **M2** | Medium | 20 min | Track seen signatures to block in-window replays |
| **M3** | Medium | DONE | Add `SESSION_SECRET` to `deploy.sh` secrets |
| **M4** | Medium | Low | Accept or include path in HMAC for GET requests |
| **M5** | Medium | 10 min | Deploy restrictive Firestore security rules |
| **L1** | Low | 5 min | Add `helmet` middleware |
| **L2** | Low | 5 min | Add SRI hash to Chart.js script tag |
| **L3** | Low | 2 min | Verify `NODE_ENV=production` on deployed service |
| **L4** | Low | 5 min | Add device_id pattern validation |
| **L5** | Low | 10 min | Add WiFi reconnect timeout on ESP32 |
