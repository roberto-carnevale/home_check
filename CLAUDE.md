# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Home Check is an ESP32 IoT sensor node + Google Cloud Run backend for remote home monitoring. An ESP32 with DHT22 (temperature/humidity), LDR (light), and SR505 PIR (motion) sensors POSTs signed JSON payloads every 5 minutes to a Node.js Express server on Cloud Run. The server stores data in Firestore, streams it to a PWA dashboard via SSE, and sends email/push alerts when thresholds are breached or the device goes offline.

## Commands

All commands run from `cloud-run-server/`:

```bash
npm install          # Install dependencies
npm start            # Start server on :8080
npm test             # Run all Jest tests (--runInBand)
npx jest tests/hmac.test.js   # Run a single test file
```

Deploy: `./deploy.sh` (requires `GOOGLE_CLOUD_PROJECT` and secrets as env vars)

## Architecture

Two independent components share an HMAC secret:

- **`esp32-sensor/`** — Arduino/PlatformIO C++ sketch. Reads sensors into circular buffers, computes rolling min/max/avg, POSTs HMAC-signed JSON to the server. A **mode switch on GPIO19** (with internal pull-up) selects the target at boot: floating/HIGH → remote Cloud Run (HTTPS), tied to GND → local dev server (plain HTTP). Config files (`config.h`, `secrets.h`) are gitignored.

- **`cloud-run-server/`** — Node.js 20 + Express. Entry point: `src/index.js`.

### Request Pipeline

`POST /api/data` → rate limiter → `middleware/hmac.js` (HMAC-SHA256 verify + replay protection) → `middleware/validate.js` (Joi schema) → `routes/data.js` (store, broadcast SSE, check thresholds, alert)

### Key Design Patterns

- **SSE broadcast injection**: `index.js` owns the `sseClients` Set and injects a `broadcast()` function into `routes/data.js` via `setBroadcast()` to avoid circular requires.
- **Watchdog**: `services/watchdog.js` runs a 95-minute dead-man timer, reset on each valid POST. Fires email + push if ESP32 goes silent.
- **Fire-and-forget alerts**: Email (`services/mailer.js` via Nodemailer SMTP) and push (`services/webpush.js` via VAPID) are not awaited in the request handler.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/data` | ESP32 sensor data ingestion (HMAC-protected) |
| POST | `/api/subscribe` | Register Web Push subscription |
| GET | `/api/sse` | Server-Sent Events stream for dashboard |
| GET | `/api/history` | Last 48h readings + last 10 PIR events |
| GET | `/` | Static PWA dashboard |

### Alert Thresholds

Defined in `src/routes/data.js` as `THRESHOLDS`: temp >35°C or <5°C, humidity >80% or <20%, light <50 raw units, plus motion detection.

## Environment

- Node.js >=20 required
- Config: `.env` file (copy from `.env.example`). Key var: `HMAC_SECRET_KEY` (must match ESP32 `secrets.h`)
- Docker: `node:20-alpine`, runs as non-root `appuser`
- Tests use Jest + supertest; no external services needed (middleware tested in isolation)

## Sensor Payload Schema

```json
{
  "device_id": "string",
  "timestamp": "integer",
  "window_minutes": "integer",
  "temperature": { "min": "number", "max": "number", "avg": "number" },
  "humidity": { "min": "number", "max": "number", "avg": "number" },
  "light_raw": { "min": "number", "max": "number", "avg": "number" },
  "motion_detected": "boolean (optional)"
}
```
