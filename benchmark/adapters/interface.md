# VCS adapter contract

Each adapter is a bash file `benchmark/adapters/<vcs>.sh` that is **sourced** by
`benchmark/run-benchmark.sh`. It runs on the GitHub coordinator and drives the
two droplets over SSH using the helpers from `benchmark/lib/common.sh`
(`on_server`, `on_client`, `on_server_script`, `on_client_script`, timing
helpers, etc.).

## Environment provided to every adapter

Set by `provision.sh` / `run-benchmark.sh` before the adapter runs:

- `SERVER_PUBLIC_IP`, `SERVER_PRIVATE_IP`: the server droplet (coordinator uses
  the public IP for SSH and API calls; the client uses the private IP for VCS
  traffic).
- `CLIENT_PUBLIC_IP`: the client droplet (coordinator SSH target).
- `VOLUME_NAME`: name of the block-storage volume mounted at `/data` on the
  client (mounting is done for you by `prepare_client_storage`).
- `WORK_DIR=/data/work`, `TREE_DIR=/data/work/tree`, `PULL_DIR=/data/work/pull`.
- `TARBALL_URL`: the (private DigitalOcean Spaces) payload object.
- `SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY`: credentials for that
  object. `parse_spaces_url` turns `TARBALL_URL` into `SPACES_BUCKET`,
  `SPACES_KEY`, `SPACES_REGION`, `SPACES_ENDPOINT`.
- `REPO_ROOT`: the checked-out repo on the coordinator.
- `CHECKPOINT_VERSION` (may be empty): pin for server images / client source.

## Metadata an adapter may set (before its functions are called)

- `ADAPTER_SUPPORTS_COMMIT` (default `false`): set to `true` for VCS that have a
  separate local commit distinct from the push/submit (e.g. git). When `false`
  the harness records `commit_all` as `null` instead of timing it.

## Functions an adapter must define

Called in this order. Setup functions are untimed; the rest are wrapped in
whole-second timers by the harness.

| Function | Where it runs | Timed? | Purpose |
| --- | --- | --- | --- |
| `adapter_server_setup` | server | no | install + start the VCS server, wait until healthy |
| `adapter_client_setup` | client | no | install the client, point it at the server |
| `adapter_prepare_payload` | client | records `payload_download` + `payload_extract` itself | fetch the Spaces tarball and extract into `TREE_DIR` |
| `adapter_create_repo` | both | no | create the remote repo/workspace |
| `adapter_add_ignore` | client | yes (`add_ignore`) | write the ignore file and stage it |
| `adapter_submit_ignore` | client | yes (`submit_ignore`) | submit the first version (ignore file only) |
| `adapter_add_all` | client | yes (`add_all`) | stage everything not ignored |
| `adapter_commit_all` | client | yes (`commit_all`) if `ADAPTER_SUPPORTS_COMMIT=true` | local commit step (git only) |
| `adapter_submit_all` | client | yes (`submit_all`) | push/submit the full version |
| `adapter_pull_elsewhere` | client | yes (`pull_elsewhere`) | fresh workspace/clone + pull the version |

Any function returning non-zero aborts the run. Stub adapters fail fast in
`adapter_server_setup`.
