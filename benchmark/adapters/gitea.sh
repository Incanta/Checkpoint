#!/usr/bin/env bash
# Gitea adapter (git-based, via Git LFS). Docs: https://docs.gitea.com/
#
# Server: the official gitea/gitea Docker image, run headless (INSTALL_LOCK set,
#   SQLite DB, LFS server on). A benchmark admin user is created with the gitea
#   CLI, and the repo is created over the API.
# Client: git + git-lfs from apt. Auth to the server is HTTP basic, supplied
#   non-interactively via a stored credential (~/.git-credentials), so neither
#   git nor git-lfs ever prompts. The client talks to the server's private VPC
#   IP; the coordinator hits the public IP only for the API repo-create call.
#
# Git separates the local commit from the network push, so this adapter times
# all three of add / commit / push:
#   add_all    -> `git add -A`   (runs the LFS clean filter on matched files)
#   commit_all -> `git commit`
#   submit_all -> `git push`     (LFS objects upload here, via the pre-push hook)
#
# Parity note: git's add/commit are local and push is the network step, whereas
# Checkpoint's add stages and submit publishes. The summary lines phases up by
# name; the semantic difference is documented in the README.
#
# Sizing note: git-lfs keeps a local object cache (.git/lfs/objects) in addition
# to the working copy, so a tracked tree costs roughly 2x its size on the client
# (working files + LFS cache), and the fresh pull doubles that again. Gitea runs
# want a larger data_volume_gb than Checkpoint/Lore for the same payload.

ADAPTER_SUPPORTS_COMMIT="true"

# Pin via a future config knob if strict reproducibility is needed; matches the
# Checkpoint adapter's use of rolling image tags by default.
GITEA_IMAGE_TAG="latest"

# Benchmark identity. The password must satisfy Gitea's default policy (>= 8).
GITEA_USER="bench"
GITEA_PASS="benchpass123"
GITEA_EMAIL="bench@example.com"
REPO_NAME="bench-repo"

# Clone/remote URL the client uses (server's private VPC IP).
GIT_REMOTE="http://${SERVER_PRIVATE_IP}:3000/${GITEA_USER}/${REPO_NAME}.git"

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
EOF

  log "starting gitea container (sqlite, LFS on, install locked)"
  on_server "PRIV='${SERVER_PRIVATE_IP}' bash -seuo pipefail" <<EOF
docker rm -f gitea >/dev/null 2>&1 || true
# Gitea's /data (repos + LFS objects) lives on the attached server volume so a
# full 50GB push does not fill the droplet base disk.
mkdir -p /data/gitea
docker run -d --name gitea --restart=always \
  -e USER_UID=1000 -e USER_GID=1000 \
  -e GITEA__server__ROOT_URL="http://\${PRIV}:3000/" \
  -e GITEA__server__DOMAIN="\${PRIV}" \
  -e GITEA__server__LFS_START_SERVER=true \
  -e GITEA__security__INSTALL_LOCK=true \
  -e GITEA__service__DISABLE_REGISTRATION=true \
  -e GITEA__database__DB_TYPE=sqlite3 \
  -v /data/gitea:/data \
  -p 3000:3000 \
  gitea/gitea:${GITEA_IMAGE_TAG}

for i in \$(seq 1 60); do
  if curl -sf http://localhost:3000/api/healthz >/dev/null 2>&1; then echo "gitea up"; break; fi
  echo "  waiting for gitea... (\$i/60)"; sleep 3
done
curl -sf http://localhost:3000/api/healthz >/dev/null 2>&1 || {
  echo "gitea did not come up"; docker logs --tail 80 gitea; exit 1;
}

# Create the benchmark user (idempotent: tolerate "already exists" on re-run).
docker exec -u git gitea gitea admin user create \
  --username '${GITEA_USER}' --password '${GITEA_PASS}' --email '${GITEA_EMAIL}' \
  --admin --must-change-password=false 2>&1 | tail -3 || true
EOF
}

# ----------------------------------------------------------------------------
# Client
# ----------------------------------------------------------------------------
adapter_client_setup() {
  log "installing git + git-lfs and configuring non-interactive auth"
  on_client "PRIV='${SERVER_PRIVATE_IP}' GU='${GITEA_USER}' GP='${GITEA_PASS}' GE='${GITEA_EMAIL}' bash -seuo pipefail" <<'EOF'
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git git-lfs
# Install the LFS filters globally (no repo needed yet).
git lfs install --skip-repo
git config --global user.name "${GU}"
git config --global user.email "${GE}"
git config --global init.defaultBranch main
git config --global credential.helper store
git config --global lfs.concurrenttransfers 8
# Store HTTP basic creds so git AND git-lfs authenticate without prompting.
umask 077
printf 'http://%s:%s@%s:3000\n' "${GU}" "${GP}" "${PRIV}" > /root/.git-credentials
chmod 600 /root/.git-credentials
git --version; git lfs version
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
  # Create the empty remote repo via the Gitea API (from the coordinator, over
  # the public IP). auto_init=false keeps it empty so the first push lands main.
  log "creating gitea repo via API"
  curl -sf -XPOST "http://${SERVER_PUBLIC_IP}:3000/api/v1/user/repos" \
    -u "${GITEA_USER}:${GITEA_PASS}" -H 'Content-Type: application/json' \
    -d "{\"name\":\"${REPO_NAME}\",\"private\":false,\"auto_init\":false}" >/dev/null \
    || die "gitea createRepo failed"

  # Initialize the already-extracted tree as a git repo pointed at the server.
  on_client "cd ${TREE_DIR} && git init -b main && git remote add origin '${GIT_REMOTE}'"
}

adapter_add_ignore() {
  on_client "TREE_DIR='${TREE_DIR}' bash -seuo pipefail" <<'EOF'
cd "${TREE_DIR}"
cat > .gitignore <<'IGN'
# Benchmark ignore file
Binaries/
Intermediate/
DerivedDataCache/
Saved/
IGN
cat > .gitattributes <<'ATTR'
# Route large binary asset types through Git LFS (representative UE set).
*.uasset filter=lfs diff=lfs merge=lfs -text
*.umap filter=lfs diff=lfs merge=lfs -text
*.upk filter=lfs diff=lfs merge=lfs -text
*.udk filter=lfs diff=lfs merge=lfs -text
*.png filter=lfs diff=lfs merge=lfs -text
*.jpg filter=lfs diff=lfs merge=lfs -text
*.jpeg filter=lfs diff=lfs merge=lfs -text
*.bmp filter=lfs diff=lfs merge=lfs -text
*.tga filter=lfs diff=lfs merge=lfs -text
*.tif filter=lfs diff=lfs merge=lfs -text
*.tiff filter=lfs diff=lfs merge=lfs -text
*.exr filter=lfs diff=lfs merge=lfs -text
*.hdr filter=lfs diff=lfs merge=lfs -text
*.psd filter=lfs diff=lfs merge=lfs -text
*.wav filter=lfs diff=lfs merge=lfs -text
*.mp3 filter=lfs diff=lfs merge=lfs -text
*.ogg filter=lfs diff=lfs merge=lfs -text
*.fbx filter=lfs diff=lfs merge=lfs -text
*.obj filter=lfs diff=lfs merge=lfs -text
*.ttf filter=lfs diff=lfs merge=lfs -text
*.otf filter=lfs diff=lfs merge=lfs -text
*.bin filter=lfs diff=lfs merge=lfs -text
*.pak filter=lfs diff=lfs merge=lfs -text
*.zip filter=lfs diff=lfs merge=lfs -text
ATTR
git add .gitignore .gitattributes
EOF
}

adapter_submit_ignore() {
  # First revision: commit + push the ignore + LFS attributes (setup, one phase).
  # -q on both: `git commit` otherwise lists every created file ("create mode
  # ...") and push streams per-object progress, flooding the CI log on a tree
  # this size. Errors still surface.
  on_client "cd ${TREE_DIR} && git commit -q -m 'benchmark: ignore + lfs attributes' && git push -q -u origin main"
}

adapter_add_all() {
  # `git add -A` runs the LFS clean filter on matched files, writing pointers and
  # caching objects under .git/lfs/objects. This is the heavy local staging step.
  # (git add is silent by default; the per-file "create mode" lines come from
  # commit, which is quieted below.)
  on_client "cd ${TREE_DIR} && git add -A"
}

adapter_commit_all() {
  # -q suppresses the per-file "create mode ..." summary.
  on_client "cd ${TREE_DIR} && git commit -q -m 'benchmark: full tree'"
}

adapter_submit_all() {
  # The default `git push` re-runs the git-lfs pre-push hook, which on the second
  # (thin-pack) push aborts with a spurious "missing object" even though the repo
  # fscks clean (gitlink count 0, no submodules). So instead: upload the LFS
  # objects explicitly, then push refs with --no-verify (skip the failing hook,
  # LFS is already uploaded) and --no-thin (send a complete pack so the server
  # never has to resolve a delta base it might be missing). On failure, dump
  # targeted diagnostics including whether the "missing" OID is actually local.
  on_client "TREE_DIR='${TREE_DIR}' bash -seuo pipefail" <<'EOF'
cd "${TREE_DIR}"
rc=0
git lfs push --all origin main || rc=$?
git push --no-thin --no-verify || rc=$?
[ "$rc" -eq 0 ] && exit 0

echo "=== submit failed (rc=${rc}); diagnostics ==="
out=$(git push --no-thin --no-verify 2>&1 || true)
printf '%s\n' "$out"
oid=$(printf '%s\n' "$out" | grep -oE 'missing object: [0-9a-f]{40}' | awk '{print $NF}' | head -1)
if [ -n "$oid" ]; then
  echo "--- is reported missing oid ${oid} present locally? ---"
  if git cat-file -t "$oid"; then git cat-file -s "$oid"; else echo "(genuinely missing locally)"; fi
fi
echo "gitlink count: $(git ls-files -s | awk '$1=="160000"' | wc -l)"
git fsck --full 2>&1 | grep -iE 'missing|broken' | head -20 || true
exit "${rc}"
EOF
}

adapter_pull_elsewhere() {
  # Fresh clone into a new directory: fetches git objects then LFS objects via the
  # smudge filter, so it measures a full materialization over the network.
  # -q drops the clone/checkout/LFS progress stream.
  on_client "rm -rf ${PULL_DIR} && git clone -q '${GIT_REMOTE}' ${PULL_DIR}"
}
