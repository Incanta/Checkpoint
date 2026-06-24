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
: "${SERVER_VOLUME_NAME:?provision did not set SERVER_VOLUME_NAME}"
: "${TARBALL_URL:?TARBALL_URL not set}"
export SERVER_PUBLIC_IP SERVER_PRIVATE_IP CLIENT_PUBLIC_IP

# On any non-zero exit (a failed phase aborts under `set -e`), grab droplet-side
# state before the workflow's teardown step destroys the droplets. This tells us
# whether a phase that died with the SSH transport code (rc=255) was actually an
# out-of-memory kill / disk-full on the droplet rather than a connection drop.
# Both droplets are still up here; teardown is a later, separate workflow step.
dump_diagnostics() {
  local rc=$?
  [ "$rc" -eq 0 ] && return 0
  log "!!! benchmark exited rc=${rc}; capturing droplet diagnostics before teardown"
  local entry label host
  for entry in "client:${CLIENT_PUBLIC_IP:-}" "server:${SERVER_PUBLIC_IP:-}"; do
    label="${entry%%:*}"; host="${entry#*:}"
    [ -n "$host" ] || continue
    log "----- diagnostics: ${label} (${host}) -----"
    _ssh "$host" "bash -s" <<'DIAG' 2>&1 || true
echo "== uptime / load =="; uptime
echo "== memory =="; free -h
echo "== disk =="; df -h /data / 2>/dev/null
echo "== OOM / kill events (dmesg) =="; dmesg 2>/dev/null | grep -iE 'out of memory|killed process|oom-kill' | tail -20
echo "== tail dmesg =="; dmesg 2>/dev/null | tail -20
DIAG
  done
}
trap dump_diagnostics EXIT

# Repo root on the coordinator (one level up from benchmark/), and an optional
# version pin, both consumed by adapters.
export REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export CHECKPOINT_VERSION="${CHECKPOINT_VERSION:-}"

# Working tree location on the client's mounted data volume.
export WORK_DIR="/data/work"
export TREE_DIR="${WORK_DIR}/tree"        # extracted payload + repo lives here
export PULL_DIR="${WORK_DIR}/pull"        # fresh workspace for the final pull

# Optional: relative path (under TREE_DIR) of a file to make a small change to
# after the initial submit, to measure the server-side storage cost of a tiny
# update. Empty -> the update stage is skipped.
export SMALL_CHANGE_FILE="${SMALL_CHANGE_FILE:-}"

# shellcheck source=/dev/null
source "$ADAPTER"

log "=== benchmark: ${VCS} ==="
log "server private=${SERVER_PRIVATE_IP} public=${SERVER_PUBLIC_IP}; client=${CLIENT_PUBLIC_IP}"

# ----------------------------------------------------------------------------
# Setup (untimed)
# ----------------------------------------------------------------------------
log "--- mounting data volumes ---"
prepare_client_storage
prepare_server_storage

log "--- server setup ---"
adapter_server_setup

log "--- client setup ---"
adapter_client_setup

log "--- prepare payload (download + extract, timed separately) ---"
adapter_prepare_payload

# Remove any VCS metadata the payload tarball carried so every adapter imports
# the same pristine file tree (keeps the comparison fair). A nested `.git` is
# especially harmful for the Gitea adapter: `git add -A` records such a
# subdirectory as a submodule gitlink pointing at the embedded repo's HEAD
# commit, which is not in our object store, so the push fails with
# "missing object: <sha>". Runs on the client (where the tree lives) before any
# adapter creates its own repo metadata.
log "--- stripping stray .git metadata from payload ---"
# Match `.git` whether it is a directory (embedded repo) or a file (submodule
# working-dir pointer); both make `git add -A` record a gitlink.
on_client "TREE_DIR='${TREE_DIR}' bash -seuo pipefail" <<'EOF'
n=$(find "${TREE_DIR}" -name .git | wc -l)
echo "stripping ${n} stray .git entr(ies) (dirs or submodule files) from the payload"
find "${TREE_DIR}" -name .git -prune -exec rm -rf {} +
EOF

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
# Small-update server-storage delta (untimed: storage only, never timing)
#
# Make a ~100-byte change to one file, submit it, and record how many bytes the
# server's backend store grew. This measures delta/dedup efficiency (chunk-level
# dedup vs whole-file re-store) and must not perturb the timing metrics, so the
# update runs outside any time_phase.
# ----------------------------------------------------------------------------
# Best-effort: a failure in this secondary metric (e.g. a VCS choking on a tiny
# change against a very large version) must NOT discard the primary timing
# results, which are already collected. Run it guarded; on any failure record
# n/a and continue to the JSON write. Called via `if !` so set -e is suspended
# inside and the explicit `|| return 1` controls the flow.
measure_small_update_delta() {
  local before after
  before="$(server_storage_bytes)" || return 1
  log "server storage before update: ${before} bytes"
  adapter_update || return 1
  # Let the server flush async writes (e.g. Lore's flush_delay) before measuring.
  on_server "sync" || true
  sleep "${STORAGE_SETTLE_SECONDS:-20}"
  after="$(server_storage_bytes)" || return 1
  log "server storage after update:  ${after} bytes"
  record_storage update_delta_bytes "$(( after - before ))"
}

if [ -n "${SMALL_CHANGE_FILE}" ]; then
  log "--- step: small update + server storage delta (${SMALL_CHANGE_FILE}) ---"
  if ! measure_small_update_delta; then
    log "!!! small-update storage delta failed (non-fatal); recording n/a and continuing"
    record_storage update_delta_bytes null
  fi
else
  log "--- skipping small update (config small_change_file is empty) ---"
fi

# ----------------------------------------------------------------------------
# Emit results
# ----------------------------------------------------------------------------
write_timings_json "$OUT" "$VCS"
log "=== benchmark complete: ${VCS} ==="
