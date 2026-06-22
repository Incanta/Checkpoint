#!/usr/bin/env bash
# Lore adapter (STUB, not yet implemented). See https://lore.org.
#
# Planned shape (to be confirmed against Lore's CLI/server docs):
#   server: install/run the Lore server on the server droplet.
#   client: install the Lore client, point it at the server's private IP.
#   ignore: write Lore's ignore file, then create the first version with it.
#   add_all / submit_all: stage the full tree and publish a version.
#   commit_all: set ADAPTER_SUPPORTS_COMMIT appropriately once the model is
#     known (leave unsupported if add->submit is a single logical commit).
#   pull_elsewhere: fresh workspace + pull/sync the version.

ADAPTER_SUPPORTS_COMMIT="false"

adapter_server_setup() {
  die "lore adapter not yet implemented"
}
adapter_client_setup()    { die "lore adapter not yet implemented"; }
adapter_prepare_payload() { die "lore adapter not yet implemented"; }
adapter_create_repo()     { die "lore adapter not yet implemented"; }
adapter_add_ignore()      { die "lore adapter not yet implemented"; }
adapter_submit_ignore()   { die "lore adapter not yet implemented"; }
adapter_add_all()         { die "lore adapter not yet implemented"; }
adapter_commit_all()      { :; }
adapter_submit_all()      { die "lore adapter not yet implemented"; }
adapter_pull_elsewhere()  { die "lore adapter not yet implemented"; }
