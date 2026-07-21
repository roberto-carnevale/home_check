# Cloud Run Deployment Guide

> **Goal**: Deploy the `cloud-run-server` Node.js application to Google Cloud Run, configure all required cloud services (Firestore, Secret Manager, SMTP, VAPID), and verify end-to-end operation with the ESP32.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Google Cloud Project Setup](#google-cloud-project-setup)
3. [Enable Required APIs](#enable-required-apis)
4. [Create a Firestore Database](#create-a-firestore-database)
5. [Generate VAPID Keys](#generate-vapid-keys)
6. [Configure Your Local Environment](#configure-your-local-environment)
7. [Store Secrets in Secret Manager](#store-secrets-in-secret-manager)
8. [Build and Push the Docker Image](#build-and-push-the-docker-image)
9. [Deploy to Cloud Run](#deploy-to-cloud-run)
10. [Configure the Service Account](#configure-the-service-account)
11. [Verify the Deployment](#verify-the-deployment)
12. [Update the ESP32 with the Server URL](#update-the-esp32-with-the-server-url)
13. [Set Up Continuous Deployment (Optional)](#set-up-continuous-deployment-optional)
14. [Monitoring and Logs](#monitoring-and-logs)
15. [Cost Estimate](#cost-estimate)
16. [Troubleshooting](#troubleshooting)

---

## Prerequisites

You need the following tools installed on your machine **before starting**:

| Tool | Purpose | Install |
|---|---|---|
| **Google Cloud SDK** (`gcloud`) | Manage Cloud resources from terminal | [cloud.google.com/sdk](https://cloud.google.com/sdk/docs/install) |
| **Docker Desktop** | Build the container image locally | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Node.js ≥ 20** | Run `npm` commands locally | [nodejs.org](https://nodejs.org/) |
| **`openssl`** | Generate keys, extract TLS certs | Pre-installed on Linux/macOS |

### Verify tools are installed

```bash
gcloud --version        # should print Google Cloud SDK x.x.x
docker --version        # should print Docker version x.x.x
node --version          # should print v20.x.x or higher
openssl version         # should print OpenSSL x.x.x
```

### Authenticate gcloud

```bash
# Log in to your Google account
gcloud auth login

# Set up Application Default Credentials (used by the server SDK locally)
gcloud auth application-default login
```

---

## Google Cloud Project Setup

### Option A — Use an existing project

```bash
# List your projects
gcloud projects list

# Set the project you want to use
gcloud config set project YOUR_PROJECT_ID
```

### Option B — Create a new project

```bash
# Choose a globally unique project ID (letters, numbers, hyphens)
export PROJECT_ID="home-check-$(openssl rand -hex 3)"

# Create the project
gcloud projects create $PROJECT_ID --name="Home Check"

# Set it as the active project
gcloud config set project $PROJECT_ID

# Link a billing account (required for Cloud Run)
# List your billing accounts first:
gcloud billing accounts list

# Link (replace BILLING_ACCOUNT_ID with the value from the list above)
gcloud billing projects link $PROJECT_ID \
  --billing-account=BILLING_ACCOUNT_ID
```

Save your project ID — you'll use it throughout this guide:

```bash
export PROJECT_ID=$(gcloud config get-value project)
echo "Project: $PROJECT_ID"
```

---

## Enable Required APIs

Google Cloud services must be explicitly enabled. Run this block once:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PROJECT_ID
```

This takes about 1–2 minutes. You'll see `Operation finished successfully` for each API.

---

## Create a Firestore Database

Firestore stores sensor readings and Web Push subscriptions.

### Via the Console (easiest)

1. Go to [console.cloud.google.com/firestore](https://console.cloud.google.com/firestore)
2. Select your project.
3. Click **"Create database"**.
4. Choose **"Native mode"** (not Datastore mode — they are incompatible).
5. Select a **region** close to you (e.g., `europe-west1`, `us-central1`).
6. Click **"Create database"**.

### Via the CLI

```bash
# Create Firestore in Native mode in europe-west1
# Change the location to match your Cloud Run region
gcloud firestore databases create \
  --location=europe-west1 \
  --type=firestore-native \
  --project=$PROJECT_ID
```

> **Region choice**: Pick the same region for Firestore and Cloud Run to minimise latency and avoid cross-region egress charges.

---

## Generate VAPID Keys

VAPID (Voluntary Application Server Identification) keys are required for Web Push notifications. You generate them once and store them as secrets.

```bash
cd /home/roberto/home_check/cloud-run-server

# Install dependencies first (needed for the web-push CLI)
npm install

# Generate a new VAPID keypair
npx web-push generate-vapid-keys
```

Output looks like this:

```
=======================================

Public Key:
BExAMP1e_PUBLIC_KEY_HERE_ABCDEFGHIJ...

Private Key:
xYzAbCdEf_PRIVATE_KEY_HERE_123456...

=======================================
```

**Copy both keys** — you need them in the next step. The public key also goes into the dashboard's `app.js` (the server handles this automatically via `VAPID_PUBLIC_KEY` env var).

---

## Configure Your Local Environment

Create your local `.env` file from the template:

```bash
cd /home/roberto/home_check/cloud-run-server
cp .env.example .env
```

Open `.env` and fill in all values:

```bash
# ─── Server ──────────────────────────────────────────────────
PORT=8080
NODE_ENV=production

# ─── Security ────────────────────────────────────────────────
# Generate with: openssl rand -hex 32
# Must match HMAC_SECRET in esp32-sensor/secrets.h
HMAC_SECRET_KEY=paste_your_64_char_hex_secret_here

# Set after deploy — the Cloud Run service URL
ALLOWED_ORIGIN=https://YOUR_SERVICE_URL.run.app

# ─── Firebase / Firestore ────────────────────────────────────
# Not needed when running on Cloud Run (uses Workload Identity)
# Needed for local development:
GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/service-account.json

# ─── Email Alerts ────────────────────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your.email@gmail.com
# Gmail: create an App Password at https://myaccount.google.com/apppasswords
# (requires 2FA to be enabled on the account)
SMTP_PASS=xxxx_xxxx_xxxx_xxxx

# Comma-separated list — all get alert emails
ALERT_EMAILS=you@example.com,partner@example.com

# ─── Web Push (VAPID) ────────────────────────────────────────
# From the 'npx web-push generate-vapid-keys' output above
VAPID_PUBLIC_KEY=BExAMP1e_PUBLIC_KEY_HERE
VAPID_PRIVATE_KEY=xYzAbCdEf_PRIVATE_KEY_HERE
VAPID_SUBJECT=mailto:your.email@gmail.com
```

### Test locally

```bash
npm start
# Visit http://localhost:8080 — you should see the dashboard
```

---

## Store Secrets in Secret Manager

For production, secrets must **not** be stored as plain environment variables in the Cloud Run definition — they go into **Google Secret Manager** and are mounted at runtime.

### Create each secret

```bash
# Load your .env for reference
source .env

# Helper function to create a secret
create_secret() {
  local name=$1
  local value=$2
  echo -n "$value" | gcloud secrets create "$name" \
    --data-file=- \
    --project=$PROJECT_ID 2>/dev/null \
  || echo -n "$value" | gcloud secrets versions add "$name" \
    --data-file=- \
    --project=$PROJECT_ID
}

# Create all secrets
create_secret "home-check-hmac-secret"      "$HMAC_SECRET_KEY"
create_secret "home-check-smtp-host"        "$SMTP_HOST"
create_secret "home-check-smtp-port"        "$SMTP_PORT"
create_secret "home-check-smtp-user"        "$SMTP_USER"
create_secret "home-check-smtp-pass"        "$SMTP_PASS"
create_secret "home-check-alert-emails"     "$ALERT_EMAILS"
create_secret "home-check-vapid-public"     "$VAPID_PUBLIC_KEY"
create_secret "home-check-vapid-private"    "$VAPID_PRIVATE_KEY"
create_secret "home-check-vapid-subject"    "$VAPID_SUBJECT"
create_secret "home-check-allowed-origin"   "$ALLOWED_ORIGIN"
```

Verify the secrets exist:

```bash
gcloud secrets list --project=$PROJECT_ID
```

---

## Build and Push the Docker Image

### Create an Artifact Registry repository

```bash
# Create a Docker repository in the same region as Cloud Run
gcloud artifacts repositories create home-check \
  --repository-format=docker \
  --location=europe-west1 \
  --description="Home Check Docker images" \
  --project=$PROJECT_ID
```

### Authenticate Docker with Artifact Registry

```bash
gcloud auth configure-docker europe-west1-docker.pkg.dev
```

### Build and push the image

```bash
cd /home/roberto/home_check/cloud-run-server

# Set the image path
export IMAGE="europe-west1-docker.pkg.dev/$PROJECT_ID/home-check/server:latest"

# Build the image (uses your Dockerfile)
docker build -t $IMAGE .

# Push to Artifact Registry
docker push $IMAGE
```

> **Apple Silicon (M1/M2/M3) users**: Add `--platform linux/amd64` to the build command, since Cloud Run runs on x86-64:
> ```bash
> docker build --platform linux/amd64 -t $IMAGE .
> ```

---

## Deploy to Cloud Run

You can use the included `deploy.sh` script (after configuring it), or run the deploy command directly.

### Using deploy.sh (recommended)

Review the script first:

```bash
cat /home/roberto/home_check/cloud-run-server/deploy.sh
```

Then run it with your environment variables set:

```bash
export GOOGLE_CLOUD_PROJECT=$PROJECT_ID
export IMAGE="europe-west1-docker.pkg.dev/$PROJECT_ID/home-check/server:latest"
export REGION="europe-west1"

bash /home/roberto/home_check/cloud-run-server/deploy.sh
```

### Manual deploy command

If you prefer to run it yourself:

```bash
gcloud run deploy home-check-server \
  --image="europe-west1-docker.pkg.dev/$PROJECT_ID/home-check/server:latest" \
  --region=europe-west1 \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=256Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --set-secrets="\
HMAC_SECRET_KEY=home-check-hmac-secret:latest,\
SMTP_HOST=home-check-smtp-host:latest,\
SMTP_PORT=home-check-smtp-port:latest,\
SMTP_USER=home-check-smtp-user:latest,\
SMTP_PASS=home-check-smtp-pass:latest,\
ALERT_EMAILS=home-check-alert-emails:latest,\
VAPID_PUBLIC_KEY=home-check-vapid-public:latest,\
VAPID_PRIVATE_KEY=home-check-vapid-private:latest,\
VAPID_SUBJECT=home-check-vapid-subject:latest,\
ALLOWED_ORIGIN=home-check-allowed-origin:latest" \
  --project=$PROJECT_ID
```

At the end of deployment you will see:

```
Service [home-check-server] revision [home-check-server-00001-abc]
has been deployed and is serving 100 percent of traffic.

Service URL: https://home-check-server-xxxx-uc.a.run.app
```

**Copy the Service URL** — you need it in the next two steps.

### Update ALLOWED_ORIGIN secret with the real URL

```bash
export SERVICE_URL="https://home-check-server-xxxx-uc.a.run.app"  # replace with your URL

echo -n "$SERVICE_URL" | gcloud secrets versions add home-check-allowed-origin \
  --data-file=- \
  --project=$PROJECT_ID

# Redeploy so the new secret value takes effect
gcloud run services update home-check-server \
  --region=europe-west1 \
  --project=$PROJECT_ID
```

---

## Configure the Service Account

The Cloud Run service runs as a service account that needs permission to read secrets and write to Firestore.

### Get the service account email

```bash
gcloud run services describe home-check-server \
  --region=europe-west1 \
  --format="value(spec.template.spec.serviceAccountName)" \
  --project=$PROJECT_ID
```

If it returns empty, the service uses the **default compute service account**:

```bash
export SA_EMAIL="$(gcloud projects describe $PROJECT_ID \
  --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
echo "Service account: $SA_EMAIL"
```

### Grant required IAM roles

```bash
# Permission to read/write Firestore
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/datastore.user"

# Permission to access Secret Manager secrets
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"
```

> **Recommended**: Create a dedicated service account with minimal permissions instead of using the default compute SA. This follows the principle of least privilege.
>
> ```bash
> # Create a dedicated SA
> gcloud iam service-accounts create home-check-sa \
>   --display-name="Home Check Server" \
>   --project=$PROJECT_ID
>
> export SA_EMAIL="home-check-sa@$PROJECT_ID.iam.gserviceaccount.com"
>
> # Grant roles to dedicated SA
> gcloud projects add-iam-policy-binding $PROJECT_ID \
>   --member="serviceAccount:$SA_EMAIL" \
>   --role="roles/datastore.user"
>
> gcloud projects add-iam-policy-binding $PROJECT_ID \
>   --member="serviceAccount:$SA_EMAIL" \
>   --role="roles/secretmanager.secretAccessor"
>
> # Redeploy using the dedicated SA
> gcloud run services update home-check-server \
>   --service-account=$SA_EMAIL \
>   --region=europe-west1 \
>   --project=$PROJECT_ID
> ```

---

## Verify the Deployment

### 1. Check the dashboard loads

```bash
# Open in your browser
echo "https://home-check-server-xxxx-uc.a.run.app"
```

You should see the dark-themed "Home Check" dashboard with three empty chart areas.

### 2. Test the data endpoint with curl

```bash
# Set variables
SERVICE_URL="https://home-check-server-xxxx-uc.a.run.app"
SECRET="your-hmac-secret-key"

# Build a test payload
PAYLOAD='{"device_id":"test-01","timestamp":0,"window_minutes":30,"temperature":{"min":20.0,"max":25.0,"avg":22.5},"humidity":{"min":45.0,"max":55.0,"avg":50.0},"light_raw":{"min":100,"max":900,"avg":500}}'

# Get current Unix timestamp
TS=$(date +%s)

# Compute SHA256 of body
BODY_HASH=$(echo -n "$PAYLOAD" | openssl dgst -sha256 | awk '{print $2}')

# Compute HMAC-SHA256 signature
SIG=$(echo -n "${TS}.${BODY_HASH}" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

# Send the POST request
curl -s -w "\nHTTP Status: %{http_code}\n" \
  -X POST "$SERVICE_URL/api/data" \
  -H "Content-Type: application/json" \
  -H "X-Timestamp: $TS" \
  -H "X-Signature: $SIG" \
  -d "$PAYLOAD"
```

Expected response:

```json
{"success":true}
HTTP Status: 200
```

### 3. Test HMAC rejection (wrong secret)

```bash
curl -s -w "\nHTTP Status: %{http_code}\n" \
  -X POST "$SERVICE_URL/api/data" \
  -H "Content-Type: application/json" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Signature: badc0de" \
  -d "$PAYLOAD"
```

Expected response:

```json
{"error":"Unauthorized"}
HTTP Status: 401
```

### 4. Test the watchdog

The watchdog fires after 95 minutes of silence. To test it quickly, you can temporarily reduce `TIMEOUT_MS` in `watchdog.js` to 60000 (1 minute), redeploy, wait, and then restore it.

#### Cloud Run scheduler support

Because Cloud Run can scale to zero when the service is idle, the in-process timer may not fire reliably after a long silence. This project now exposes a scheduler-friendly endpoint at `GET /api/watchdog`.

Use Cloud Scheduler or another periodic job to poll the endpoint every 10 minutes. If no new sensor reading arrives within 95 minutes, the endpoint triggers the watchdog alert and stores its alert state in Firestore.

Example scheduler job:

```bash
gcloud scheduler jobs create http home-check-watchdog-check \
  --schedule="*/10 * * * *" \
  --uri="https://<YOUR_SERVICE_URL>/api/watchdog" \
  --http-method=GET \
  --time-zone="UTC"
```

### 5. View Cloud Run logs

```bash
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=home-check-server" \
  --limit=50 \
  --format="value(textPayload)" \
  --project=$PROJECT_ID
```

Or open [Cloud Logging in the console](https://console.cloud.google.com/logs).

---

## Update the ESP32 with the Server URL

Now that the server is deployed, update `esp32-sensor/config.h`:

```cpp
// Remove the "https://" prefix — only the hostname goes here
#define SERVER_HOST "home-check-server-xxxx-uc.a.run.app"
#define SERVER_PORT 443
#define SERVER_PATH "/api/data"
```

And update `esp32-sensor/secrets.h` with:
- The same `HMAC_SECRET_KEY` value you stored in Secret Manager
- The root CA certificate extracted from the Cloud Run TLS chain (see the [Hardware Setup Guide](./01-hardware-setup.md#step-2--create-secretsh))

Then reflash the ESP32 and check the Serial Monitor for `POST Result Code: 200`.

---

## Set Up Continuous Deployment (Optional)

To auto-deploy on every push to `main`, use **Cloud Build**:

```bash
# In the cloud-run-server directory, create a cloudbuild.yaml
cat > /home/roberto/home_check/cloud-run-server/cloudbuild.yaml << 'EOF'
steps:
  # Build the Docker image
  - name: 'gcr.io/cloud-builders/docker'
    args:
      - build
      - -t
      - europe-west1-docker.pkg.dev/$PROJECT_ID/home-check/server:$COMMIT_SHA
      - -t
      - europe-west1-docker.pkg.dev/$PROJECT_ID/home-check/server:latest
      - .

  # Push to Artifact Registry
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', '--all-tags',
           'europe-west1-docker.pkg.dev/$PROJECT_ID/home-check/server']

  # Deploy to Cloud Run
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - run
      - deploy
      - home-check-server
      - --image=europe-west1-docker.pkg.dev/$PROJECT_ID/home-check/server:$COMMIT_SHA
      - --region=europe-west1
      - --platform=managed
      - --project=$PROJECT_ID

images:
  - europe-west1-docker.pkg.dev/$PROJECT_ID/home-check/server:$COMMIT_SHA
  - europe-west1-docker.pkg.dev/$PROJECT_ID/home-check/server:latest
EOF
```

Then connect your GitHub repository in [Cloud Build → Triggers](https://console.cloud.google.com/cloud-build/triggers).

---

## Monitoring and Logs

### Real-time log streaming

```bash
gcloud alpha run services logs tail home-check-server \
  --region=europe-west1 \
  --project=$PROJECT_ID
```

### Set up an uptime check (optional)

```bash
# Create an uptime check on the dashboard URL
gcloud monitoring uptime-checks create \
  --display-name="Home Check Server" \
  --resource-type=uptime_url \
  --hostname="home-check-server-xxxx-uc.a.run.app" \
  --path="/" \
  --project=$PROJECT_ID
```

### Key metrics to watch

| Metric | Where to find it |
|---|---|
| Request count / latency | Cloud Run → Metrics tab |
| Error rate (5xx) | Cloud Run → Metrics → Request count (filter by 5xx) |
| Cold start duration | Cloud Run → Metrics → Container startup latency |
| Firestore reads/writes | Firestore → Usage tab |

---

## Cost Estimate

With typical home-monitoring usage (1 ESP32 posting every 5 minutes):

| Service | Usage | Monthly Cost |
|---|---|---|
| Cloud Run | ~8,700 requests/month, 256 MB, <100ms each | **Free** (within free tier) |
| Firestore | ~8,700 writes + <1,000 reads/month | **Free** (within free tier) |
| Secret Manager | 6 secrets, ~1 access/cold-start | **~$0.006** |
| Artifact Registry | ~200 MB image storage | **~$0.04** |
| Cloud Build | First 120 build-minutes/day free | **Free** |
| **Total** | | **< $0.10/month** |

> Cloud Run scales to **zero instances** when idle — you only pay for actual request processing time.

---

## Troubleshooting

### `docker push` fails with "denied: Unauthenticated"

```bash
# Re-authenticate Docker with Artifact Registry
gcloud auth configure-docker europe-west1-docker.pkg.dev
```

### Cloud Run service crashes on startup (exit code 1)

Check the logs:
```bash
gcloud logging read \
  "resource.type=cloud_run_revision AND severity>=ERROR" \
  --limit=20 --format="value(textPayload)" --project=$PROJECT_ID
```

Common causes:
- A required environment variable is missing or misspelled
- The `HMAC_SECRET_KEY` secret has extra whitespace or newlines — use `echo -n` when creating secrets
- Firestore is in **Datastore mode** instead of **Native mode** — recreate the database

### Firestore permission denied

```bash
# Verify the service account has the role
gcloud projects get-iam-policy $PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:$SA_EMAIL" \
  --format="table(bindings.role)"
```

It should show `roles/datastore.user`.

### SMTP authentication fails (email not sent)

- Gmail requires an **App Password**, not your regular password. Enable at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) (requires 2-step verification).
- Port `587` with `STARTTLS` is the correct Gmail configuration.
- Check the server logs for `Error: Invalid login` messages.

### Web Push notifications not arriving

- Ensure the service worker (`sw.js`) is served over HTTPS — it won't register on HTTP.
- Check the browser console for service worker registration errors.
- Verify `VAPID_PUBLIC_KEY` in the server matches what was used to subscribe in `app.js`.
- Firestore subscriptions may have expired — have the user click "Subscribe to Notifications" again.

### Rate limit hit (429 Too Many Requests)

The server limits `/api/data` to **60 requests per 15 minutes per IP**. With a 5-minute posting interval this gives a comfortable 3 requests per 15 minutes — well within the limit. If you reduced `REPORT_INTERVAL_MIN` significantly, raise the `max` value in `index.js`.

---

*Previous: [← Hardware Setup Guide](./01-hardware-setup.md)*
