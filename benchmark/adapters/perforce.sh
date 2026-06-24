#!/usr/bin/env bash
# Perforce Helix Core adapter. Docs: https://www.perforce.com/
#
# Server: the `helix-p4d` package from Perforce's APT repo, configured headless
#   with configure-helix-p4d.sh (plaintext :1666, a superuser). A fresh p4d
#   auto-creates the default `//depot` depot.
# Client: the `helix-cli` package (the `p4` command). Connection settings live
#   in ~/.p4enviro via `p4 set`, and a login ticket (~/.p4tickets) is obtained
#   non-interactively so later commands never prompt. The client talks to the
#   server's private VPC IP; the coordinator does not need to reach p4d.
#
# Perforce has no separate local commit: `p4 add`/`p4 reconcile` open files in a
# pending changelist, and `p4 submit` publishes them to the server in one step.
# So commit_all is unsupported here (recorded as null), exactly like Checkpoint:
#   add_all    -> `p4 reconcile -a`  (open every new, non-ignored file for add)
#   submit_all -> `p4 submit`        (upload + server-side archive in one step)
#
# "Pull elsewhere" is a second client workspace rooted at a fresh directory,
# then `p4 sync` to materialize the head revision.

ADAPTER_SUPPORTS_COMMIT="false"

# Server identity / layout. P4ROOT (depot archives + db) lives on the attached
# server volume (/data) so a full 50GB submit does not fill the base disk.
P4_INSTANCE="master"
P4ROOT="/data/perforce/servers/master"
# Server-side store root (db + depot archives), for the small-update delta.
SERVER_STORAGE_PATH="/data/perforce"
P4_SUPERUSER="super"
# Must satisfy Helix's strong-password policy (length + mixed classes).
P4_PASSWD="BenchPass123!"
DEPOT="depot"

# Client-facing connection (plaintext) over the server's private VPC IP, plus
# the two workspaces (main tree + fresh pull).
P4PORT_PRIV="${SERVER_PRIVATE_IP}:1666"
WS_MAIN="bench-ws"
WS_PULL="bench-pull"

# Add Perforce's APT repo and refresh. Used on both droplets (the codename is
# read from the running release so this tracks the droplet image).
_perforce_apt_repo='export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl gnupg ca-certificates
curl -fsSL https://package.perforce.com/perforce.pubkey | gpg --dearmor -o /usr/share/keyrings/perforce.gpg
codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
echo "deb [signed-by=/usr/share/keyrings/perforce.gpg] https://package.perforce.com/apt/ubuntu ${codename} release" > /etc/apt/sources.list.d/perforce.list
apt-get update -y'

# ----------------------------------------------------------------------------
# Server
# ----------------------------------------------------------------------------
adapter_server_setup() {
  log "installing helix-p4d on server"
  on_server "bash -seuo pipefail" <<EOF
${_perforce_apt_repo}
apt-get install -y helix-p4d helix-cli
EOF

  log "configuring + starting p4d (instance=${P4_INSTANCE}, plaintext :1666)"
  on_server "PASSWD='${P4_PASSWD}' bash -seuo pipefail" <<EOF
# Ensure P4ROOT on the server volume exists and is owned by the service user
# before configure writes the server db/archives there.
mkdir -p ${P4ROOT}
chown -R perforce:perforce /data/perforce
/opt/perforce/sbin/configure-helix-p4d.sh ${P4_INSTANCE} -n \
  -p 1666 -r ${P4ROOT} -u ${P4_SUPERUSER} -P "\${PASSWD}"
p4dctl status ${P4_INSTANCE} || p4dctl start ${P4_INSTANCE}
# Smoke check from the server (p4 info is unauthenticated).
P4PORT=localhost:1666 p4 info
EOF
}

# ----------------------------------------------------------------------------
# Client
# ----------------------------------------------------------------------------
adapter_client_setup() {
  log "installing helix-cli (p4) on client"
  on_client "bash -seuo pipefail" <<EOF
${_perforce_apt_repo}
apt-get install -y helix-cli
p4 -V | head -2
EOF

  log "configuring p4 env + ticket auth (password file for per-phase re-login)"
  on_client "PORT='${P4PORT_PRIV}' PU='${P4_SUPERUSER}' PW='${P4_PASSWD}' bash -seuo pipefail" <<'EOF'
p4 set P4PORT="${PORT}"
p4 set P4USER="${PU}"
p4 set P4IGNORE=.p4ignore
# Modern p4d (2025+) requires login tickets to authenticate commands: a
# plaintext P4PASSWD in the environment does NOT authenticate commands directly
# at any security level, and login tickets expire mid-run (~30-40 min), so a
# long submit followed by a fresh command fails with "P4PASSWD invalid or
# unset". Earlier attempts to dodge this all failed:
#   - bumping the group Timeout to unlimited + re-login: ticket still expired;
#   - security level 2 + P4PASSWD: p4 still preferred the expired ticket;
#   - security level 0 + P4PASSWD + logout: logout deleted the ONLY working
#     auth, breaking the very next command immediately.
# The reliable fix is to keep ticket auth and simply re-login right before every
# server-touching phase, so each phase always starts with a fresh ticket and
# expiry can never bite. Store the password in a root-only file and feed it to
# `p4 login` on stdin; P4_RELOGIN (below) is that re-login, run before each phase.
# See https://help.perforce.com/helix-core/server-apps/p4sag/2025.1/Content/P4SAG/security-levels.html
printf '%s\n' "${PW}" > /root/.p4pass
chmod 600 /root/.p4pass
p4 login < /root/.p4pass
p4 info
EOF
}

# Re-login snippet prepended to every server-touching phase so each phase starts
# with a fresh ticket (tickets expire mid-run, ~30-40 min). Runs quietly; a real
# auth problem still surfaces because the p4 command that follows fails loudly.
# Usable in the double-quoted one-liner phases (expands in the coordinator shell,
# then the remote bash parses the redirection). The quoted-heredoc phases instead
# inline this same line literally, since '<<'\''EOF'\''' suppresses expansion.
P4_RELOGIN="p4 login < /root/.p4pass >/dev/null 2>&1 || true"

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
  # The depot already exists (default //depot); create the main client workspace
  # rooted at the extracted tree. The default generated View already maps
  # //depot/... -> //<client>/...; we just override Root.
  on_client "TREE_DIR='${TREE_DIR}' WS='${WS_MAIN}' DEPOT='${DEPOT}' bash -seuo pipefail" <<'EOF'
p4 login < /root/.p4pass >/dev/null 2>&1 || true
mkdir -p "${TREE_DIR}"
p4 --field "Root=${TREE_DIR}" \
   --field "View=//${DEPOT}/... //${WS}/..." \
   client -o "${WS}" | p4 client -i
p4 -c "${WS}" info
EOF
}

adapter_add_ignore() {
  on_client "TREE_DIR='${TREE_DIR}' WS='${WS_MAIN}' bash -seuo pipefail" <<'EOF'
p4 login < /root/.p4pass >/dev/null 2>&1 || true
cd "${TREE_DIR}"
cat > .p4ignore <<'IGN'
# Benchmark ignore file (P4IGNORE syntax)
Binaries
Intermediate
DerivedDataCache
Saved
IGN
p4 -c "${WS}" add .p4ignore
EOF
}

adapter_submit_ignore() {
  on_client "${P4_RELOGIN} && cd ${TREE_DIR} && p4 -q -c ${WS_MAIN} submit -d 'benchmark: ignore file'"
}

adapter_add_all() {
  # reconcile -a opens every workspace file not yet in the depot for add,
  # honoring P4IGNORE. This is the heavy staging step. -q suppresses the
  # per-file "opened for add" lines (one per file would flood the CI log on a
  # tree this size); errors still print.
  on_client "${P4_RELOGIN} && cd ${TREE_DIR} && p4 -q -c ${WS_MAIN} reconcile -a"
}

adapter_commit_all() {
  : # unsupported for Perforce; never called (ADAPTER_SUPPORTS_COMMIT=false)
}

adapter_submit_all() {
  # -q suppresses the per-file submit lines. Capture output so a failure (which
  # can come back fast on a large submit, e.g. a server limit) surfaces its
  # reason plus the opened-file count instead of an opaque rc=1.
  on_client "TREE_DIR='${TREE_DIR}' WS='${WS_MAIN}' bash -seuo pipefail" <<'EOF'
p4 login < /root/.p4pass >/dev/null 2>&1 || true
cd "${TREE_DIR}"
if out="$(p4 -q -c "${WS}" submit -d 'benchmark: full tree' 2>&1)"; then
  printf '%s\n' "$out"
  exit 0
fi
echo "=== p4 submit failed; diagnostics ==="
printf '%s\n' "$out" | tail -40
echo "--- opened files (count) ---"
p4 -c "${WS}" opened 2>&1 | wc -l
exit 1
EOF
}

adapter_status() {
  # `p4 status` reconciles in preview mode, scanning the workspace for changes.
  on_client "${P4_RELOGIN} && cd ${TREE_DIR} && p4 -c ${WS_MAIN} status >/dev/null"
}

adapter_pull_elsewhere() {
  # Second workspace rooted at a fresh directory, then sync the head revision so
  # the pull downloads every file from the server.
  on_client "PULL_DIR='${PULL_DIR}' WS='${WS_PULL}' DEPOT='${DEPOT}' bash -seuo pipefail" <<'EOF'
p4 login < /root/.p4pass >/dev/null 2>&1 || true
rm -rf "${PULL_DIR}"
mkdir -p "${PULL_DIR}"
p4 --field "Root=${PULL_DIR}" \
   --field "View=//${DEPOT}/... //${WS}/..." \
   client -o "${WS}" | p4 client -i
# -q suppresses the per-file "added as ..." lines from the full sync.
p4 -q -c "${WS}" sync
EOF
}

# Small-update: open one file for edit, change ~100 bytes, and submit. Perforce
# stores a new revision of the (binary) file, typically the whole file again.
adapter_update() {
  on_client "${P4_RELOGIN} && cd ${TREE_DIR} && p4 -c ${WS_MAIN} edit '${SMALL_CHANGE_FILE}'"
  client_append_bytes "${TREE_DIR}/${SMALL_CHANGE_FILE}" 100
  on_client "${P4_RELOGIN} && cd ${TREE_DIR} && p4 -q -c ${WS_MAIN} submit -d 'benchmark: small update'"
}
