#!/usr/bin/env bash
# Checkpoint VCS adapter.
#
# Server: the repo's docker-compose bundle (app :13000, server :13001,
#   postgres), images pulled from public GHCR. Storage stays in the default
#   "filer w/ stub" mode (no SeaweedFS profile).
# Client: built from source on the droplet (CLI via CMake + daemon via Node),
#   mirroring the proven .github/workflows/test.yaml flow. The published .deb
#   is not used because releases are drafts with non-anonymous asset URLs.
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

# Pin image tags when a version is requested; otherwise keep compose defaults.
if [ -n "$VERSION" ]; then
  sed -i "s#checkpoint-app:latest-sqlite#checkpoint-app:${VERSION}-sqlite#" docker-compose.yaml
  sed -i "s#checkpoint-server:latest#checkpoint-server:${VERSION}#" docker-compose.yaml
fi

docker compose pull
docker compose up -d
EOF

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
  on_client "cd ${TREE_DIR} && ${CHK} submit --message 'benchmark: ignore file'"
}

adapter_add_all() {
  on_client "cd ${TREE_DIR} && ${CHK} add ."
}

adapter_commit_all() {
  : # unsupported for Checkpoint; never called (ADAPTER_SUPPORTS_COMMIT=false)
}

adapter_submit_all() {
  on_client "cd ${TREE_DIR} && ${CHK} submit --message 'benchmark: full tree'"
}

adapter_pull_elsewhere() {
  on_client "mkdir -p ${PULL_DIR} && cd ${PULL_DIR} && ${CHK} init ${ORG_NAME}/${REPO_NAME} && ${CHK} pull"
}
