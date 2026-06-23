#!/usr/bin/env bash
# common.sh: shared helpers for the VCS benchmark harness.
#
# Sourced by run-benchmark.sh and the provisioning scripts. Provides:
#   - logging
#   - timing helpers that record durations (integer seconds) for later JSON emit
#   - SSH/SCP wrappers for driving the remote droplets
#   - a DigitalOcean Spaces URL parser
#   - a helper to format+mount the client data volume
#
# Everything here is plain bash (no jq); JSON is emitted with Node by the
# orchestrator / summarizer, matching the repo's Node-only preference.

set -euo pipefail

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------

log() {
  # Narrator line on stderr so it never pollutes captured stdout.
  echo "[$(date -u +%H:%M:%S)] $*" >&2
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# ----------------------------------------------------------------------------
# Timing
#
# Durations are accumulated into three parallel arrays so the orchestrator can
# emit an ordered JSON object without jq. Each entry has a group ("vcs" or
# "payload"), a name, and a value (integer seconds, or the literal "null" for
# operations a given VCS does not have, e.g. a separate local commit).
# ----------------------------------------------------------------------------

TIMING_GROUPS=()
TIMING_NAMES=()
TIMING_VALUES=()

record_timing() { # group name value
  TIMING_GROUPS+=("$1")
  TIMING_NAMES+=("$2")
  TIMING_VALUES+=("$3")
}

# _timed <group> <name> -- <cmd...>
# Runs the command, records its wall-clock duration in whole seconds.
_timed() {
  local group="$1" name="$2"
  shift 2
  [ "${1:-}" = "--" ] && shift
  local start end rc
  log "▶ phase start: ${name}"
  start=$(date +%s)
  "$@" && rc=0 || rc=$?
  end=$(date +%s)
  record_timing "$group" "$name" "$(( end - start ))"
  log "✓ phase done:  ${name} took $(( end - start ))s (rc=${rc})"
  return "$rc"
}

# time_phase <name> -- <cmd...>     (records under the "vcs" group)
time_phase() { _timed "vcs" "$@"; }

# payload_phase <name> -- <cmd...>  (records under the "payload" group)
payload_phase() { _timed "payload" "$@"; }

# record_null_phase <name>: for an operation a VCS does not support, so the
# output schema stays consistent across adapters.
record_null_phase() { record_timing "vcs" "$1" "null"; }

# write_timings_json <out_file> <vcs>
# Emits { vcs, phases:{...}, payload:{...}, meta:{...} } using Node.
write_timings_json() {
  local out="$1" vcs="$2"
  local meta_run_tag="${RUN_TAG:-}"
  local meta_region="${REGION:-}"
  local meta_size="${DROPLET_SIZE:-}"

  # Pass the parallel arrays to Node via a TSV on stdin: group<TAB>name<TAB>value
  {
    local i
    for i in "${!TIMING_NAMES[@]}"; do
      printf '%s\t%s\t%s\n' "${TIMING_GROUPS[$i]}" "${TIMING_NAMES[$i]}" "${TIMING_VALUES[$i]}"
    done
  } | node -e '
    const fs = require("fs");
    const rows = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
    const phases = {}, payload = {};
    for (const line of rows) {
      const [group, name, value] = line.split("\t");
      const v = value === "null" ? null : Number(value);
      (group === "payload" ? payload : phases)[name] = v;
    }
    const out = {
      vcs: process.argv[1],
      phases,
      payload,
      meta: {
        run_tag: process.argv[2] || null,
        region: process.argv[3] || null,
        droplet_size: process.argv[4] || null,
        recorded_at: new Date().toISOString(),
      },
    };
    fs.writeFileSync(process.argv[5], JSON.stringify(out, null, 2) + "\n");
  ' "$vcs" "$meta_run_tag" "$meta_region" "$meta_size" "$out"

  log "wrote timings to ${out}"
}

# ----------------------------------------------------------------------------
# SSH / SCP
#
# The coordinator reaches both droplets over their public IPs using the
# ephemeral key generated for this run. Host-key checking is disabled because
# the droplets are created fresh per run.
# ----------------------------------------------------------------------------

SSH_KEY="${SSH_KEY:-$HOME/.ssh/bench_key}"
# ServerAliveInterval/CountMax send keepalive probes during long-running remote
# commands that produce no output (e.g. extracting a 50GB tarball). Without
# them the TCP connection is torn down by an idle NAT/firewall and the command
# dies with "client_loop: send disconnect: Broken pipe" (rc=255). 30s probes,
# up to 240 missed before giving up -> tolerates ~2h of output silence.
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o ConnectTimeout=15 -o LogLevel=ERROR \
          -o ServerAliveInterval=30 -o ServerAliveCountMax=240)

_ssh() { # host cmd...
  local host="$1"; shift
  ssh "${SSH_OPTS[@]}" "root@${host}" "$@"
}

# Run a single command string on the server / client droplet.
on_server() { _ssh "${SERVER_PUBLIC_IP:?SERVER_PUBLIC_IP not set}" "$@"; }
on_client() { _ssh "${CLIENT_PUBLIC_IP:?CLIENT_PUBLIC_IP not set}" "$@"; }

# Run a multi-line script (read from stdin) on a droplet, with `set -euo
# pipefail` so remote failures propagate. Usage: on_client_script <<'EOF' ... EOF
on_server_script() { _ssh "${SERVER_PUBLIC_IP:?}" "bash -seuo pipefail"; }
on_client_script() { _ssh "${CLIENT_PUBLIC_IP:?}" "bash -seuo pipefail"; }

copy_to_client() { # local_path remote_path
  scp "${SSH_OPTS[@]}" -r "$1" "root@${CLIENT_PUBLIC_IP:?}:$2"
}
copy_to_server() { # local_path remote_path
  scp "${SSH_OPTS[@]}" -r "$1" "root@${SERVER_PUBLIC_IP:?}:$2"
}

# Poll until SSH on a host accepts a command (used after droplet creation).
wait_for_ssh() { # host [tries]
  local host="$1" tries="${2:-60}" i
  for (( i = 1; i <= tries; i++ )); do
    if _ssh "$host" "true" >/dev/null 2>&1; then
      log "ssh ready on ${host}"
      return 0
    fi
    log "  waiting for ssh on ${host}... (${i}/${tries})"
    sleep 5
  done
  die "ssh never became ready on ${host}"
}

# Wait until a freshly-booted droplet is done with its boot-time apt activity.
# cloud-init (and unattended-upgrades it triggers) holds the dpkg/apt lock for a
# while after SSH is reachable, so any apt use before this races and fails with
# "Could not get lock /var/lib/apt/lists/lock". Block on cloud-init completion
# and then on the dpkg frontend lock being free.
wait_for_apt() { # host
  local host="$1"
  log "waiting for cloud-init + apt lock on ${host}"
  _ssh "$host" "bash -seuo pipefail" <<'EOF'
cloud-init status --wait >/dev/null 2>&1 || true
for i in $(seq 1 60); do
  # -n: try once without blocking; succeeds (and immediately releases) only when
  # no other process holds the apt/dpkg frontend lock.
  if flock -n /var/lib/dpkg/lock-frontend true 2>/dev/null; then
    echo "apt is free"; exit 0
  fi
  echo "  apt busy, waiting... ($i/60)"; sleep 5
done
echo "apt lock still held after timeout" >&2; exit 1
EOF
}

# ----------------------------------------------------------------------------
# DigitalOcean Spaces URL parsing
#
# Accepts either virtual-hosted style:
#   https://<bucket>.<region>.digitaloceanspaces.com/<key...>
# or path style:
#   https://<region>.digitaloceanspaces.com/<bucket>/<key...>
# and exports SPACES_BUCKET, SPACES_KEY, SPACES_REGION, SPACES_ENDPOINT.
# A value in $SPACES_REGION_OVERRIDE (from config) wins for the region.
# ----------------------------------------------------------------------------

parse_spaces_url() { # url
  local url="$1"
  local rest host path
  rest="${url#*://}"
  host="${rest%%/*}"
  path="${rest#*/}"

  case "$host" in
    *.*.digitaloceanspaces.com)
      # virtual-hosted: bucket.region.digitaloceanspaces.com
      SPACES_BUCKET="${host%%.*}"
      local after="${host#*.}"
      SPACES_REGION="${after%%.digitaloceanspaces.com}"
      SPACES_KEY="$path"
      ;;
    *.digitaloceanspaces.com)
      # path-style: region.digitaloceanspaces.com/bucket/key
      SPACES_REGION="${host%%.digitaloceanspaces.com}"
      SPACES_BUCKET="${path%%/*}"
      SPACES_KEY="${path#*/}"
      ;;
    *)
      die "tarball_url is not a DigitalOcean Spaces URL: ${url}"
      ;;
  esac

  [ -n "${SPACES_REGION_OVERRIDE:-}" ] && SPACES_REGION="$SPACES_REGION_OVERRIDE"
  SPACES_ENDPOINT="https://${SPACES_REGION}.digitaloceanspaces.com"
  export SPACES_BUCKET SPACES_KEY SPACES_REGION SPACES_ENDPOINT
  log "spaces: bucket=${SPACES_BUCKET} region=${SPACES_REGION} key=${SPACES_KEY}"
}

# ----------------------------------------------------------------------------
# Client data volume
#
# The attached DigitalOcean block-storage volume appears at a stable by-id
# path derived from the volume name. Format (once) and mount it at /data.
# ----------------------------------------------------------------------------

prepare_client_storage() {
  local dev="/dev/disk/by-id/scsi-0DO_Volume_${VOLUME_NAME:?VOLUME_NAME not set}"
  log "preparing /data on client from ${dev}"
  on_client_script <<EOF
dev="${dev}"
for i in \$(seq 1 30); do [ -b "\$dev" ] && break; echo "waiting for volume device..."; sleep 2; done
[ -b "\$dev" ] || { echo "volume device \$dev not present"; exit 1; }
# Format only if it has no filesystem yet.
if ! blkid "\$dev" >/dev/null 2>&1; then
  mkfs.ext4 -F "\$dev"
fi
mkdir -p /data
mountpoint -q /data || mount -o discard,defaults "\$dev" /data
mkdir -p /data/work
df -h /data
EOF
}
