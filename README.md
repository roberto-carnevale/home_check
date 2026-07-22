# 🏠 Home Check

> **An ESP32 IoT sensor node + Google Cloud Run backend for remote home monitoring.**
> Tracks temperature, humidity, and ambient light — and alerts you by **email** and **Android push notification** when something goes wrong.

---

## Table of Contents

1. [Documentation](#documentation)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Project Layout](#project-layout)
5. [Hardware Requirements](#hardware-requirements)
6. [Security Design](#security-design)
7. [ESP32 Setup](#esp32-setup)
8. [Cloud Run Server Setup](#cloud-run-server-setup)
9. [Dashboard & Android Notifications](#dashboard--android-notifications)
10. [Alert Thresholds](#alert-thresholds)
11. [Environment Variables Reference](#environment-variables-reference)
12. [Running Tests](#running-tests)
13. [Deployment](#deployment)
14. [FAQ](#faq)
15. [License](#license)

---

## Documentation

Detailed step-by-step guides are in the [`/docs`](./docs/) folder:

| Guide | What it covers |
|---|---|
| [📦 Hardware Setup](./docs/01-hardware-setup.md) | Bill of materials, wiring diagrams, Arduino IDE + library installation, flashing, Serial Monitor, troubleshooting |
| [☁️ Cloud Run Deployment](./docs/02-cloud-run-deployment.md) | GCP project, Firestore, Secret Manager, VAPID keys, Docker build & push, `gcloud run deploy`, IAM roles, cost estimate, troubleshooting |


---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  HOME                                                    │
│                                                          │
│  ┌─────────────┐     HTTPS POST every 5 min             │
│  │   ESP32     │────────────────────────────────────┐   │
│  │  + DHT22    │  X-Timestamp, X-Signature (HMAC)   │   │
│  │  + LDR      │                                    │   │
│  │  + SR505    │◄───── PIR command in POST response  │   │
│  └─────────────┘                                    │   │
└─────────────────────────────────────────────────────│───┘
                                                      │
                                              ┌───────▼──────────────────────────┐
                                              │   Google Cloud Run (Node.js)     │
                                              │                                  │
                                              │  POST /api/data   ◄──── ESP32   │
                                              │    └─► response: {pir_enabled}  │
                                              │  POST /api/pir    ◄──── Browser │
                                              │  POST /api/subscribe ◄── Browser│
                                              │  GET  /api/sse    ────► Browser │
                                              │  GET  /api/history────► Browser │
                                              │  POST /api/auth/* ◄──── Browser │
                                              │  GET  /           ────► Browser │
                                              │                                  │
                                              │  ┌────────────┐                 │
                                              │  │ Firestore  │ readings +       │
                                              │  │            │ subscriptions    │
                                              │  └────────────┘                 │
                                              │  ┌──────────┐ ┌──────────────┐ │
                                              │  │Nodemailer│ │  web-push    │ │
                                              │  │  SMTP    │ │  (VAPID)     │ │
                                              │  └──────────┘ └──────────────┘ │
                                              └──────────────────────────────────┘
                                                      │               │
                                                 Email inbox    Android Chrome
                                                               push notification
```

### Data Flow

1. **Every 60 seconds** the ESP32 reads DHT22 (temperature + humidity), the LDR (light level), and the SR505 PIR (motion), adding the values to 30-sample circular buffers.
2. **Every 5 minutes** it computes min / max / avg over the rolling 30-minute window and POSTs a signed JSON payload to the Cloud Run endpoint.
3. The server **verifies the HMAC-SHA256 signature** and the timestamp (replay-attack protection), validates the payload with Joi, stores it in Firestore, and broadcasts it to all open dashboard connections via **Server-Sent Events**.
4. The server evaluates **alert thresholds**; if any are breached it sends an email and a Web Push notification instantly.
5. The `POST /api/data` **response includes the desired PIR state** from Firestore (`pir_enabled` + `pir_updated_at`), so the ESP32 picks up dashboard commands without needing an inbound connection (firewall-friendly). Both the dashboard and the physical button record a timestamp when toggled. The server compares timestamps on each POST: if the ESP32's physical toggle is newer, Firestore is updated; otherwise the dashboard's command stands. The ESP32 likewise only adopts the server's state if its timestamp is newer. **Most recent toggle wins.**
6. A **95-minute watchdog timer** resets on every successful POST. If it fires (no data received), the server sends an "ESP32 offline" alert via email and push notification.

---

## Features

| Feature | Details |
|---|---|
| 🌡️ Sensor data | Temperature (°C), Humidity (%), Light (ADC raw), Motion (PIR) |
| 📊 Rolling stats | Min / Max / Avg over the last 30 minutes |
| 🔐 HMAC-SHA256 auth | Every ESP32 POST is signed; replays blocked within 5 min |
| 📧 Email alerts | Nodemailer via SMTP; configurable recipient list |
| 📱 Push notifications | Web Push (VAPID); works in Chrome for Android without a native app |
| 🖥️ Live dashboard | PWA with real-time charts; installable on Android; email-code login |
| 🎛️ Remote PIR control | Toggle PIR from dashboard or physical button; command piggybacked on POST response (firewall-friendly); most recent toggle wins via timestamp comparison |
| ⏱️ Watchdog | 95-minute dead-man timer; alerts if ESP32 goes silent |
| ☁️ Serverless | Cloud Run auto-scales to zero; Firestore free tier friendly |
| 🔒 Security | Rate limiting, CORS allowlist, non-root Docker user, no secrets in code |

---

## Project Layout

```
home_check/
├── README.md                         ← you are here
│
├── esp32-sensor/                     ← Arduino / PlatformIO sketch
│   ├── esp32-sensor.ino              Main sketch (setup + loop)
│   ├── SensorManager.h               Sensor abstraction header
│   ├── SensorManager.cpp             DHT22 + LDR reading, circular buffer
│   ├── HttpClient.h                  HTTPS + HMAC signing header
│   ├── HttpClient.cpp                WiFiClientSecure + mbedTLS implementation
│   ├── config.h.example              ← copy to config.h and fill in values
│   └── secrets.h.example             ← copy to secrets.h and fill in values
│
└── cloud-run-server/                 ← Node.js Cloud Run service
    ├── Dockerfile
    ├── package.json
    ├── .env.example                  ← copy to .env and fill in values
    ├── .gitignore
    ├── deploy.sh                     gcloud run deploy helper
    ├── src/
    │   ├── index.js                  Express app entry point
    │   ├── routes/
    │   │   ├── data.js               POST /api/data (+ PIR command sync)
    │   │   ├── watchdog.js           GET /api/watchdog
    │   │   └── subscribe.js          POST /api/subscribe
    │   ├── services/
    │   │   ├── firestore.js          Firestore helpers
    │   │   ├── mailer.js             Nodemailer / SMTP
    │   │   ├── webpush.js            Web Push (VAPID)
    │   │   └── watchdog.js           95-min inactivity timer
    │   ├── middleware/
    │   │   ├── hmac.js               HMAC-SHA256 request verifier
    │   │   └── validate.js           Joi schema validator
    │   └── public/
    │       ├── index.html            Dashboard PWA
    │       ├── login.html            Email-code login page
    │       ├── app.js                Dashboard JS (SSE + charts + PIR toggle)
    │       ├── sw.js                 Service Worker (push notifications)
    │       └── manifest.json         PWA manifest
    └── tests/
        ├── hmac.test.js
        ├── validate.test.js
        └── watchdog.test.js
```

---

## Hardware Requirements

| Component | Part | Notes |
|---|---|---|
| Microcontroller | **ESP32** (any variant) | ESP32-WROOM-32, ESP32-S3, etc. |
| Temp + Humidity | **DHT22** (AM2302) | Connected to `GPIO4` (configurable) |
| Light sensor | **LDR / photoresistor** | 10 kΩ pull-down to GND; signal to `GPIO34` (ADC) |
| Motion sensor | **SR505 PIR** | Digital output to `GPIO14`; powered from 5V (VIN) |
| Manual test button | **Momentary push button** | Between `GPIO13` and GND (active low, internal pull-up) |
| PIR toggle button | **Momentary push button** | Between `GPIO27` and GND (active low, internal pull-up) |
| PIR status LED | **LED + resistor** | On `GPIO26`; lit when PIR monitoring is active |
| Mode switch | **SPDT switch or jumper** | `GPIO19` to GND = local dev; floating/HIGH = remote Cloud Run |
| Power | USB or 5V adapter | For continuous operation |

### Wiring Diagram

```
ESP32
─────
GPIO4  ───►  DHT22 DATA pin
             DHT22 VCC  → 3.3V
             DHT22 GND  → GND
             10kΩ pull-up between DATA and VCC

GPIO34 ───►  LDR junction (LDR + 10kΩ voltage divider to GND)
             Top of divider → 3.3V
             LDR between 3.3V and GPIO34
             10kΩ resistor between GPIO34 and GND

GPIO14 ───►  SR505 PIR OUT pin
             SR505 VCC  → VIN (5V)
             SR505 GND  → GND

GPIO13 ───►  Push button (one pin)
             Other pin   → GND (uses internal pull-up)

GPIO27 ───►  PIR toggle button (one pin)
             Other pin   → GND (uses internal pull-up)

GPIO26 ───►  PIR LED anode (via 220Ω resistor)
             LED cathode  → GND

GPIO19 ───►  Mode switch (GND = local, floating = remote)
```

### Arduino IDE Library Dependencies

Install via **Sketch → Include Library → Manage Libraries**:

| Library | Version |
|---|---|
| Adafruit DHT sensor library | ≥ 1.4.6 |
| Adafruit Unified Sensor | ≥ 1.1.14 |
| ArduinoJson | ≥ 6.21 (v6, **not** v7) |

ESP32 board package: `esp32` by Espressif (≥ 2.0.14) via Boards Manager.

---

## Security Design

### HMAC-SHA256 Request Signing

Every POST from the ESP32 carries two headers:

```
X-Timestamp: 1721308800
X-Signature: a3f1c2...
```

The signature is computed as:

```
message   = timestamp + "." + sha256hex(request_body)
signature = HMAC-SHA256(HMAC_SECRET, message)
```

The server rejects requests where:
- `|server_time - X-Timestamp| > 300 seconds` (replay attack protection)
- The signature doesn't match (constant-time comparison to prevent timing attacks)

### Secrets Management

| Secret | Location |
|---|---|
| HMAC shared secret | `secrets.h` (ESP32, never committed) + `HMAC_SECRET_KEY` env var (server) |
| SMTP credentials | `.env` / Google Secret Manager |
| VAPID keypair | `.env` / Google Secret Manager |
| Firebase service account | `GOOGLE_APPLICATION_CREDENTIALS` / Workload Identity |

### What Is **Never** Committed to Git

```
esp32-sensor/config.h        # WiFi credentials, server URL
esp32-sensor/secrets.h       # HMAC secret, root CA cert
cloud-run-server/.env        # All server secrets
```

> [!CAUTION]
> **Never** commit `config.h`, `secrets.h`, or `.env` to version control.
> The `.gitignore` is pre-configured to exclude them.

---

## ESP32 Setup

### 1. Clone the repository

```bash
git clone https://github.com/your-username/home-check.git
cd home-check/esp32-sensor
```

### 2. Configure WiFi, server, and pins

```bash
cp config.h.example config.h
```

Edit `config.h`:

```cpp
#define WIFI_SSID      "MyHomeNetwork"
#define WIFI_PASSWORD  "supersecret"
#define SERVER_HOST    "home-check-server-xxxx-uc.a.run.app"
#define SERVER_PORT    443
#define SERVER_PATH    "/api/data"
#define DEVICE_ID      "esp32-home-01"
#define DHT_PIN        4
#define DHT_TYPE       DHT22
#define LDR_PIN        34
#define PIR_PIN        14
#define BUTTON_PIN     13
#define SAMPLE_INTERVAL_MS  60000UL   // 1 minute
#define REPORT_INTERVAL_MIN 5         // POST every 5 minutes
#define ROLLING_WINDOW      30        // 30-minute rolling window
```

### 3. Configure secrets

```bash
cp secrets.h.example secrets.h
```

Edit `secrets.h`:

```cpp
#define HMAC_SECRET "paste-your-64-char-random-secret-here"
```

Get the root CA certificate for your Cloud Run domain:

```bash
openssl s_client -connect your-cloud-run-host.run.app:443 -showcerts 2>/dev/null \
  | openssl x509 -noout -text | grep "Issuer"
# Copy the last (root) certificate from the chain into ROOT_CA_CERT in secrets.h
```

### 4. Flash

Open `esp32-sensor.ino` in Arduino IDE, select your ESP32 board, and upload.  
Open the Serial Monitor at **115200 baud** to watch connection and POST status.

---

## Cloud Run Server Setup

### 1. Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated
- A Google Cloud project with billing enabled
- Firestore in **Native mode** created in your project
- An SMTP account (e.g., Gmail with an [App Password](https://support.google.com/accounts/answer/185833))

### 2. Generate VAPID Keys

```bash
cd cloud-run-server
npx web-push generate-vapid-keys
```

Copy the output — you'll need it in the next step.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values (see [Environment Variables Reference](#environment-variables-reference)).

### 4. Local development

```bash
npm install
npm start
# Server runs on http://localhost:8080
```

### 5. Deploy to Cloud Run

```bash
chmod +x deploy.sh
# Set required env vars first:
export GOOGLE_CLOUD_PROJECT=your-project-id
export HMAC_SECRET_KEY=your-hmac-secret
export SESSION_SECRET=your-dashboard-session-secret
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USER=you@gmail.com
export SMTP_PASS=your-app-password
export ALERT_EMAILS=alert1@example.com,alert2@example.com
export ADMIN_EMAILS=admin1@example.com,admin2@example.com
export VAPID_PUBLIC_KEY=your-vapid-public
export VAPID_PRIVATE_KEY=your-vapid-private
export VAPID_SUBJECT=mailto:admin@example.com
export ALLOWED_ORIGIN=https://home-check-server-xxxx-uc.a.run.app

./deploy.sh
```

The script prints the public service URL on success. Copy it into `config.h` on the ESP32.

---

## Dashboard & Android Notifications

1. **Open the dashboard** in Chrome for Android at your Cloud Run URL.
2. Request a six-digit access code. The code is sent to every address in `ADMIN_EMAILS`.
3. Enter the one-time code to open the dashboard. It expires after 10 minutes; the browser session lasts 12 hours.
4. Tap the **"Subscribe to Notifications"** button and allow notifications when prompted.
5. Your subscription is stored in Firestore and receives a push notification whenever an alert fires or the watchdog triggers.
6. To **install as a PWA**, tap the Chrome menu → "Add to Home screen".

The dashboard shows three live line charts (Temperature, Humidity, Light) updated in real-time via Server-Sent Events, a PIR motion event log, and an **Activate/Deactivate PIR** button.

### PIR Remote Control

The ESP32 sits behind a firewall and cannot receive inbound connections. PIR commands are resolved by **timestamp comparison** — the most recent toggle always wins, whether it comes from the dashboard or the physical button (GPIO27).

- **Dashboard toggle**: `POST /api/pir` stores `{ enabled, updatedAt }` in Firestore.
- **Physical button toggle**: The ESP32 records a Unix timestamp (`pirUpdatedAt`) and sends `pir_enabled` + `pir_updated_at` in the next `POST /api/data` payload.
- **Server resolution**: On each `POST /api/data`, the server compares the ESP32's `pir_updated_at` with Firestore's `updatedAt`. If the ESP32's is newer, Firestore is updated. The response returns the winning state (`pir_enabled` + `pir_updated_at`).
- **ESP32 resolution**: The ESP32 only adopts the server's command if its timestamp is newer than the local `pirUpdatedAt`.

---

## Alert Thresholds

Configurable in `cloud-run-server/src/routes/data.js`:

| Metric | Condition | Meaning |
|---|---|---|
| Temperature | avg > **35 °C** | Overheating |
| Temperature | avg < **5 °C** | Risk of frost |
| Humidity | avg > **80 %** | Excessive moisture / mould risk |
| Humidity | avg < **20 %** | Too dry |
| Light (raw) | avg < **50** | Sustained darkness |
| Motion | PIR triggered | Intrusion / unexpected movement |
| Watchdog | No data for **95 min** | ESP32 offline / power loss |

Each triggered alert sends **both** an email and a push notification.

---

## Environment Variables Reference

| Variable | Required | Example | Description |
|---|---|---|---|
| `PORT` | No | `8080` | HTTP port (Cloud Run sets this automatically) |
| `NODE_ENV` | No | `production` | Node environment |
| `HMAC_SECRET_KEY` | ✅ | `64-char-hex` | HMAC shared secret (must match ESP32 `secrets.h`) |
| `SESSION_SECRET` | ✅ | `random-secret` | Signs dashboard login session cookies |
| `ALLOWED_ORIGIN` | ✅ | `https://...run.app` | CORS allowed origin |
| `ALERT_EMAILS` | ✅ | `a@b.com,c@d.com` | Comma-separated email alert recipients |
| `ADMIN_EMAILS` | No* | `a@b.com,c@d.com` | Login-code recipients (*falls back to `ALERT_EMAILS`) |
| `SMTP_HOST` | ✅ | `smtp.gmail.com` | SMTP server hostname |
| `SMTP_PORT` | ✅ | `587` | SMTP port (587 = STARTTLS) |
| `SMTP_USER` | ✅ | `you@gmail.com` | SMTP username |
| `SMTP_PASS` | ✅ | `app-password` | SMTP password / App Password |
| `VAPID_PUBLIC_KEY` | ✅ | `BExamp...` | VAPID public key (from `npx web-push generate-vapid-keys`) |
| `VAPID_PRIVATE_KEY` | ✅ | `xyzabc...` | VAPID private key |
| `VAPID_SUBJECT` | ✅ | `mailto:admin@x.com` | Contact email for VAPID |
| `GOOGLE_APPLICATION_CREDENTIALS` | No* | `/path/to/sa.json` | Service account key path (*not needed on Cloud Run with Workload Identity) |
| `FIRESTORE_PROJECT_ID` | No* | `my-project` | Firestore project (*auto-detected on Cloud Run) |

---

## Running Tests

```bash
cd cloud-run-server
npm test
```

Tests cover:
- **HMAC middleware** — valid/invalid signatures, expired timestamps, missing headers
- **Joi validator** — valid payloads, missing fields, out-of-range values
- **Watchdog timer** — fires after timeout, resets correctly (uses Jest fake timers)

---

## Deployment

For CI/CD, you can add a Cloud Build trigger that runs `deploy.sh` on every push to `main`. Store secrets in **Google Secret Manager** and grant the Cloud Run service account `roles/secretmanager.secretAccessor`.

### Recommended IAM roles for the Cloud Run service account

| Role | Reason |
|---|---|
| `roles/datastore.user` | Read/write Firestore |
| `roles/secretmanager.secretAccessor` | Access secrets at runtime |

---

## FAQ

**Q: Can I use multiple ESP32 devices?**  
A: Yes. Each device needs a unique `DEVICE_ID` in `config.h`. All readings are stored in Firestore under their device ID.

**Q: How do I rotate the HMAC secret?**  
A: Update `HMAC_SECRET_KEY` in Cloud Run environment variables and `HMAC_SECRET` in `secrets.h`, then reflash the ESP32. Do not commit the secret.

**Q: My ESP32 can't verify the TLS certificate.**  
A: You need to paste the correct root CA into `secrets.h`. See the [ESP32 Setup](#esp32-setup) section for the `openssl` command to extract it.

**Q: Can I use SendGrid instead of SMTP?**  
A: Yes — replace the Nodemailer transport in `src/services/mailer.js` with the [nodemailer-sendgrid](https://www.npmjs.com/package/nodemailer-sendgrid) transport.

**Q: Does this work without internet at home?**  
A: No — the ESP32 requires an internet connection to reach Cloud Run. Local MQTT/Home Assistant integration is out of scope for this project.

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

> Built with ❤️ using ESP32, Google Cloud Run, and the Web Push API.
