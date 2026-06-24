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

# record_storage <name> <value>: a non-timing measurement (e.g. bytes), kept in
# its own group so it is never mixed into the timed phase table.
record_storage() { record_timing "storage" "$1" "$2"; }

# write_timings_json <out_file> <vcs>
# Emits { vcs, phases:{...}, payload:{...}, storage:{...}, meta:{...} } via Node.
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
    const phases = {}, payload = {}, storage = {};
    for (const line of rows) {
      const [group, name, value] = line.split("\t");
      const v = value === "null" ? null : Number(value);
      const bucket = group === "payload" ? payload : group === "storage" ? storage : phases;
      bucket[name] = v;
    }
    const out = {
      vcs: process.argv[1],
      phases,
      payload,
      storage,
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
copy_from_host() { # host remote_path local_path
  scp "${SSH_OPTS[@]}" "root@${1}:${2}" "${3}"
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
# Data volumes
#
# Each droplet gets its own attached DigitalOcean block-storage volume (the
# client's working set, the server's backend storage). A volume appears at a
# stable by-id path derived from its name. Format (once) and mount it at /data.
# ----------------------------------------------------------------------------

# _prepare_storage <runner-fn> <volume-name>: mount the named volume at /data on
# whichever droplet <runner-fn> (on_client_script / on_server_script) targets.
_prepare_storage() {
  local runner="$1" volname="$2"
  local dev="/dev/disk/by-id/scsi-0DO_Volume_${volname}"
  log "preparing /data from ${dev} (via ${runner})"
  "$runner" <<EOF
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

prepare_client_storage() {
  _prepare_storage on_client_script "${VOLUME_NAME:?VOLUME_NAME not set}"
}

prepare_server_storage() {
  _prepare_storage on_server_script "${SERVER_VOLUME_NAME:?SERVER_VOLUME_NAME not set}"
}

# ensure_client_swap <size_gb>: create + enable a swap file on the client so a
# memory-hungry client (e.g. the Lore CLI staging/committing a huge tree) spills
# to disk instead of being OOM-killed. No-op when size_gb is 0/empty. The swap
# file lives on the attached /data volume (guaranteed space). NOTE: swap is far
# slower than RAM, so any phase that actually touches it reports inflated timings;
# this is a "complete the run" lever, not a free one. Must run after /data is
# mounted (prepare_client_storage).
ensure_client_swap() { # size_gb
  local gb="${1:-0}"
  case "$gb" in '' | 0 | *[!0-9]*) return 0 ;; esac
  log "enabling ${gb}GiB swap on client (/data/swapfile) to avoid OOM kills"
  on_client "GB='${gb}' bash -seuo pipefail" <<'EOF'
if swapon --show=NAME --noheadings 2>/dev/null | grep -qx /data/swapfile; then
  echo "swap already enabled"; free -h; exit 0
fi
make_swap() { # method
  rm -f /data/swapfile
  if [ "$1" = fallocate ]; then
    fallocate -l "${GB}G" /data/swapfile
  else
    dd if=/dev/zero of=/data/swapfile bs=1M count="$((GB * 1024))" status=none
  fi
  chmod 600 /data/swapfile
  mkswap /data/swapfile >/dev/null && swapon /data/swapfile
}
# fallocate is instant on ext4; if the resulting file has holes (some setups),
# swapon rejects it, so fall back to a full dd-written file.
if ! make_swap fallocate 2>/dev/null; then
  echo "fallocate swapfile unusable; rebuilding with dd (slower)"
  swapoff /data/swapfile 2>/dev/null || true
  make_swap dd
fi
# Keep RAM as the fast path; only swap under genuine memory pressure.
sysctl -w vm.swappiness=10 >/dev/null 2>&1 || true
swapon --show; free -h
EOF
}

# ----------------------------------------------------------------------------
# Small-update storage measurement
# ----------------------------------------------------------------------------

# server_storage_bytes: actual disk usage (bytes) of the server's backend store.
# Adapters set SERVER_STORAGE_PATH to their store dir under /data; defaults to
# the whole server volume. Used to measure how much a tiny change costs on the
# server (delta/dedup efficiency), so it is NOT a timing measurement.
server_storage_bytes() {
  local path="${SERVER_STORAGE_PATH:-/data}"
  on_server "sync; du -sB1 '${path}' 2>/dev/null | cut -f1"
}

# client_append_bytes <abs_path> <count>: append <count> random bytes to a file
# on the client (the small change whose server-side storage cost we measure).
client_append_bytes() {
  on_client "head -c ${2} /dev/urandom >> '${1}'"
}

# ----------------------------------------------------------------------------
# System resource sampling (CPU% + RAM GB) during a phase
#
# A tiny detached sampler runs on a droplet and appends one JSON line per
# interval: { t: elapsed_s, cpu_pct: 0-100, ram_gb: used }. CPU% is derived from
# /proc/stat deltas (whole-system, all vCPUs); RAM is (MemTotal-MemAvailable).
# JSONL is robust to an abrupt kill. Both droplets write to the same remote path;
# the coordinator fetches each to a distinct local file.
# ----------------------------------------------------------------------------

start_resource_sampler() { # host remote_out pidfile interval
  local host="$1" out="$2" pidf="$3" interval="${4:-30}"
  log "starting resource sampler on ${host} (every ${interval}s)"
  _ssh "$host" "OUT='${out}' PIDF='${pidf}' INTERVAL='${interval}' bash -seuo pipefail" <<'EOF'
cat > /tmp/bench-sampler.sh <<'SAMP'
#!/usr/bin/env bash
out="$1"; interval="$2"
: > "$out"
snap() { awk '/^cpu /{tot=0; for (i=2; i<=NF; i++) tot+=$i; print tot, ($5 + $6)}' /proc/stat; }
read -r pt pi < <(snap)
start=$(date +%s)
while true; do
  sleep "$interval"
  read -r ct ci < <(snap)
  dt=$((ct - pt)); di=$((ci - pi)); pt=$ct; pi=$ci
  cpu=0; [ "$dt" -gt 0 ] && cpu=$(( ((dt - di) * 100) / dt ))
  used=$(awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END{printf "%.2f", (t - a) / 1048576}' /proc/meminfo)
  printf '{"t":%d,"cpu_pct":%d,"ram_gb":%s}\n' "$(( $(date +%s) - start ))" "$cpu" "$used" >> "$out"
done
SAMP
chmod +x /tmp/bench-sampler.sh
nohup /tmp/bench-sampler.sh "$OUT" "$INTERVAL" >/dev/null 2>&1 &
echo $! > "$PIDF"
EOF
}

stop_resource_sampler() { # host pidfile
  log "stopping resource sampler on ${1}"
  _ssh "$1" "PIDF='${2}' bash -seuo pipefail" <<'EOF' || true
[ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true
EOF
}

# finalize_resources <timings_json> <vcs> <interval>: read the fetched client and
# server JSONL, write a consolidated resources.<vcs>.json artifact, and embed the
# samples into the timings JSON (so summarize.js can chart them).
finalize_resources() { # timings_json vcs interval label_every
  local out="$1" vcs="$2" interval="${3:-30}" label_every="${4:-minute}"
  node -e '
    const fs = require("fs");
    const [timings, cf, sf, resOut, interval, labelEvery] = process.argv.slice(1);
    const rd = (p) => {
      try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
      catch { return []; }
    };
    // label_every controls the chart x-axis labeling in summarize.js:
    // "minute" labels only whole-minute marks, "sample" labels every sample.
    const res = {
      interval_s: Number(interval),
      label_every: labelEvery === "sample" ? "sample" : "minute",
      client: rd(cf),
      server: rd(sf),
    };
    fs.writeFileSync(resOut, JSON.stringify(res, null, 2) + "\n");
    try {
      const j = JSON.parse(fs.readFileSync(timings, "utf8"));
      j.resources = res;
      fs.writeFileSync(timings, JSON.stringify(j, null, 2) + "\n");
    } catch (e) {}
  ' "$out" "resources.${vcs}.client.jsonl" "resources.${vcs}.server.jsonl" "resources.${vcs}.json" "$interval" "$label_every"
  log "wrote resources.${vcs}.json (client + server samples)"
}

# ----------------------------------------------------------------------------
# Pull verification
#
# Cheap, deterministic fingerprint of the pulled tree to confirm every VCS
# actually materialized the full payload (and the same payload). It hashes a
# sorted "<relative path>\t<size>" manifest of every payload file, excluding VCS
# metadata dirs and per-VCS ignore/config files, so the same payload yields the
# same hash across all VCS. Metadata only (no byte reads), so it is cheap; it
# catches missing/truncated/extra files but not same-size byte corruption.
# ----------------------------------------------------------------------------

# compute_pull_manifest <remote_dir>: prints "<sha256> <file_count> <total_bytes>".
compute_pull_manifest() { # remote_dir
  on_client "DIR='${1}' bash -seuo pipefail" <<'EOF'
cd "${DIR}" 2>/dev/null || { echo "MISSING 0 0"; exit 0; }
manifest="$(find . \
  -type d \( -name .git -o -name .checkpoint -o -name .lore -o -name .ark -o -name .p4root \) -prune -o \
  -type f \
    ! -name .chkignore ! -name .loreignore ! -name .gitignore ! -name .gitattributes \
    ! -name .p4ignore ! -name .ark_ignore ! -name .ark_config ! -name .ark_lock \
    -printf '%P\t%s\n' \
  | LC_ALL=C sort)"
hash="$(printf '%s' "$manifest" | sha256sum | cut -d' ' -f1)"
count="$(printf '%s\n' "$manifest" | sed '/^$/d' | wc -l | tr -d ' ')"
bytes="$(printf '%s\n' "$manifest" | awk -F'\t' '{s+=$2} END{printf "%d", s}')"
printf '%s %s %s\n' "$hash" "$count" "$bytes"
EOF
}

# finalize_verify <timings_json> <hash> <count> <bytes>: embed the pull manifest
# fingerprint into the timings JSON for the summaries.
finalize_verify() { # timings_json hash count bytes
  node -e '
    const fs = require("fs");
    const [out, hash, count, bytes] = process.argv.slice(1);
    try {
      const j = JSON.parse(fs.readFileSync(out, "utf8"));
      j.verify = {
        pull_manifest_sha256: hash,
        pull_file_count: Number(count) || 0,
        pull_bytes: Number(bytes) || 0,
      };
      fs.writeFileSync(out, JSON.stringify(j, null, 2) + "\n");
    } catch (e) {}
  ' "$1" "$2" "$3" "$4"
}
