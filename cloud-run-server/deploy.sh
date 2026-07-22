#!/usr/bin/env bash

# Enable strict error handling
# -e: Exit immediately if a pipeline returns a non-zero status
# -u: Treat unset variables as an error
# -o pipefail: Pipeline fails if any command in the pipe fails
set -euo pipefail

# Print a starting message to the console
# This helps the user know the deployment has begun
echo "Starting deployment of Home Check Server to Cloud Run..."

# Check if the gcloud CLI tool is installed
# It is required for deployment to Google Cloud
if ! command -v gcloud &> /dev/null; then
    echo "Error: gcloud CLI is not installed or not in PATH."
    exit 1
fi

# Ensure the GOOGLE_CLOUD_PROJECT environment variable is set
# This tells gcloud which project to deploy to
if [ -z "${GOOGLE_CLOUD_PROJECT:-}" ]; then
    echo "Error: GOOGLE_CLOUD_PROJECT environment variable is not set."
    exit 1
fi

# Set the current active project for the gcloud CLI
# This applies the project explicitly for the upcoming commands
gcloud config set project "$GOOGLE_CLOUD_PROJECT"

# Define the name of our Cloud Run service
# This will be part of the final URL
SERVICE_NAME="home-check-server"

# Define the region where the service will be hosted
# us-central1 is a good default, but can be changed as needed
REGION="europe-west1"

# Deploy the application using Google Cloud Build and Cloud Run
# --source . builds the Dockerfile in the current directory
# --allow-unauthenticated makes the endpoint publicly accessible
# Note: Ensure Secret Manager contains the referenced secrets before deploying
echo "Building and deploying the image..."
gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --region "$REGION" \
    --allow-unauthenticated \
    --update-secrets=HMAC_SECRET_KEY=home-check-hmac-secret:latest,SESSION_SECRET=home-check-session-secret:latest,SMTP_PASS=home-check-smtp-pass:latest,VAPID_PRIVATE_KEY=home-check-vapid-private:latest,VAPID_PUBLIC_KEY=home-check-vapid-public:latest,VAPID_SUBJECT=home-check-vapid-subject:latest,ALERT_EMAILS=home-check-alert-emails:latest,SMTP_USER=home-check-smtp-user:latest,SMTP_HOST=home-check-smtp-host:latest,SMTP_PORT=home-check-smtp-port:latest,WATCHDOG_TOKEN=home-check-watchdog-token:latest

# Retrieve the final URL of the deployed service
# We query the service details and format the output as the URL string
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
    --region "$REGION" \
    --format "value(status.url)")

# Set ALLOWED_ORIGIN to the actual service URL (not wildcard)
# The dashboard and API share the same origin, so only this URL is needed
echo "Setting ALLOWED_ORIGIN to ${SERVICE_URL}..."
gcloud run services update "$SERVICE_NAME" \
    --region "$REGION" \
    --update-env-vars "ALLOWED_ORIGIN=${SERVICE_URL}"

# Print a success message with the final URL
# The user can now visit this URL to view their dashboard
echo "Deployment successful!"
echo "Your service is available at: $SERVICE_URL"
