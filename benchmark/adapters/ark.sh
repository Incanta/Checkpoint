#!/usr/bin/env bash
# Ark VCS adapter. Docs: https://ark-vcs.com/documentation.html
#
# Ark is centralized (server-based) with a shelve-then-commit model: `ark commit`
# uploads (shelves) the changelist's content to the server and marks it
# committed in one step, so there is no separate local commit (commit_all is
# null, like Checkpoint/Perforce). Change detection is automatic (files in the
# workspace show up as pending adds), so the timed "add" maps to `ark changes`
# (workspace scan) and "submit" to `ark commit` (the upload).
#
# Server + client are the same `ark` binary (server subcommand vs the client
# subcommands), installed from the published Linux zip.
#
# ASSUMPTIONS that may need a CI iteration to confirm (the public docs are thin
# on non-interactive use):
#   1. Password prompt: `ark init` reads the password from a TTY with no echo and
#      has no password flag/env. We feed it over a pseudo-tty via `script`,
#      twice, in case first-run registration asks to confirm.
#   2. Workspace changelist id: `ark commit` needs `-ws_cl <id>`; we parse it
#      from `ark changes`, which lists workspace changelists as "<id>: <Changes>"
#      lines. We must anchor on that line shape (NOT "first integer in the
#      output"): `ark changes` prints a "Connecting ...<server-ip>..." banner
#      first, and grabbing the first integer there picks up part of the private
#      IP (e.g. 10 from 10.x.x.x) instead of the changelist id. The parse dumps
#      full `ark changes` output on failure so the format can be confirmed.
#   3. TLS: the server auto-generates a self-signed cert. We assume the client
#      trusts it on connect (TOFU); if not, an insecure/trust option may be
#      needed (none is documented).

ADAPTER_SUPPORTS_COMMIT="false"

ARK="/usr/local/bin/ark"
ARK_ZIP_URL="https://ark-vcs.com/static/versions/Ark-Vcs_1_1_2_linux.zip"

# First user to connect auto-registers as admin.
ARK_EMAIL="admin@bench.dev"
ARK_PASSWORD="BenchPass123!"
ARK_HOST="${SERVER_PRIVATE_IP}:9000"

# Server data dir on the attached server volume (also the storage-delta path).
ARK_DATA_DIR="/data/ark"
SERVER_STORAGE_PATH="${ARK_DATA_DIR}"

# Holding dir (sibling of the workspace, same /data filesystem) used to park the
# extracted payload during the ignore-only first commit, then move it back for
# the full-tree commit. See adapter_add_ignore / adapter_add_all.
HOLD_DIR="${WORK_DIR}/_ark_hold"

# Download the Linux zip and install the `ark` binary at a stable path. Single
# quoted so the inner $(...) runs on the remote, not the coordinator (used inside
# an unquoted heredoc, same pattern as the Perforce adapter's apt-repo helper).
_ark_install='export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# The ark binary is a GUI-capable app linked against OpenGL/X11 at load time, so
# even the headless `server`/CLI subcommands need these libs present to start.
apt-get install -y curl unzip util-linux ca-certificates \
  libgl1 libx11-6 libxcursor1 libxrandr2 libxinerama1 libxi6 libxxf86vm1 libxkbcommon0
curl -fsSL -o /tmp/ark.zip "'"${ARK_ZIP_URL}"'"
rm -rf /opt/ark && mkdir -p /opt/ark
unzip -q -o /tmp/ark.zip -d /opt/ark
arkbin="$(find /opt/ark -type f -name ark | head -1)"
[ -n "$arkbin" ] || arkbin="$(find /opt/ark -type f -iname "ark*" ! -iname "*.*" | head -1)"
[ -n "$arkbin" ] || { echo "ark binary not found in zip:"; find /opt/ark -maxdepth 3 | head -50; exit 1; }
chmod +x "$arkbin"
ln -sf "$arkbin" /usr/local/bin/ark
# Fail clearly (and list them) if any shared library is still missing, so the
# set above can be extended without guessing.
if ldd /usr/local/bin/ark 2>/dev/null | grep -q "not found"; then
  echo "ark is missing shared libraries:"; ldd /usr/local/bin/ark | grep "not found"; exit 1
fi
echo "installed ark -> $arkbin"'

# ----------------------------------------------------------------------------
# Server
# ----------------------------------------------------------------------------
adapter_server_setup() {
  log "installing ark on server"
  on_server "bash -seuo pipefail" <<EOF
${_ark_install}
EOF

  log "starting ark server (:9000, data on ${ARK_DATA_DIR})"
  on_server "DATA_DIR='${ARK_DATA_DIR}' bash -seuo pipefail" <<'EOF'
mkdir -p "${DATA_DIR}"
# -allow_dv_upgrade / -allow_non_empty_path must be set explicitly on init.
nohup /usr/local/bin/ark server -path "${DATA_DIR}" -port 9000 \
  -log_level info -allow_dv_upgrade true -allow_non_empty_path true \
  >/var/log/ark-server.log 2>&1 &
# Wait for the server to accept TCP connections on :9000.
up=0
for i in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/9000) 2>/dev/null; then exec 3>&- 3<&-; up=1; echo "ark server up"; break; fi
  echo "  waiting for ark server... ($i/30)"; sleep 2
done
[ "$up" = 1 ] || { echo "ark server did not come up"; tail -n 80 /var/log/ark-server.log; exit 1; }
EOF
}

# ----------------------------------------------------------------------------
# Client
# ----------------------------------------------------------------------------
adapter_client_setup() {
  log "installing ark on client"
  on_client "bash -seuo pipefail" <<EOF
${_ark_install}
ark --help >/dev/null 2>&1 || ark -h >/dev/null 2>&1 || true
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
  # Initialize the workspace in the already-extracted tree. The first user to
  # connect auto-registers as admin. The password is fed over a pseudo-tty
  # (the CLI prompts with no echo); twice in case registration confirms it.
  on_client "TREE_DIR='${TREE_DIR}' EMAIL='${ARK_EMAIL}' PW='${ARK_PASSWORD}' HOST='${ARK_HOST}' bash -seuo pipefail" <<'EOF'
cd "${TREE_DIR}"
printf '%s\n%s\n' "${PW}" "${PW}" | script -qec "ark init -email '${EMAIL}' -host '${HOST}'" /dev/null
EOF
}

adapter_add_ignore() {
  on_client "TREE_DIR='${TREE_DIR}' HOLD='${HOLD_DIR}' bash -seuo pipefail" <<'EOF'
cd "${TREE_DIR}"
cat > .ark_ignore <<'IGN'
# Benchmark ignore file (Ark .ark_ignore syntax: * globs, ! negation)
Binaries/*
Intermediate/*
DerivedDataCache/*
Saved/*
IGN
# Ark auto-detects EVERY workspace file as one pending changelist, but the
# benchmark wants the first version to hold only the ignore file (like the other
# adapters), and the big upload to land in submit_all. So temporarily move the
# extracted payload out of the workspace; only the ark-managed files (.ark*) and
# the ignore file remain pending for this first commit. add_all moves it back.
# These are same-filesystem renames on /data, so this is near-instant regardless
# of tree size.
mkdir -p "${HOLD}"
shopt -s dotglob nullglob
for e in *; do
  case "$e" in
    .ark|.ark_*) continue ;;   # keep ark workspace metadata + the ignore file
  esac
  mv "$e" "${HOLD}/"
done
shopt -u dotglob nullglob
# Trigger workspace change detection (only the ignore file is pending now).
ark changes >/dev/null
EOF
}

# Resolve the current workspace changelist id from `ark changes` and commit it.
# `ark changes` lists workspace changelists as "<id>: <Changes>" lines, so parse
# the id from a line of that shape (leading optional whitespace, digits, colon).
# We must NOT take "the first integer in the output": `ark changes` prints a
# "Connecting ...<server-ip>..." banner first, so a naive grep grabs part of the
# private IP (e.g. 10 from 10.x.x.x) and `ark commit -ws_cl 10` then fails with
# "No workspace changelist with id 10" while still exiting 0 (a silent no-op).
# Dump the full output on parse failure so the format can be confirmed.
_ark_commit_remote='cd "${TREE_DIR}"
changes_out="$(ark changes -limit 1 2>&1)"
wscl="$(printf "%s\n" "$changes_out" | sed -n "s/^[[:space:]]*\([0-9][0-9]*\):.*/\1/p" | head -1)"
if [ -z "$wscl" ]; then
  echo "could not determine workspace changelist id from \"ark changes\"; full output:"
  printf "%s\n" "$changes_out"
  exit 1
fi
echo "committing workspace changelist ${wscl}"
ark commit -ws_cl "$wscl" -message "${MSG}"'

adapter_submit_ignore() {
  on_client "TREE_DIR='${TREE_DIR}' MSG='benchmark: ignore file' bash -seuo pipefail" <<EOF
${_ark_commit_remote}
EOF
}

adapter_add_all() {
  # Move the payload parked by add_ignore back into the workspace, then let Ark's
  # automatic change detection pick it up (the "add" equivalent). The move is a
  # set of same-filesystem renames, so it is near-instant; the real work (and the
  # upload) happens in submit_all.
  on_client "TREE_DIR='${TREE_DIR}' HOLD='${HOLD_DIR}' bash -seuo pipefail" <<'EOF'
if [ -d "${HOLD}" ]; then
  cd "${HOLD}"
  shopt -s dotglob nullglob
  for e in *; do
    mv "$e" "${TREE_DIR}/"
  done
  shopt -u dotglob nullglob
  cd "${TREE_DIR}"
  rmdir "${HOLD}" 2>/dev/null || true
fi
cd "${TREE_DIR}"
ark changes >/dev/null
EOF
}

adapter_commit_all() {
  : # unsupported for Ark; never called (ADAPTER_SUPPORTS_COMMIT=false)
}

adapter_submit_all() {
  on_client "TREE_DIR='${TREE_DIR}' MSG='benchmark: full tree' bash -seuo pipefail" <<EOF
${_ark_commit_remote}
EOF
}

adapter_status() {
  # Ark's status equivalent: detect/list workspace changes (scans the tree).
  on_client "cd ${TREE_DIR} && ${ARK} changes >/dev/null"
}

adapter_pull_elsewhere() {
  # Fresh workspace in a new directory, then download the latest content. init
  # re-authenticates the existing admin (password over pseudo-tty).
  on_client "PULL_DIR='${PULL_DIR}' EMAIL='${ARK_EMAIL}' PW='${ARK_PASSWORD}' HOST='${ARK_HOST}' bash -seuo pipefail" <<'EOF'
rm -rf "${PULL_DIR}" && mkdir -p "${PULL_DIR}"
cd "${PULL_DIR}"
printf '%s\n%s\n' "${PW}" "${PW}" | script -qec "ark init -email '${EMAIL}' -host '${HOST}'" /dev/null
ark get-latest
EOF
}

# Small-update: change ~100 bytes of one file and commit a new changelist.
adapter_update() {
  client_append_bytes "${TREE_DIR}/${SMALL_CHANGE_FILE}" 100
  on_client "TREE_DIR='${TREE_DIR}' MSG='benchmark: small update' bash -seuo pipefail" <<EOF
${_ark_commit_remote}
EOF
}
