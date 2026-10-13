# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Home Check is an ESP32 IoT sensor node + Google Cloud Run backend for remote home monitoring. An ESP32 with DHT22 (temperature/humidity), LDR (light), AGS02MA (TVOC/air quality), and SR505 PIR (motion) sensors POSTs signed JSON payloads every 30 minutes to a Node.js Express server on Cloud Run. The server stores data in Firestore, streams it to a PWA dashboard via SSE, and sends email/push alerts when thresholds are breached or the device goes offline.

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

- **`esp32-sensor/`** — Arduino/PlatformIO C++ sketch. Reads sensors into circular buffers, computes rolling min/max/avg, POSTs HMAC-signed JSON to the server. Sensors: DHT22 (temp/humidity on GPIO4), LDR (light on GPIO34), AGS02MA (TVOC via I2C on SDA/SCL GPIO21/22, address 0x1A), SR505 PIR (motion on GPIO14). A **TM1637 4-digit 7-segment display** (5V, CLK GPIO25, DIO GPIO26) driven by `DisplayManager` cycles temperature (`26°C`), humidity (`54rh`) and air quality (`100q`, or `lo q` above 999 ppb, `-- q` when unavailable) every 5 seconds. **The display is presence-gated**: it is blank by default and only lights up when the PIR detects someone AND the alarm is disarmed (`pirEnabled == false`). When the alarm is armed the display stays dark at all times regardless of motion. A **mode switch on GPIO19** (with internal pull-up) selects the target at boot: floating/HIGH → remote Cloud Run (HTTPS), tied to GND → local dev server (plain HTTP). Config files (`config.h`, `secrets.h`) are gitignored.

- **`cloud-run-server/`** — Node.js 20 + Express. Entry point: `src/index.js`.

### Request Pipeline

`POST /api/data` → rate limiter → `middleware/hmac.js` (HMAC-SHA256 verify + replay protection) → `middleware/validate.js` (Joi schema) → `routes/data.js` (store, broadcast SSE, check thresholds, alert)

### Key Design Patterns

- **SSE broadcast injection**: `index.js` owns the `sseClients` Set and injects a `broadcast()` function into `routes/data.js` via `setBroadcast()` to avoid circular requires.
- **Watchdog**: `services/watchdog.js` runs a 95-minute dead-man timer, reset on each valid POST. Fires email + push if ESP32 goes silent.
- **Fire-and-forget alerts**: Email (`services/mailer.js` via Nodemailer SMTP) and push (`services/webpush.js` via VAPID) are not awaited in the request handler.
- **PIR command delivery via poll**: The ESP32 is behind a firewall and cannot receive inbound connections. PIR enable/disable commands from the dashboard are stored in Firestore and delivered by the ESP32 polling `GET /api/pir/command` (HMAC-signed) every 15 minutes (`PIR_COMMAND_POLL_INTERVAL_MS`). The physical toggle button on GPIO27 changes local state only; it no longer syncs back to the server. The `POST /api/data` response carries only `{ success: true }` — no PIR fields.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/data` | ESP32 sensor data ingestion (HMAC-protected); response is `{ success: true }` |
| POST | `/api/subscribe` | Register Web Push subscription |
| GET | `/api/sse` | Server-Sent Events stream for dashboard |
| GET | `/api/history` | Last 48h readings + last 10 PIR events |
| GET | `/api/config` | Runtime config (VAPID public key) |
| GET | `/api/pir` | Get desired PIR state from Firestore |
| POST | `/api/pir` | Set desired PIR state from dashboard |
| GET | `/api/pir/command` | ESP32 polls PIR command every 15 min (HMAC-protected) |
| POST | `/api/auth/request-code` | Request 6-digit email login code |
| POST | `/api/auth/verify-code` | Verify login code and create session |
| GET | `/api/watchdog` | Cloud Scheduler health-check endpoint |
| GET | `/` | Dashboard (requires session auth) |

### Alert Thresholds

Defined in `src/routes/data.js` as `THRESHOLDS`: temp >35°C or <5°C, humidity >80% or <20%, light <50 raw units, TVOC >450 ppb, plus motion detection.

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
  "tvoc": { "min": "number", "max": "number", "avg": "number (optional, ppb)" },
  "motion_detected": "boolean (optional)"
}
```
