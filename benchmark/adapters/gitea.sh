#!/usr/bin/env bash
# Gitea adapter (STUB, not yet implemented).
#
# Gitea is git-based, so the ~50GB payload must go through Git LFS to be
# functional at all. Planned shape:
#   server: run Gitea (docker) on the server droplet; create a user + repo via
#     its API; enable LFS.
#   client: install git + git-lfs, configure the remote to the server's private
#     IP, `git lfs install`.
#   ignore: write .gitignore (and `git lfs track` patterns for large/binary
#     paths) -> `git add` + `git commit` + `git push` for the first version.
#   add_all: `git add -A` over the tracked tree.
#   commit_all: `git commit` (git HAS a separate local commit, distinct from
#     push), so set ADAPTER_SUPPORTS_COMMIT=true and time it.
#   submit_all: `git push` (LFS objects upload here).
#   pull_elsewhere: `git clone` (or `git lfs clone`) into a fresh directory.
#
# NOTE on parity: git's add/commit are local, push is the network step, whereas
# Checkpoint's add stages and submit publishes. The summary table lines these
# up by operation name; document the semantic difference when comparing.

ADAPTER_SUPPORTS_COMMIT="true"

adapter_server_setup() {
  die "gitea adapter not yet implemented"
}
adapter_client_setup()    { die "gitea adapter not yet implemented"; }
adapter_prepare_payload() { die "gitea adapter not yet implemented"; }
adapter_create_repo()     { die "gitea adapter not yet implemented"; }
adapter_add_ignore()      { die "gitea adapter not yet implemented"; }
adapter_submit_ignore()   { die "gitea adapter not yet implemented"; }
adapter_add_all()         { die "gitea adapter not yet implemented"; }
adapter_commit_all()      { die "gitea adapter not yet implemented"; }
adapter_submit_all()      { die "gitea adapter not yet implemented"; }
adapter_pull_elsewhere()  { die "gitea adapter not yet implemented"; }
