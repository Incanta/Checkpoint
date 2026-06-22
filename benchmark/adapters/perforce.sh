#!/usr/bin/env bash
# Perforce Helix Core adapter (STUB, not yet implemented).
#
# Planned shape:
#   server: install p4d (Helix Core) on the server droplet, create a depot.
#   client: install the p4 client, set P4PORT to the server's private IP.
#   ignore: a P4IGNORE file; `p4 add` then `p4 submit` for the first change.
#   add_all: `p4 add` (reconcile) the whole tree.
#   commit_all: not separate in Perforce (add then submit) -> leave unsupported.
#   submit_all: `p4 submit`.
#   pull_elsewhere: a new client workspace + `p4 sync` into a fresh directory.

ADAPTER_SUPPORTS_COMMIT="false"

adapter_server_setup() {
  die "perforce adapter not yet implemented"
}
adapter_client_setup()    { die "perforce adapter not yet implemented"; }
adapter_prepare_payload() { die "perforce adapter not yet implemented"; }
adapter_create_repo()     { die "perforce adapter not yet implemented"; }
adapter_add_ignore()      { die "perforce adapter not yet implemented"; }
adapter_submit_ignore()   { die "perforce adapter not yet implemented"; }
adapter_add_all()         { die "perforce adapter not yet implemented"; }
adapter_commit_all()      { :; }
adapter_submit_all()      { die "perforce adapter not yet implemented"; }
adapter_pull_elsewhere()  { die "perforce adapter not yet implemented"; }
