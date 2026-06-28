#!/usr/bin/env bash
# Checkpoint VCS adapter.
#
# Server: the repo's docker-compose bundle (app :13000, server :13001,
#   postgres). With no pinned version (the HEAD path) the app + server images
#   are BUILT from the shipped HEAD source so they match the HEAD client; with
#   a pinned CHECKPOINT_VERSION the released GHCR images are pulled instead.
#   Storage stays in the default "local" mode (the core server stores blocks on
#   its own disk and serves them through the gateway; no external store).
# Client: built from source on the droplet (CLI via CMake + daemon via Node),
#   mirroring the proven .github/workflows/test.yaml flow. The published .deb
#   is not used because releases are drafts with non-anonymous asset URLs.
#
# Building the server from HEAD (not just the client) is required because the
# daemon and app are version-coupled: the daemon calls app tRPC procedures
# (e.g. changelist.diffChangelists) that only exist at HEAD, so a HEAD client
# against a released `latest` app fails with "No procedure found" (HTTP 500).
# Auth: headless, via the app's devLogin (enabled in the deployed config) to
#   mint an API token, then ~/.checkpoint/auth.json on the client, exactly as
#   test.yaml does.
#
# Checkpoint has no separate local "commit": staging is `chk add`, publishing
# is `chk submit`. So commit_all is left unsupported (recorded as null).

ADAPTER_SUPPORTS_COMMIT="false"

# Remote paths on the client droplet.
SRC_DIR="/opt/checkpoint-src"
CHK="${SRC_DIR}/src/clients/cli/build/chk"
DAEMON_DIR="${SRC_DIR}/src/core/daemon"

# Server-side source checkout (used only when building images from HEAD).
SERVER_SRC_DIR="/opt/checkpoint-src"

# Image tags the docker-compose bundle references for the default (unpinned)
# run. When CHECKPOINT_VERSION is empty we build these tags locally from HEAD;
# when it is set we rewrite the compose file to the pinned tags and pull.
APP_IMAGE="ghcr.io/incanta/checkpoint-app:latest-sqlite"
SERVER_IMAGE="ghcr.io/incanta/checkpoint-server:latest"

# Server-side backend storage lives under Docker's data-root (relocated to the
# server volume); used to measure the small-update storage delta.
SERVER_STORAGE_PATH="/data/docker"

# Checkpoint identifiers used for the benchmark.
ORG_NAME="bench-org"
REPO_NAME="bench-repo"
DAEMON_ID="bench-daemon"
DEV_EMAIL="bench@checkpoint.dev"

# Endpoints. The coordinator talks to the public IP; the client/daemon talk to
# the private IP over the VPC.
APP_PUBLIC="http://${SERVER_PUBLIC_IP}:13000"
APP_PRIVATE="http://${SERVER_PRIVATE_IP}:13000"

# Extract a dotted path (supporting numeric array indices) from JSON on stdin.
# Usage: echo "$resp" | json_get "0.result.data.json.apiToken"
json_get() {
  node -e '
    let d = "";
    process.stdin.on("data", c => d += c).on("end", () => {
      try {
        const j = JSON.parse(d);
        let v = j;
        for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
        process.stdout.write(v == null ? "" : String(v));
      } catch { process.exit(1); }
    });
  ' "$1"
}

# ----------------------------------------------------------------------------
# Server
# ----------------------------------------------------------------------------
adapter_server_setup() {
  log "installing docker on server"
  on_server_script <<'EOF'
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker --version
docker compose version
EOF

  log "relocating docker data-root to the server volume (/data)"
  # The compose stack stores its data in named volumes (the big one is the
  # server's storage-data). Point Docker's data-root at the attached server
  # volume so a full submit lands on /data, not the small base disk. Done before
  # any image pull / container start so nothing has to migrate.
  on_server_script <<'EOF'
mkdir -p /data/docker /etc/docker
cat > /etc/docker/daemon.json <<JSON
{ "data-root": "/data/docker" }
JSON
systemctl restart docker
docker info --format 'docker data-root: {{.DockerRootDir}}'
EOF

  log "copying docker-compose bundle to server"
  on_server "rm -rf /opt/checkpoint-compose && mkdir -p /opt/checkpoint-compose"
  # Ship only the tracked docker-compose subtree; --strip-components drops the
  # leading docker-compose/ path. The gitignored config/.secrets is excluded
  # (we generate it below).
  git -C "${REPO_ROOT}" archive --format=tar HEAD docker-compose \
    | on_server "tar x -C /opt/checkpoint-compose --strip-components=1"

  log "templating server config (private IP, secrets, dev-login, version)"
  # Pass the values the remote needs as positional args to the heredoc shell.
  on_server "PRIVATE_IP='${SERVER_PRIVATE_IP}' VERSION='${CHECKPOINT_VERSION:-}' bash -seuo pipefail" <<'EOF'
cd /opt/checkpoint-compose

# Point every IP_ADDRESS placeholder at the server's private (VPC) IP so the
# client reaches the app and storage backend over the private network.
grep -rl IP_ADDRESS config | while read -r f; do
  sed -i "s/IP_ADDRESS/${PRIVATE_IP}/g" "$f"
done

# Secrets: random auth/signing keys + the postgres URL the compose file uses.
mkdir -p config
cat > config/.secrets <<SECRETS
betterauth_secret=$(openssl rand -hex 32)
storage_signing_key=$(openssl rand -hex 32)
database_url=file:///app/data/db.sqlite
SECRETS

# Enable the headless dev-login endpoint on the app.
cat > config/app/auth.yaml <<AUTH
secret: "secret|betterauth_secret"
dev:
  allow-dev-login: true
AUTH

# Pin image tags when a version is requested; otherwise keep compose defaults
# (the latter are built from HEAD source by the caller, not pulled).
if [ -n "$VERSION" ]; then
  sed -i "s#checkpoint-app:latest-sqlite#checkpoint-app:${VERSION}-sqlite#" docker-compose.yaml
  sed -i "s#checkpoint-server:latest#checkpoint-server:${VERSION}#" docker-compose.yaml
fi
EOF

  if [ -n "${CHECKPOINT_VERSION:-}" ]; then
    log "pinned version ${CHECKPOINT_VERSION}: pulling released images from GHCR"
    on_server "cd /opt/checkpoint-compose && docker compose pull"
  else
    log "no version pinned: building app + server images from HEAD source on the server"
    on_server "rm -rf ${SERVER_SRC_DIR} && mkdir -p ${SERVER_SRC_DIR}"
    git -C "${REPO_ROOT}" archive --format=tar HEAD | on_server "tar x -C ${SERVER_SRC_DIR}"
    # Build the exact image tags the (unpinned) compose file references, so the
    # subsequent `docker compose up` uses these local builds instead of pulling.
    # The app is built sqlite-flavored to match the compose default and the
    # benchmark's file:// database_url.
    on_server "cd ${SERVER_SRC_DIR} && APP_IMAGE='${APP_IMAGE}' SERVER_IMAGE='${SERVER_IMAGE}' bash -seuo pipefail" <<'EOF'
docker build -f src/app/Dockerfile --build-arg DB_PROVIDER=sqlite -t "$APP_IMAGE" .
docker build -f src/core/server/Dockerfile -t "$SERVER_IMAGE" .
EOF
  fi

  log "starting compose stack"
  on_server "cd /opt/checkpoint-compose && docker compose up -d"

  log "waiting for app (:13000) and server (:13001) to be healthy"
  on_server_script <<'EOF'
ok=0
for i in $(seq 1 60); do
  if curl -sf http://localhost:13000 >/dev/null 2>&1 && curl -sf http://localhost:13001 >/dev/null 2>&1; then
    echo "app + server reachable"; ok=1; break
  fi
  echo "  waiting for services... ($i/60)"
  sleep 5
done
[ "$ok" = 1 ] || { echo "services did not come up"; docker compose -f /opt/checkpoint-compose/docker-compose.yaml logs --tail=80; exit 1; }
EOF
}

# ----------------------------------------------------------------------------
# Client
# ----------------------------------------------------------------------------
adapter_client_setup() {
  log "installing client build prerequisites"
  on_client_script <<'EOF'
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# Node 24 (NodeSource) + toolchain for the native longtail addon and the CLI.
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs build-essential cmake python3 libssl-dev git \
  libcurl4-openssl-dev nlohmann-json3-dev pkg-config curl
corepack enable
node --version
EOF

  log "shipping repo source (git archive of HEAD) to client"
  on_client "rm -rf ${SRC_DIR} && mkdir -p ${SRC_DIR}"
  git -C "${REPO_ROOT}" archive --format=tar HEAD | on_client "tar x -C ${SRC_DIR}"

  log "building Node services + native addon (yarn install/build)"
  on_client "cd ${SRC_DIR} && bash -seuo pipefail" <<'EOF'
yarn install --immutable
yarn build
EOF

  log "building C++ CLI"
  on_client "cd ${SRC_DIR}/src/clients/cli && bash -seuo pipefail" <<'EOF'
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build . --parallel
test -x ./chk
EOF

  log "starting daemon in background"
  on_client "DAEMON_DIR='${DAEMON_DIR}' bash -seuo pipefail" <<'EOF'
cd "$DAEMON_DIR"
# lib/bin.js exists after `yarn build`; run it headless as root so it reads
# /root/.checkpoint. Wait for the default daemon port (13010).
nohup node lib/bin.js >/var/log/checkpoint-daemon.log 2>&1 &
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:13010 >/dev/null 2>&1; then echo "daemon up"; break; fi
  echo "  waiting for daemon... ($i/30)"; sleep 2
done
EOF

  log "authenticating (devLogin -> auth.json) and creating org/repo"
  _checkpoint_auth_and_repo
}

# Mint an API token via the app's devLogin, write the client's auth.json, and
# create the benchmark org + repo. All HTTP runs from the coordinator against
# the server's public IP; the token works regardless of which IP minted it.
_checkpoint_auth_and_repo() {
  local resp token org_id repo_id

  resp="$(curl -sf -X POST "${APP_PUBLIC}/api/trpc/auth.devLogin?batch=1" \
    -H 'Content-Type: application/json' \
    -d "{\"0\":{\"json\":{\"email\":\"${DEV_EMAIL}\",\"deviceCode\":\"${DAEMON_ID}\",\"tokenName\":\"bench-token\"}}}")" \
    || die "devLogin request failed (is allow-dev-login set?)"
  token="$(printf '%s' "$resp" | json_get "0.result.data.json.apiToken")"
  [ -n "$token" ] || die "devLogin returned no token: $resp"
  log "got API token"

  # Write the daemon/CLI auth file on the client, pointing at the private IP.
  on_client "DAEMON_ID='${DAEMON_ID}' EP='${APP_PRIVATE}' TOKEN='${token}' bash -seuo pipefail" <<'EOF'
mkdir -p ~/.checkpoint
cat > ~/.checkpoint/auth.json <<JSON
{
  "users": {
    "${DAEMON_ID}": {
      "endpoint": "${EP}",
      "apiToken": "${TOKEN}"
    }
  }
}
JSON
EOF

  resp="$(curl -sf -X POST "${APP_PUBLIC}/api/trpc/org.createOrg?batch=1" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer ${token}" \
    -d "{\"0\":{\"json\":{\"name\":\"${ORG_NAME}\"}}}")" || die "createOrg failed"
  org_id="$(printf '%s' "$resp" | json_get "0.result.data.json.id")"
  [ -n "$org_id" ] || die "createOrg returned no id: $resp"

  resp="$(curl -sf -X POST "${APP_PUBLIC}/api/trpc/repo.createRepo?batch=1" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer ${token}" \
    -d "{\"0\":{\"json\":{\"name\":\"${REPO_NAME}\",\"orgId\":\"${org_id}\"}}}")" \
    || die "createRepo failed"
  repo_id="$(printf '%s' "$resp" | json_get "0.result.data.json.id")"
  [ -n "$repo_id" ] || die "createRepo returned no id: $resp"
  log "created ${ORG_NAME}/${REPO_NAME}"
}

# ----------------------------------------------------------------------------
# Payload
# ----------------------------------------------------------------------------
adapter_prepare_payload() {
  # parse_spaces_url gives us SPACES_REGION for the SigV4 signing string. We
  # fetch the private object with curl's native AWS SigV4 support (no awscli;
  # the awscli apt package was dropped in Ubuntu 24.04). curl signs against the
  # URL host, so the original TARBALL_URL is passed straight through.
  parse_spaces_url "$TARBALL_URL"
  on_client "mkdir -p ${TREE_DIR}"

  payload_phase payload_download -- on_client \
    "curl -fsS --aws-sigv4 'aws:amz:${SPACES_REGION}:s3' \
       --user '${SPACES_ACCESS_KEY_ID}:${SPACES_SECRET_ACCESS_KEY}' \
       -o '${WORK_DIR}/payload.tar.gz' '${TARBALL_URL}'"

  payload_phase payload_extract -- on_client \
    "tar xf '${WORK_DIR}/payload.tar.gz' -C '${TREE_DIR}'"
}

# ----------------------------------------------------------------------------
# Repo / workspace
# ----------------------------------------------------------------------------
adapter_create_repo() {
  # Initialize the workspace in the already-extracted tree, then give the
  # daemon a moment to scan it before timed operations begin.
  on_client "cd ${TREE_DIR} && ${CHK} init ${ORG_NAME}/${REPO_NAME}"
  on_client "sleep 5"
}

adapter_add_ignore() {
  on_client "cat > ${TREE_DIR}/.chkignore <<'IGN'
# Benchmark ignore file
Binaries
Intermediate
DerivedDataCache
Saved
IGN"
  on_client "cd ${TREE_DIR} && ${CHK} add .chkignore"
}

adapter_submit_ignore() {
  on_client "cd ${TREE_DIR} && ${CHK} submit --no-progress --message 'benchmark: ignore file'"
}

adapter_add_all() {
  # `chk add .` prints "  + <path>" for every staged file plus a count, which
  # floods the CI log on a tree this size, and chk has no quiet flag. Drop
  # stdout; errors go to stderr and the exit code still propagates.
  on_client "cd ${TREE_DIR} && ${CHK} add . >/dev/null"
}

adapter_commit_all() {
  : # unsupported for Checkpoint; never called (ADAPTER_SUPPORTS_COMMIT=false)
}

adapter_submit_all() {
  on_client "cd ${TREE_DIR} && ${CHK} submit --no-progress --message 'benchmark: full tree'"
}

adapter_status() {
  # Status of the clean post-submit tree (scans the workspace for changes).
  on_client "cd ${TREE_DIR} && ${CHK} status >/dev/null"
}

adapter_pull_elsewhere() {
  on_client "mkdir -p ${PULL_DIR} && cd ${PULL_DIR} && ${CHK} init ${ORG_NAME}/${REPO_NAME} && ${CHK} pull --no-progress"
}

# Small-update: change ~100 bytes of one file and submit. Untimed; the harness
# only measures the server storage delta around this.
adapter_update() {
  client_append_bytes "${TREE_DIR}/${SMALL_CHANGE_FILE}" 100
  on_client "cd ${TREE_DIR} && ${CHK} add '${SMALL_CHANGE_FILE}' >/dev/null"
  on_client "cd ${TREE_DIR} && ${CHK} submit --no-progress --message 'benchmark: small update'"
}

# Per-stage breakdown of the full-tree submit. The daemon logs one
# `[submit-timing] {"modifications":N,"stagesMs":{...}}` line per submit (the
# native submit's wall-clock per step: indexing, getting existing content,
# writing blocks, flushing, finalizing, uploading). The harness calls this right
# after submit_all, so the LAST such line is that submit's. We convert the
# per-stage milliseconds to whole seconds and record them under submit_stages.
adapter_record_submit_stages() {
  local line json parsed name secs
  line="$(on_client "grep -a '\\[submit-timing\\]' /var/log/checkpoint-daemon.log 2>/dev/null | tail -1 || true")"
  if [ -z "$line" ]; then
    log "no [submit-timing] line in daemon log; skipping submit-stage breakdown"
    return 0
  fi
  # Take from the first '{' to end of line (robust to any log prefix).
  json="{${line#*\{}"
  parsed="$(printf '%s' "$json" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      try {
        const stages = (JSON.parse(d).stagesMs) || {};
        for (const [k, v] of Object.entries(stages)) {
          process.stdout.write(`${k}\t${Math.round(Number(v) / 1000)}\n`);
        }
      } catch {
        process.exit(1);
      }
    });
  ')" || { log "could not parse [submit-timing] JSON; skipping"; return 0; }
  while IFS=$'\t' read -r name secs; do
    [ -n "$name" ] || continue
    record_submit_stage "$name" "$secs"
  done <<< "$parsed"
  log "recorded submit-stage breakdown (${json})"
}

# Per-component storage snapshot for the small-update breakdown. The harness
# calls this before and after the update submit and records the per-component
# deltas (see record_storage_breakdown). Emits "name<TAB>bytes" lines:
#   content_store_total - the whole local content-store volume, a CLEAN
#       number that excludes Docker container logs, the app DB (a separate
#       volume), and overlay churn that the whole-/data/docker metric also
#       counts. This is the true on-disk growth of Checkpoint's backend store.
#   <child> - each entry under the single bench repo dir ({org}/{repo}): the
#       Longtail content blocks dir, `versions` (the per-CL .lvi indexes),
#       `tree` (the content-addressed state-tree blocks), and the `store.lsi`
#       global store index. Names are discovered, not hard-coded, so the layout
#       can change without editing this hook.
adapter_storage_components() {
  on_server "bash -seuo pipefail" <<'EOF'
sync
# Host path of the local content store (the server's storage-data volume,
# mounted at /app/data in the container).
VOL="$(docker inspect checkpoint-server \
  --format '{{ range .Mounts }}{{ if eq .Destination "/app/data" }}{{ .Source }}{{ end }}{{ end }}' \
  2>/dev/null || true)"
[ -n "$VOL" ] && [ -d "$VOL" ] || exit 0

printf 'content_store_total\t%s\n' "$(du -sB1 "$VOL" 2>/dev/null | cut -f1)"

# Break the single bench repo dir ({org}/{repo}) into its components. The glob
# matches both subdirs (the blocks dir, versions, tree) and files (store.lsi).
for repo in "$VOL"/*/*; do
  [ -d "$repo" ] || continue
  for child in "$repo"/*; do
    [ -e "$child" ] || continue
    printf '%s\t%s\n' "$(basename "$child")" "$(du -sB1 "$child" 2>/dev/null | cut -f1)"
  done
done
EOF
}
