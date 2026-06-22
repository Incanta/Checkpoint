#!/usr/bin/env bash
# provision.sh: create the benchmark infrastructure on DigitalOcean via doctl.
#
# Creates a dedicated VPC, two droplets (server + client) inside it, and a
# block-storage volume attached to the client for the large working set. Waits
# for SSH on both droplets, then appends the resulting identifiers and IPs to
# the file named by $PROVISION_ENV_FILE (defaults to $GITHUB_ENV when run in
# GitHub Actions) as KEY=VALUE lines for later steps.
#
# Required env:
#   RUN_TAG            unique per-run tag, e.g. bench-<runid>-<attempt>-<vcs>
#   REGION             DO region slug (e.g. nyc3)
#   DROPLET_SIZE       DO size slug (e.g. c-8)
#   DATA_VOLUME_GB     size of the client data volume, in GiB
#   SSH_FINGERPRINT    fingerprint of the uploaded ephemeral SSH key
#
# doctl must already be authenticated (doctl auth init) before calling this.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

: "${RUN_TAG:?}" "${REGION:?}" "${DROPLET_SIZE:?}" "${DATA_VOLUME_GB:?}" "${SSH_FINGERPRINT:?}"

IMAGE="ubuntu-24-04-x64"
SERVER_NAME="${RUN_TAG}-server"
CLIENT_NAME="${RUN_TAG}-client"
VOLUME_NAME="${RUN_TAG}-data"
ENV_FILE="${PROVISION_ENV_FILE:-${GITHUB_ENV:-/dev/stdout}}"

emit() { echo "$1=$2" >>"$ENV_FILE"; }

log "creating VPC ${RUN_TAG} in ${REGION}"
# `doctl vpcs` is a top-level command and does not support --format/--no-header
# (unlike the `compute` subcommands), so request JSON and parse the id.
VPC_ID="$(doctl vpcs create --name "$RUN_TAG" --region "$REGION" -o json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(JSON.parse(d)[0].id)})')"
[ -n "$VPC_ID" ] || die "failed to create VPC"
emit VPC_ID "$VPC_ID"

log "creating ${DATA_VOLUME_GB}GiB data volume ${VOLUME_NAME}"
VOL_ID="$(doctl compute volume create "$VOLUME_NAME" --region "$REGION" \
  --size "${DATA_VOLUME_GB}GiB" --fs-type ext4 --format ID --no-header)"
emit VOL_ID "$VOL_ID"
emit VOLUME_NAME "$VOLUME_NAME"

log "creating droplets ${SERVER_NAME} and ${CLIENT_NAME} (size=${DROPLET_SIZE})"
# Create both droplets in one call; --wait blocks until they are active.
doctl compute droplet create "$SERVER_NAME" "$CLIENT_NAME" \
  --region "$REGION" --size "$DROPLET_SIZE" --image "$IMAGE" \
  --vpc-uuid "$VPC_ID" --ssh-keys "$SSH_FINGERPRINT" \
  --tag-name "$RUN_TAG" --wait \
  --format ID,Name --no-header >/dev/null

# Resolve IDs and IPs per droplet by name (avoids parsing the create output).
get_field() { # name field
  doctl compute droplet list --tag-name "$RUN_TAG" \
    --format "Name,$2" --no-header | awk -v n="$1" '$1==n {print $2}'
}

SERVER_ID="$(get_field "$SERVER_NAME" ID)"
CLIENT_ID="$(get_field "$CLIENT_NAME" ID)"
SERVER_PUBLIC_IP="$(get_field "$SERVER_NAME" PublicIPv4)"
SERVER_PRIVATE_IP="$(get_field "$SERVER_NAME" PrivateIPv4)"
CLIENT_PUBLIC_IP="$(get_field "$CLIENT_NAME" PublicIPv4)"

[ -n "$SERVER_PUBLIC_IP" ] || die "could not resolve server public IP"
[ -n "$SERVER_PRIVATE_IP" ] || die "could not resolve server private IP"
[ -n "$CLIENT_PUBLIC_IP" ] || die "could not resolve client public IP"

emit SERVER_ID "$SERVER_ID"
emit CLIENT_ID "$CLIENT_ID"
emit SERVER_PUBLIC_IP "$SERVER_PUBLIC_IP"
emit SERVER_PRIVATE_IP "$SERVER_PRIVATE_IP"
emit CLIENT_PUBLIC_IP "$CLIENT_PUBLIC_IP"

log "attaching volume ${VOLUME_NAME} to client (${CLIENT_ID})"
doctl compute volume-action attach "$VOL_ID" "$CLIENT_ID" --wait >/dev/null

# Export for wait_for_ssh in this process.
export SERVER_PUBLIC_IP CLIENT_PUBLIC_IP
wait_for_ssh "$SERVER_PUBLIC_IP"
wait_for_ssh "$CLIENT_PUBLIC_IP"

log "provisioning complete"
log "  server: public=${SERVER_PUBLIC_IP} private=${SERVER_PRIVATE_IP}"
log "  client: public=${CLIENT_PUBLIC_IP}"
