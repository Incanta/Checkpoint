#!/usr/bin/env bash
# run-benchmark.sh: drive a single VCS benchmark against the provisioned
# droplets and write timings.<vcs>.json.
#
# Expects the droplet coordinates in the environment (exported by
# lib/provision.sh): SERVER_PUBLIC_IP, SERVER_PRIVATE_IP, CLIENT_PUBLIC_IP,
# VOLUME_NAME. Plus the run configuration: TARBALL_URL, and (for the Spaces
# download) SPACES_ACCESS_KEY_ID / SPACES_SECRET_ACCESS_KEY.
#
# Usage:
#   run-benchmark.sh --vcs checkpoint --out timings.checkpoint.json
#
# The harness calls a fixed sequence of adapter functions. The operations that
# matter (add / commit / submit / pull, plus the ignore-file submit) are timed
# with whole-second precision; setup steps are not.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

VCS=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vcs) VCS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$VCS" ] || die "--vcs is required"
[ -n "$OUT" ] || OUT="timings.${VCS}.json"

ADAPTER="${SCRIPT_DIR}/adapters/${VCS}.sh"
[ -f "$ADAPTER" ] || die "no adapter for vcs '${VCS}' (expected ${ADAPTER})"

# Adapter metadata defaults; an adapter may override before/while sourced.
ADAPTER_SUPPORTS_COMMIT="false"

# Validate the coordinates the adapters depend on.
: "${SERVER_PUBLIC_IP:?provision did not set SERVER_PUBLIC_IP}"
: "${SERVER_PRIVATE_IP:?provision did not set SERVER_PRIVATE_IP}"
: "${CLIENT_PUBLIC_IP:?provision did not set CLIENT_PUBLIC_IP}"
: "${VOLUME_NAME:?provision did not set VOLUME_NAME}"
: "${TARBALL_URL:?TARBALL_URL not set}"
export SERVER_PUBLIC_IP SERVER_PRIVATE_IP CLIENT_PUBLIC_IP

# Repo root on the coordinator (one level up from benchmark/), and an optional
# version pin, both consumed by adapters.
export REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export CHECKPOINT_VERSION="${CHECKPOINT_VERSION:-}"

# Working tree location on the client's mounted data volume.
export WORK_DIR="/data/work"
export TREE_DIR="${WORK_DIR}/tree"        # extracted payload + repo lives here
export PULL_DIR="${WORK_DIR}/pull"        # fresh workspace for the final pull

# shellcheck source=/dev/null
source "$ADAPTER"

log "=== benchmark: ${VCS} ==="
log "server private=${SERVER_PRIVATE_IP} public=${SERVER_PUBLIC_IP}; client=${CLIENT_PUBLIC_IP}"

# ----------------------------------------------------------------------------
# Setup (untimed)
# ----------------------------------------------------------------------------
log "--- mounting client data volume ---"
prepare_client_storage

log "--- server setup ---"
adapter_server_setup

log "--- client setup ---"
adapter_client_setup

log "--- prepare payload (download + extract, timed separately) ---"
adapter_prepare_payload

log "--- create repo/workspace ---"
adapter_create_repo

# ----------------------------------------------------------------------------
# Benchmark (timed)
# ----------------------------------------------------------------------------
log "--- step: ignore file ---"
time_phase add_ignore -- adapter_add_ignore
time_phase submit_ignore -- adapter_submit_ignore

log "--- step: full tree ---"
time_phase add_all -- adapter_add_all
if [ "$ADAPTER_SUPPORTS_COMMIT" = "true" ]; then
  time_phase commit_all -- adapter_commit_all
else
  record_null_phase commit_all
fi
time_phase submit_all -- adapter_submit_all

log "--- step: pull into a fresh workspace ---"
time_phase pull_elsewhere -- adapter_pull_elsewhere

# ----------------------------------------------------------------------------
# Emit results
# ----------------------------------------------------------------------------
write_timings_json "$OUT" "$VCS"
log "=== benchmark complete: ${VCS} ==="
