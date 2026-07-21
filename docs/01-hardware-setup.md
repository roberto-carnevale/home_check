# Hardware Setup Guide

> **Goal**: Wire the DHT22 temperature/humidity sensor and the LDR light sensor to your ESP32, install the required Arduino libraries, and flash the sketch for the first time.

---

## Table of Contents

1. [Bill of Materials](#bill-of-materials)
2. [Understanding the Circuits](#understanding-the-circuits)
3. [Wiring the DHT22](#wiring-the-dht22)
4. [Wiring the LDR (Light Sensor)](#wiring-the-ldr-light-sensor)
5. [Wiring the Mode Switch (GPIO19)](#wiring-the-mode-switch-gpio19)
6. [Full Wiring Diagram](#full-wiring-diagram)
7. [Arduino IDE Setup](#arduino-ide-setup)
8. [Installing the ESP32 Board Package](#installing-the-esp32-board-package)
9. [Installing Required Libraries](#installing-the-required-libraries)
10. [Configuring the Sketch](#configuring-the-sketch)
11. [Flashing the ESP32](#flashing-the-esp32)
12. [Reading the Serial Monitor](#reading-the-serial-monitor)
13. [Troubleshooting](#troubleshooting)

---

## Bill of Materials

| # | Component | Specification | Qty | Notes |
|---|---|---|---|---|
| 1 | **ESP32 development board** | NodeMCU ESP-32S v1.1 | 1 | Based on ESP-WROOM-32 module |
| 2 | **DHT22 sensor** | AM2302 | 1 | Measures temperature + humidity |
| 3 | **LDR (photoresistor)** | GL5528 or equivalent | 1 | 10–20 kΩ in darkness |
| 4 | **Resistor** (DHT22 pull-up) | 10 kΩ | 1 | Between DHT22 DATA and VCC |
| 5 | **Resistor** (LDR divider) | 10 kΩ | 1 | Between LDR junction and GND |
| 6 | **Breadboard** | Full-size (830 tie-points) | 1 | Or prototype PCB |
| 7 | **Jumper wires** | Male–Male | ~10 | Assorted colours |
| 8 | **USB cable** | Micro-USB or USB-C | 1 | Matches your ESP32 board |
| 9 | **5V power supply** | USB adapter ≥ 500 mA | 1 | For permanent installation |
| 10 | **Jumper wire or switch** | Male–Male or SPST toggle | 1 | Mode switch: GPIO19 to GND for local server |

> **Tip**: The DHT22 is more accurate than the DHT11 (±0.5 °C vs ±2 °C) and measures a wider humidity range. Always prefer DHT22 for a home-monitoring application.

---

## Understanding the Circuits

### DHT22 — Single-Wire Digital

The DHT22 uses a **proprietary single-wire protocol**. It needs:
- **VCC** → 3.3 V (the ESP32 operates at 3.3 V logic; do NOT use 5 V)
- **GND** → Ground
- **DATA** → Any GPIO (we use GPIO 4)
- A **10 kΩ pull-up resistor** between DATA and VCC (keeps the line HIGH at idle)

The Adafruit DHT library handles the timing protocol internally.

### LDR — Analog Voltage Divider

An LDR (Light Dependent Resistor) changes resistance with light:
- **Bright light** → low resistance (~1 kΩ) → higher voltage at the junction
- **Darkness** → high resistance (~100 kΩ+) → lower voltage at the junction

We build a **voltage divider** with a fixed 10 kΩ resistor to convert resistance to a voltage that the ESP32 ADC can read (0–3.3 V → 0–4095 raw counts).

```
   3.3V
    │
   [LDR]        ← resistance drops as light increases
    │
    ├──────────► GPIO34 (ADC1_CH6) reads voltage here
    │
  [10kΩ]        ← fixed resistor to ground
    │
   GND
```

> **Why GPIO34?** GPIO34–GPIO39 are **input-only** pins on the ESP32 and are the designated ADC1 channels. ADC1 is preferred because ADC2 is shared with WiFi and gives unreliable readings when WiFi is active.

---

## Wiring the DHT22

The DHT22 (and its wired variant, the AM2302) has **4 pins** (or 3 on the pre-mounted module):

```
DHT22 / AM2302 Pinout (facing the sensor grid)
┌─────────────┐
│ [1] [2] [3] [4] │
└─────────────┘
  │    │    │   │
 VCC DATA NC GND
```

| DHT22 / AM2302 Pin | Wire Colour (suggested) | ESP32 Destination |
|---|---|---|
| 1 — VCC | Red | 3.3V pin |
| 2 — DATA | Yellow | GPIO4 |
| 3 — NC | — | Not connected |
| 4 — GND | Black | GND pin |

**Pull-up resistor**: Connect a **10 kΩ resistor** between DATA (pin 2) and VCC (pin 1).

> **Pre-wired module**: If you bought a "DHT22 module" (3 pins: VCC, DATA, GND) instead of the bare sensor, the pull-up resistor is already soldered on. No extra resistor needed.

---

## Wiring the SR505 (PIR Motion Sensor)

The SR505 is a mini PIR motion detector. It operates on 4.5V–20V power, but outputs safe 3.3V logic signals on its data pin, making it perfect for direct connection to the ESP32.

The SR505 has **3 pins** (usually labeled or referenced from the back):

```
SR505 Pinout (back view)
   ┌─────────┐
   │ ⊙   ⊙   ⊙ │
   └─────────┘
     │   │   │
    VCC OUT GND
```

| SR505 Pin | Wire Colour (suggested) | ESP32 Destination |
|---|---|---|
| VCC (Positive) | Red | VIN / 5V pin (provides 5V power) |
| OUT (Signal) | Green | GPIO14 |
| GND (Negative) | Black | GND |

No external resistors are required for the SR505 output pin.

---

## Wiring the LDR (Light Sensor)

The LDR itself has **no polarity** — either leg can go in either direction.

| Connection | Wire Colour (suggested) | Destination |
|---|---|---|
| LDR leg A | Orange | 3.3V pin |
| LDR leg B | Orange | GPIO34 **AND** one end of 10 kΩ resistor |
| 10 kΩ resistor other end | Black | GND pin |

The junction between LDR leg B and the resistor is the **signal point** connected to GPIO34.

---

## Wiring the Mode Switch (GPIO19)

GPIO19 selects whether the ESP32 sends data to the **remote Cloud Run server** (HTTPS) or a **local development server** (plain HTTP). It uses the ESP32's internal pull-up resistor, so no external components are needed.

| GPIO19 State | Server Target | Protocol |
|---|---|---|
| **Floating / HIGH** (default) | Remote Cloud Run | HTTPS (port 443) |
| **Tied to GND** | Local dev server | HTTP (port 8080) |

To switch to local mode, connect GPIO19 to GND with a jumper wire or a simple toggle switch. Remove the jumper (or flip the switch) to return to remote mode. The pin is read once at boot, so **you must reset the ESP32** after changing the jumper for it to take effect.

| Connection | Wire Colour (suggested) | Destination |
|---|---|---|
| Switch/Jumper Pin A | Blue | GPIO19 |
| Switch/Jumper Pin B | Black | GND |

---

## Full Wiring Diagram

```
NodeMCU ESP-32S v1.1 (38-pin, viewed from above)
═══════════════════════════════════════════════════════════════════

                   ┌─────────────────────────────┐
             3V3 ─►│ [■] 3V3             GND [■] ◄─── GND
              EN ──│ [ ] EN           GPIO23 [ ] │
          GPIO36 ──│ [ ] SENSOR_VP    GPIO22 [ ] │
          GPIO39 ──│ [ ] SENSOR_VN    GPIO01 [ ] ◄─── TXD0
  ADC ──► GPIO34 ──│ [■] GPIO34       GPIO03 [ ] ◄─── RXD0
          GPIO35 ──│ [ ] GPIO35       GPIO21 [ ] │
          GPIO32 ──│ [ ] GPIO32          GND [■] ◄─── GND
          GPIO33 ──│ [ ] GPIO33       GPIO19 [■] ◄─── MODE SWITCH
          GPIO25 ──│ [ ] GPIO25       GPIO18 [ ] │
  LED ARM GPIO26 ──│ [■] GPIO26       GPIO05 [ ] │
  INSERIM GPIO27 ──│ [■] GPIO27       GPIO17 [ ] │
  PIR ──► GPIO14 ──│ [■] GPIO14       GPIO16 [ ] │
          GPIO12 ──│ [ ] GPIO12       GPIO04 [■] ◄─── DHT DATA
             GND ──│ [■] GND          GPIO02 [ ] ─── LED
 BUTTON──►GPIO13 ──│ [■] GPIO13       GPIO15 [ ] │
             SD2 ──│ [ ] SD2             SD1 [ ] ─── MOSI
             SD3 ──│ [ ] SD3             SD0 [ ] ─── MISO
             CMD ──│ [ ] CMD             CLK [ ] ─── SCK
    5V ──►   VIN ──│ [■] VIN/5V          SD3 [ ] ─── FLASH
                   └──────────────┬──────────────┘
                                  │
                                [USB]

═══════════════════════════════════════════════════════════════════
DHT22 / AM2302 CONNECTIONS
═══════════════════════════════════════════════════════════════════

  ESP32 3V3 ──────────────────┬─── DHT22 VCC (pin 1)
                              │
                           [10kΩ]  ← pull-up resistor
                              │
  ESP32 GPIO4 ────────────────┴─── DHT22 DATA (pin 2)

  ESP32 GND  ─────────────────────── DHT22 GND (pin 4)

═══════════════════════════════════════════════════════════════════
SR505 PIR CONNECTIONS
═══════════════════════════════════════════════════════════════════

  ESP32 VIN (5V) ─────────────────── SR505 VCC

  ESP32 GPIO14   ─────────────────── SR505 OUT (Signal)

  ESP32 GND      ─────────────────── SR505 GND

═══════════════════════════════════════════════════════════════════
LDR CONNECTIONS (voltage divider)
═══════════════════════════════════════════════════════════════════

  ESP32 3V3 ──────────────────── LDR leg A

  LDR leg B ──────────┬───────── ESP32 GPIO34 (ADC input)
                      │
                   [10kΩ]       ← fixed resistor
                      │
  ESP32 GND ──────────┘

═══════════════════════════════════════════════════════════════════
═══════════════════════════════════════════════════════════════════
MANUAL TEST BUTTON CONNECTIONS
═══════════════════════════════════════════════════════════════════

  ESP32 GPIO13  ─────────────────── Button Pin A

  ESP32 GND     ─────────────────── Button Pin B (normally open)

═══════════════════════════════════════════════════════════════════
MODE SWITCH CONNECTIONS (local/remote server select)
═══════════════════════════════════════════════════════════════════

  GPIO19 uses the ESP32 internal pull-up resistor.
  Leave FLOATING (default) → remote Cloud Run server (HTTPS)
  Connect to GND           → local development server (HTTP)

  ESP32 GPIO19 ─────────────────── Switch/Jumper Pin A

  ESP32 GND    ─────────────────── Switch/Jumper Pin B

═══════════════════════════════════════════════════════════════════
```

> **Double-check before powering on**:
> - DHT22 / AM2302 VCC must go to 3.3V only (never connect to 5V).
> - SR505 PIR VCC must go to VIN (5V) since it requires at least 4.5V. Its OUT pin is safe to connect directly to GPIO14 (outputs 3.3V). Avoid GPIO12 — it is a strapping pin that can cause boot issues if pulled HIGH.
> - GPIO34 is input-only — correct, that is exactly what we want.
> - Pull-up resistor is between DATA and VCC on the DHT22 — not between DATA and GND.
> - The manual test button is wired directly between GPIO13 and GND. It utilizes the ESP32's internal input pull-up resistor, meaning it reads `HIGH` by default and pulls to `LOW` when pressed (active low). No external pull-up resistor is needed.
> - The mode switch on GPIO19 also uses the internal pull-up. Leave it floating for normal remote operation; bridge it to GND to send data to the local dev server instead.

---

## Arduino IDE Setup

1. **Download Arduino IDE 2.x** from [https://www.arduino.cc/en/software](https://www.arduino.cc/en/software)
2. Install it following the installer prompts for your OS (Windows / macOS / Linux).
3. Launch Arduino IDE.

---

## Installing the ESP32 Board Package

The official Espressif board package adds ESP32 support to Arduino IDE.

1. Open **File → Preferences** (macOS: **Arduino IDE → Settings**).
2. In the **"Additional boards manager URLs"** field, paste:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Click **OK**.
4. Open **Tools → Board → Boards Manager**.
5. Search for **`esp32`**.
6. Find **"esp32 by Espressif Systems"** and click **Install** (≥ version 2.0.14).
7. Wait for the download (it's ~200 MB — includes the compiler toolchain).

**Select your board:**
- **Tools → Board → esp32 → NodeMCU-32S** (matches the NodeMCU ESP-32S v1.1 pin configuration)
- Alternatively, select **ESP32 Dev Module** as a generic option.

**Select your port:**
- Plug in the ESP32 via USB.
- **Tools → Port** → select the port that appears (e.g., `/dev/ttyUSB0` on Linux, `COM3` on Windows, `/dev/cu.usbserial-...` on macOS).

> **Linux note**: If the port doesn't appear, you may need to add your user to the `dialout` group:
> ```bash
> sudo usermod -aG dialout $USER
> # Log out and back in for this to take effect
> ```

---

## Installing Required Libraries

Install these three libraries via **Tools → Manage Libraries**:

### 1. DHT sensor library (Adafruit)

1. Search for **`DHT sensor library`**.
2. Find **"DHT sensor library" by Adafruit** — click **Install**.
3. When prompted to install dependencies, click **"Install All"** (this also installs Adafruit Unified Sensor).

### 2. Adafruit Unified Sensor

Usually installed automatically above. If not:
1. Search for **`Adafruit Unified Sensor`**.
2. Find **"Adafruit Unified Sensor" by Adafruit** — click **Install**.

### 3. ArduinoJson (version 6)

> ⚠️ **Important**: Install version **6.x**, not 7.x — the API changed significantly.

1. Search for **`ArduinoJson`**.
2. Find **"ArduinoJson" by Benoit Blanchon**.
3. Click the **version dropdown** and select the latest **6.x.x** release.
4. Click **Install**.

**Verify installed libraries** via **Sketch → Include Library → Manage Libraries** — all three should show a tick mark.

---

## Configuring the Sketch

Before flashing, you must create your local configuration files. These are **never committed to Git**.

### Step 1 — Create `config.h`

```bash
cd /home/roberto/home_check/esp32-sensor
cp config.h.example config.h
```

Open `config.h` and fill in:

```cpp
// ─── WiFi ────────────────────────────────────────────────────
#define WIFI_SSID      "YourNetworkName"
#define WIFI_PASSWORD  "YourWiFiPassword"

// ─── Server ──────────────────────────────────────────────────
// Remote: Cloud Run endpoint (used when GPIO19 is floating/HIGH)
#define SERVER_HOST_REMOTE  "home-check-server-xxxx-uc.a.run.app"
#define SERVER_PORT_REMOTE  443
// Local: development server (used when GPIO19 is tied to GND)
#define SERVER_HOST_LOCAL   "192.168.1.100"
#define SERVER_PORT_LOCAL   8080
#define SERVER_PATH         "/api/data"

// ─── Device identity ─────────────────────────────────────────
#define DEVICE_ID      "esp32-home-01"   // unique per device

// ─── GPIO pins ───────────────────────────────────────────────
#define DHT_PIN        4    // GPIO connected to DHT22 DATA
#define DHT_TYPE       DHT22
#define LDR_PIN        34   // GPIO connected to LDR junction

// ─── Timing ──────────────────────────────────────────────────
#define SAMPLE_INTERVAL_MS  60000UL  // read sensors every 60 s
#define REPORT_INTERVAL_MIN 5        // POST to server every 5 min
#define ROLLING_WINDOW      30       // 30-sample (30 min) window
```

### Step 2 — Create `secrets.h`

```bash
cp secrets.h.example secrets.h
```

Open `secrets.h` and fill in:

**HMAC Secret** — must be identical to `HMAC_SECRET_KEY` in the server's `.env`:
```cpp
#define HMAC_SECRET "paste-a-long-random-string-minimum-32-chars"
```

Generate a secure random secret on your computer:
```bash
# Linux / macOS
openssl rand -hex 32
```

**Root CA Certificate** — needed so the ESP32 can verify the Cloud Run TLS certificate:

```bash
# Run this after your Cloud Run service is deployed (you need the URL first)
openssl s_client -connect YOUR_CLOUD_RUN_HOST.run.app:443 -showcerts 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' \
  | tail -n +$(awk '/BEGIN CERTIFICATE/{n++} n==2{print NR; exit}' \
      <(openssl s_client -connect YOUR_CLOUD_RUN_HOST.run.app:443 -showcerts 2>/dev/null))
```

A simpler alternative — open Chrome, navigate to your Cloud Run URL, click the 🔒 padlock → **Connection is secure → Certificate is valid → Details**. Export the **root certificate** (the top item in the chain) as PEM and paste it into `secrets.h`:

```cpp
static const char ROOT_CA_CERT[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQsw
... (your full root CA cert here) ...
-----END CERTIFICATE-----
)EOF";
```

> **For Google Cloud Run**, the root CA is typically **"GTS Root R1"** or **"GlobalSign Root CA"**. You can also download it from [pki.goog](https://pki.goog/).

---

## Flashing the ESP32

1. Open `esp32-sensor.ino` in Arduino IDE (double-click the file, or **File → Open**).
2. Confirm the board and port are set correctly (**Tools** menu).
3. Click the **Upload button** (→ arrow icon) or press `Ctrl+U` / `Cmd+U`.
4. Arduino IDE will:
   - Compile the sketch (~30–60 seconds first time)
   - Put the ESP32 into flash mode automatically
   - Upload the binary over USB
5. You will see **"Done uploading."** in the bottom status bar.

> **If upload fails with "Failed to connect"**: Hold the **BOOT** button on the ESP32 while clicking Upload, then release it once the upload starts. Some boards require this on first flash.

---

## Reading the Serial Monitor

Open **Tools → Serial Monitor** (or press `Ctrl+Shift+M`). Set baud rate to **115200**.

You should see output like:

```
[SENSOR] Starting ESP32 Sensor Node...
[WIFI] Connecting to YourNetworkName
........
[WIFI] Connected.
[WIFI] IP address: 192.168.1.42
[WIFI] Syncing time via NTP...
[WIFI] Time synchronized successfully.
[MODE] REMOTE server selected (GPIO19 HIGH)
[SENSOR] Taking sample...
[SENSOR] Sample successful.
...
[HTTP] Preparing report...
[HTTP] Payload: {"device_id":"esp32-home-01","timestamp":1721308800,"window_minutes":30,...}
[HTTP] Connecting to: https://home-check-server-xxxx-uc.a.run.app/api/data
[HTTP] POST Result Code: 200
[HTTP] Report sent successfully.
```

### Log Prefixes Reference

| Prefix | Meaning |
|---|---|
| `[WIFI]` | WiFi connection, NTP time sync |
| `[MODE]` | Server mode selection (LOCAL or REMOTE) based on GPIO19 |
| `[SENSOR]` | DHT22 / LDR read, sample stored |
| `[HTTP]` | HTTP/HTTPS POST, response code |

### Common Serial Monitor Errors

| Message | Cause | Fix |
|---|---|---|
| `Failed to read from DHT sensor!` | Bad wiring or missing pull-up resistor | Check DHT22 wiring; add 10 kΩ pull-up |
| `[WIFI] Connection lost. Reconnecting...` | Intermittent WiFi | Normal; the sketch auto-reconnects |
| `[HTTP] Unable to connect to server` | Wrong `SERVER_HOST` or TLS cert issue | Verify `config.h`; check `ROOT_CA_CERT` |
| `POST Result Code: 401` | Wrong HMAC secret | Ensure `HMAC_SECRET` matches server `HMAC_SECRET_KEY` |
| `POST Result Code: 400` | Payload validation failed | Check ArduinoJson v6 is installed |

---

## Troubleshooting

### DHT22 always returns NaN

- The 10 kΩ pull-up resistor is missing or connected incorrectly.
- The sensor is connected to a 5 V pin — use 3.3 V only.
- The DHT22 needs at least 2 seconds between readings; the sketch enforces this via `SAMPLE_INTERVAL_MS`.

### LDR always reads 0 or 4095

- **Always 0**: LDR is short-circuited or the fixed resistor is missing.
- **Always 4095**: The fixed resistor is not connected to GND.
- Check the voltage divider wiring carefully.

### ESP32 not showing up as a COM port / serial device

- Install the **CP2102** or **CH340** USB-to-serial driver for your OS:
  - CP2102: [Silicon Labs driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers)
  - CH340: [CH340 driver](https://www.wch-ic.com/downloads/CH341SER_ZIP.html)
- Try a different USB cable (some cables are charge-only, no data).

### TLS certificate verification fails

- The `ROOT_CA_CERT` in `secrets.h` doesn't match the actual root CA for your Cloud Run URL.
- Use `openssl s_client` (see [Step 2](#step-2--create-secretsh)) to extract the correct cert.
- Alternatively, call `client->setInsecure()` **only during development** — remove it before production.

---

*Next: [Cloud Run Deployment Guide →](./02-cloud-run-deployment.md)*
