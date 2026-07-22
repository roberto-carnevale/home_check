# Documentation

| Guide | Description |
|---|---|
| [01 -- Hardware Setup](./01-hardware-setup.md) | Bill of materials, wiring diagrams (DHT22, LDR, SR505 PIR, PIR toggle button, PIR LED, mode switch), Arduino IDE setup, library installation, flashing, Serial Monitor reference, troubleshooting |
| [02 -- Cloud Run Deployment](./02-cloud-run-deployment.md) | GCP project setup, Firestore, Secret Manager, VAPID keys, Docker build & push, `gcloud run deploy`, IAM roles, Cloud Scheduler watchdog, verification, cost estimate, troubleshooting |
| [03 -- Security Audit](./03-security-audit.md) | Full security review: threat model, critical/high/medium/low findings across ESP32 TLS, HMAC, session management, authentication, CORS, Firestore rules, and remediation plan |

## System Overview

The application is composed of:

- **ESP32 sensor node** -- reads temperature, humidity, light, and motion (PIR). Posts HMAC-signed JSON to the server every 5 minutes. PIR can be toggled on/off locally (button on GPIO27) or remotely from the dashboard. Remote commands are delivered piggybacked on the `POST /api/data` response (`pir_enabled` + `pir_updated_at`), so no inbound connection to the ESP32 is needed (firewall-friendly). Both the dashboard and the physical button record a timestamp when toggled; the most recent toggle wins via timestamp comparison. A mode switch (GPIO19) selects between local dev server and remote Cloud Run at boot.

- **Cloud Run server (Node.js)** -- receives sensor data, stores it in Firestore, streams live updates to the dashboard via SSE, and sends email + push alerts when thresholds are breached. A 95-minute watchdog (backed by Cloud Scheduler) alerts if the ESP32 goes offline (e.g. power outage). A scheduler-friendly `GET /api/watchdog` endpoint supports reliable detection even when Cloud Run scales to zero.

- **PWA dashboard** -- accessed via email challenge (six-digit code sent to admin emails, 10-minute TTL, 12-hour session). Shows live temperature/humidity/light charts, a PIR motion event log, and buttons to toggle PIR monitoring and subscribe to push notifications.
