#!/bin/bash
# obtain-cert.sh — Request initial LetsEncrypt certificate
# Run this after `docker compose up` when TLS_MODE=acme
#
# Usage:
#   ./scripts/obtain-cert.sh
#   ./scripts/obtain-cert.sh --staging   # Use LE staging for testing
#
# Prerequisites:
#   - docker compose services running (nginx must be serving port 80)
#   - CHECKPOINT_HOSTNAME and ACME_EMAIL set in .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  . "$PROJECT_DIR/.env"
  set +a
fi

DOMAIN="${CHECKPOINT_HOSTNAME:?CHECKPOINT_HOSTNAME must be set}"
EMAIL="${ACME_EMAIL:?ACME_EMAIL must be set}"
STAGING_FLAG=""

if [ "${1:-}" = "--staging" ] || [ "${ACME_STAGING:-false}" = "true" ]; then
  STAGING_FLAG="--staging"
  echo "Using LetsEncrypt STAGING environment"
fi

APP_DOMAIN="checkpoint.${DOMAIN}"
STORAGE_DOMAIN="checkpoint-storage.${DOMAIN}"

echo "Requesting certificate for:"
echo "  - ${APP_DOMAIN}"
echo "  - ${STORAGE_DOMAIN}"
echo "  Email: ${EMAIL}"
echo ""

docker compose -f "$PROJECT_DIR/docker-compose.prod.yaml" run --rm certbot \
  certonly --webroot \
  -w /var/www/certbot \
  -d "${APP_DOMAIN}" \
  -d "${STORAGE_DOMAIN}" \
  --email "${EMAIL}" \
  --agree-tos \
  --non-interactive \
  ${STAGING_FLAG}

echo ""
echo "Certificate obtained. Reloading nginx..."
docker compose -f "$PROJECT_DIR/docker-compose.prod.yaml" exec nginx nginx -s reload

echo "Done. HTTPS is now active for ${APP_DOMAIN} and ${STORAGE_DOMAIN}."
