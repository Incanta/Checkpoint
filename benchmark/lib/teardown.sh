#!/usr/bin/env bash
# teardown.sh: destroy everything provision.sh created. Idempotent and
# best-effort: it never fails the build, so it is safe in an `if: always()`
# step. It deletes by the explicit IDs exported during provisioning when
# present, and also sweeps by RUN_TAG as a backstop in case provisioning died
# partway through.
#
# Reads (all optional): SERVER_ID, CLIENT_ID, VOL_ID, VPC_ID, RUN_TAG,
# SSH_FINGERPRINT. doctl must be authenticated.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
# common.sh sets `set -e`; we deliberately keep going on errors here.
source "${SCRIPT_DIR}/common.sh" 2>/dev/null || true
set +e

try() { log "+ $*"; "$@" || log "  (ignored failure: $*)"; }

# 1. Droplets: by tag (covers both, even if an ID is missing).
if [ -n "${RUN_TAG:-}" ]; then
  try doctl compute droplet delete --tag-name "$RUN_TAG" --force
else
  [ -n "${SERVER_ID:-}" ] && try doctl compute droplet delete "$SERVER_ID" --force
  [ -n "${CLIENT_ID:-}" ] && try doctl compute droplet delete "$CLIENT_ID" --force
fi

# 2. Volume: must wait until the droplet release detaches it before delete.
if [ -n "${VOL_ID:-}" ]; then
  for i in $(seq 1 12); do
    doctl compute volume delete "$VOL_ID" --force && break
    log "  volume still attached, retrying delete ($i/12)..."
    sleep 10
  done
fi

# 3. VPC: only deletable once it has no members; retry after droplets drain.
if [ -n "${VPC_ID:-}" ]; then
  for i in $(seq 1 12); do
    doctl vpcs delete "$VPC_ID" --force && break
    log "  vpc not empty yet, retrying delete ($i/12)..."
    sleep 10
  done
fi

# 4. Ephemeral SSH key registered with DO.
if [ -n "${SSH_FINGERPRINT:-}" ]; then
  try doctl compute ssh-key delete "$SSH_FINGERPRINT" --force
fi

log "teardown finished"
exit 0
