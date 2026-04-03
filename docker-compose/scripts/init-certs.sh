#!/bin/bash
# init-certs.sh — Initialize TLS certificates and generate nginx config
# Used as the nginx container entrypoint in docker-compose.prod.yaml
#
# Environment variables:
#   TLS_MODE            - "none", "acme", or "custom" (default: none)
#   CHECKPOINT_HOSTNAME - Base domain (e.g., example.com)
#   CUSTOM_CERT_DIR     - Path to custom certs (only for TLS_MODE=custom)

set -euo pipefail

TLS_MODE="${TLS_MODE:-none}"
CHECKPOINT_HOSTNAME="${CHECKPOINT_HOSTNAME:?CHECKPOINT_HOSTNAME must be set}"
SSL_DIR="/etc/nginx/ssl"
CERTBOT_LIVE="/etc/letsencrypt/live/checkpoint.${CHECKPOINT_HOSTNAME}"

echo "[init-certs] TLS_MODE=${TLS_MODE}, domain=${CHECKPOINT_HOSTNAME}"

mkdir -p "$SSL_DIR"

case "$TLS_MODE" in
  acme)
    # If real certs exist from a prior certbot run, symlink them
    if [ -f "${CERTBOT_LIVE}/fullchain.pem" ]; then
      echo "[init-certs] Found existing LetsEncrypt certs, linking..."
      ln -sf "${CERTBOT_LIVE}/fullchain.pem" "${SSL_DIR}/fullchain.pem"
      ln -sf "${CERTBOT_LIVE}/privkey.pem" "${SSL_DIR}/privkey.pem"
    else
      # Generate a self-signed dummy cert so nginx can start with TLS
      # and serve ACME HTTP-01 challenges. certbot will replace this.
      echo "[init-certs] No LetsEncrypt certs yet, generating dummy cert..."
      openssl req -x509 -nodes -newkey rsa:2048 \
        -keyout "${SSL_DIR}/privkey.pem" \
        -out "${SSL_DIR}/fullchain.pem" \
        -subj "/CN=localhost" \
        -days 1 2>/dev/null
    fi

    echo "[init-certs] Using TLS template"
    envsubst '${CHECKPOINT_HOSTNAME}' \
      < /etc/nginx/nginx.conf.prod-tls-template \
      > /etc/nginx/nginx.conf
    ;;

  custom)
    CUSTOM_CERT_DIR="${CUSTOM_CERT_DIR:-/certs}"

    if [ ! -f "${CUSTOM_CERT_DIR}/fullchain.pem" ] || [ ! -f "${CUSTOM_CERT_DIR}/privkey.pem" ]; then
      echo "[init-certs] ERROR: Custom cert mode but missing files:"
      echo "  Expected: ${CUSTOM_CERT_DIR}/fullchain.pem"
      echo "  Expected: ${CUSTOM_CERT_DIR}/privkey.pem"
      exit 1
    fi

    echo "[init-certs] Linking custom certs from ${CUSTOM_CERT_DIR}"
    ln -sf "${CUSTOM_CERT_DIR}/fullchain.pem" "${SSL_DIR}/fullchain.pem"
    ln -sf "${CUSTOM_CERT_DIR}/privkey.pem" "${SSL_DIR}/privkey.pem"

    echo "[init-certs] Using TLS template"
    envsubst '${CHECKPOINT_HOSTNAME}' \
      < /etc/nginx/nginx.conf.prod-tls-template \
      > /etc/nginx/nginx.conf
    ;;

  none|*)
    echo "[init-certs] TLS disabled, using HTTP-only template"
    envsubst '${CHECKPOINT_HOSTNAME}' \
      < /etc/nginx/nginx.conf.prod-template \
      > /etc/nginx/nginx.conf
    ;;
esac

echo "[init-certs] nginx config generated, starting nginx..."

# Start nginx with periodic reload (picks up renewed certs)
# Reload every 6 hours in the background, then run nginx in foreground
(while :; do sleep 6h; nginx -s reload 2>/dev/null || true; done) &

exec nginx -g "daemon off;"
