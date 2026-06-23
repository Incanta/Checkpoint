#!/usr/bin/env bash
# Lore adapter (Epic Games Lore VCS). Docs: https://epicgames.github.io/lore/
#
# Server: the prebuilt `loreserver` binary (from the public GitHub releases via
#   the official install.sh), run non-demo with a small TOML config that pins
#   the cert and the local store path. QUIC + gRPC share :41337; HTTP health is
#   on :41339. Storage stays a node-local store on the server's base disk (the
#   provisioned data volume is attached to the client, mirroring the checkpoint
#   adapter; a full 50GB run would want a dedicated server volume too).
# Client: the prebuilt `lore` CLI from the same install.sh (no build needed).
# Auth/TLS: the client URL uses the plain `lore://` scheme. In Lore, the client
#   only validates the server certificate when the scheme ends in "s"
#   (`lores://`), so `lore://` skips verification entirely. That is how the
#   official quickstart trusts the server's ephemeral self-signed cert, and it
#   lets us talk to the server over the private VPC IP with no CA distribution.
#
# Lore has a separate local `commit` and remote `push`, so commit_all is a real
# (timed) phase here: add -> `lore stage --scan .`, commit -> `lore commit`,
# submit -> `lore push`.

ADAPTER_SUPPORTS_COMMIT="true"

# Remote binaries on the droplets (install.sh honors LORE_INSTALL_DIR).
LORE="/usr/local/bin/lore"
LORESERVER="/usr/local/bin/loreserver"
INSTALL_SH="https://raw.githubusercontent.com/EpicGames/lore/main/scripts/install.sh"

# Repo identity + the client-facing URL. The client reaches the server's QUIC
# endpoint over the private VPC IP; `lore://` (not `lores://`) skips cert checks.
REPO_NAME="bench-repo"
LORE_URL="lore://${SERVER_PRIVATE_IP}:41337/${REPO_NAME}"

# Server-side layout.
LORE_CFG_DIR="/opt/loreserver/config"
LORE_CERT_DIR="/opt/loreserver/certs"
LORE_STORE_DIR="/var/lib/lore/store"

# ----------------------------------------------------------------------------
# Server
# ----------------------------------------------------------------------------
adapter_server_setup() {
  log "installing loreserver"
  on_server_script <<EOF
export DEBIAN_FRONTEND=noninteractive
command -v openssl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y openssl; }
curl -fsSL ${INSTALL_SH} | LORE_INSTALL_DIR=/usr/local/bin bash -s -- --server
test -x ${LORESERVER}
${LORESERVER} --version || true
EOF

  log "writing cert + config and launching loreserver"
  on_server "PRIV='${SERVER_PRIVATE_IP}' bash -seuo pipefail" <<EOF
mkdir -p ${LORE_CFG_DIR} ${LORE_CERT_DIR} ${LORE_STORE_DIR}

# Self-signed cert with the server's private IP in the SAN. The client skips
# verification (lore:// scheme), but loreserver still needs a cert to serve TLS.
if [ ! -f ${LORE_CERT_DIR}/cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout ${LORE_CERT_DIR}/key.pem \
    -out ${LORE_CERT_DIR}/cert.pem \
    -days 365 -subj "/CN=lore-bench" \
    -addext "subjectAltName=IP:\${PRIV},IP:127.0.0.1,DNS:localhost"
fi

cat > ${LORE_CFG_DIR}/local.toml <<TOML
[server.quic]
host = "0.0.0.0"
port = 41337

[server.quic.certificate]
cert_file = "${LORE_CERT_DIR}/cert.pem"
pkey_file = "${LORE_CERT_DIR}/key.pem"

[server.http]
host = "0.0.0.0"
port = 41339

[immutable_store]
mode = "local"

[immutable_store.local]
path = "${LORE_STORE_DIR}"
flush_delay_seconds = 10

[mutable_store]
mode = "local"

[mutable_store.local]
path = "${LORE_STORE_DIR}"
flush_delay_seconds = 10
TOML

nohup ${LORESERVER} --config ${LORE_CFG_DIR} >/var/log/loreserver.log 2>&1 &
for i in \$(seq 1 30); do
  if curl -fsS http://127.0.0.1:41339/health_check >/dev/null 2>&1; then echo "loreserver up"; break; fi
  echo "  waiting for loreserver... (\$i/30)"; sleep 2
done
curl -fsS http://127.0.0.1:41339/health_check >/dev/null 2>&1 || {
  echo "loreserver did not become healthy"; tail -n 60 /var/log/loreserver.log; exit 1;
}
EOF
}

# ----------------------------------------------------------------------------
# Client
# ----------------------------------------------------------------------------
adapter_client_setup() {
  log "installing lore CLI"
  on_client_script <<EOF
export DEBIAN_FRONTEND=noninteractive
curl -fsSL ${INSTALL_SH} | LORE_INSTALL_DIR=/usr/local/bin bash
test -x ${LORE}
${LORE} --version || true
EOF
}

# ----------------------------------------------------------------------------
# Payload (identical Spaces download + extract as the other adapters)
# ----------------------------------------------------------------------------
adapter_prepare_payload() {
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
  # Create the repo on the server and initialize tracking in the extracted tree
  # (this writes .lore/config.toml with the remote URL + a node-local store).
  on_client "cd ${TREE_DIR} && ${LORE} repository create '${LORE_URL}'"
  on_client "sleep 3"
}

adapter_add_ignore() {
  on_client "cat > ${TREE_DIR}/.loreignore <<'IGN'
# Benchmark ignore file (gitignore-style patterns)
Binaries/
Intermediate/
DerivedDataCache/
Saved/
IGN"
  on_client "cd ${TREE_DIR} && ${LORE} stage .loreignore"
}

adapter_submit_ignore() {
  # First revision: commit + push the ignore file together (setup, one phase).
  on_client "cd ${TREE_DIR} && ${LORE} commit 'benchmark: ignore file' && ${LORE} push"
}

adapter_add_all() {
  # --scan walks the tree, marks every new/changed (non-ignored) file dirty, and
  # stages it in a single pass.
  on_client "cd ${TREE_DIR} && ${LORE} stage --scan ."
}

adapter_commit_all() {
  on_client "cd ${TREE_DIR} && ${LORE} commit 'benchmark: full tree'"
}

adapter_submit_all() {
  on_client "cd ${TREE_DIR} && ${LORE} push"
}

adapter_pull_elsewhere() {
  # Fresh clone into a new directory with its own local store, so the pull must
  # fetch every fragment from the server (no local dedup via a shared store).
  on_client "rm -rf ${PULL_DIR} && cd ${WORK_DIR} && ${LORE} clone '${LORE_URL}' ${PULL_DIR}"
}
