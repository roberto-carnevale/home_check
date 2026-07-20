#!/bin/bash
# This script creates secrets in Google Cloud Secret Manager based on the .env file.
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

gcloud secrets list --project=$PROJECT_ID