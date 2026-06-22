# VCS benchmark harness

Compares version-control systems on a large-asset workload by provisioning two
DigitalOcean droplets (a **server** and a **client**), driving a fixed sequence
of operations over SSH, and recording the durations (whole seconds) of the
operations that matter: staging, committing (where applicable), submitting, and
pulling into a fresh workspace.

The GitHub Actions runner is only a **coordinator**: it provisions, orchestrates
over SSH, collects timings, and tears the droplets down. The 50GB workload lives
on the droplets, never on the runner.

Scope today: **Checkpoint** is implemented end-to-end. `perforce`, `gitea`, and
`lore` are fast-fail stubs (see `adapters/*.sh`).

## How to run

1. Edit `config.json` (this is the single, version-controlled source of truth
   for a run, intentionally not a dispatch input):

   ```json
   {
     "tarball_url": "https://<bucket>.<region>.digitaloceanspaces.com/<key>",
     "region": "sfo3",
     "droplet_size": "c-8",
     "data_volume_gb": 200,
     "vcs": ["checkpoint"],
     "checkpoint_version": "",
     "keep_droplets": false
   }
   ```

   - `tarball_url`: a **private** DigitalOcean Spaces object (virtual-hosted or
     path style). The client authenticates with the Spaces keys to download it.
   - `vcs`: list; each entry runs as an isolated matrix job with its own droplet
     pair. Stubs fail fast.
   - `checkpoint_version`: empty uses the compose `latest` images and the source
     at `HEAD`; set it to pin server image tags.
   - `keep_droplets`: `true` skips teardown (for debugging). **This leaves
     droplets, the volume, and the VPC running and billing until you delete them
     manually.**

2. Commit the config change (so the run is reproducible from history).

3. Run the **VCS Benchmark** workflow (Actions tab, "Run workflow"). There are
   no dispatch inputs by design.

## Required repository secrets

| Secret                      | Purpose                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `DIGITALOCEAN_ACCESS_TOKEN` | doctl provisioning (droplets, volume, VPC, SSH key).                               |
| `SPACES_ACCESS_KEY_ID`      | DigitalOcean Spaces key (distinct from the API token) to read the private tarball. |
| `SPACES_SECRET_ACCESS_KEY`  | Spaces secret for the above.                                                       |

GHCR images (`ghcr.io/incanta/checkpoint-*`) are public, so no registry login is
needed.

## What the run does

1. **Provision** (`lib/provision.sh`): a VPC, two `ubuntu-24-04-x64` droplets in
   it, and a block-storage volume attached to the client (mounted at `/data`).
   All resources are tagged `bench-<run_id>-<attempt>-<vcs>`.
2. **Server setup** (Checkpoint): install Docker, deploy the repo's
   `docker-compose/` bundle (app `:13000`, server `:13001`, Postgres) with the
   private IP templated in, secrets generated, and dev-login enabled. Storage
   uses the default filer-stub mode.
3. **Client setup** (Checkpoint): build the CLI (CMake) and daemon (Node) from
   the repo source shipped via `git archive` of `HEAD`, start the daemon, then
   authenticate headlessly (devLogin to an API token, written to
   `~/.checkpoint/auth.json`) and create the org/repo. This mirrors
   `.github/workflows/test.yaml`.
4. **Payload**: download the Spaces tarball to `/data` and extract into the work
   tree (both timed, reported separately from the VCS operations).
5. **Benchmark** (timed): `add` + submit the ignore file, then `add` the full
   tree, `submit` it, and `pull` it into a fresh workspace.
6. **Report**: a Markdown table in the job summary plus a `timings-<vcs>.json`
   artifact.
7. **Teardown** (`lib/teardown.sh`): destroys everything by ID with a tag sweep
   backstop. Runs even on failure unless `keep_droplets` is true.

## Output schema (`timings.<vcs>.json`)

```json
{
  "vcs": "checkpoint",
  "phases": {
    "add_ignore": 1,
    "submit_ignore": 3,
    "add_all": 1240,
    "commit_all": null,
    "submit_all": 5102,
    "pull_elsewhere": 4310
  },
  "payload": { "payload_download": 600, "payload_extract": 120 },
  "meta": {
    "run_tag": "...",
    "region": "...",
    "droplet_size": "...",
    "recorded_at": "..."
  }
}
```

`commit_all` is `null` for Checkpoint because it has no separate local commit
(`add` stages, `submit` publishes). Git-based adapters will record it.

## Notes, costs, and caveats

- **Client is built from source**, not installed from a `.deb`: the installer
  releases are GitHub _drafts_ with non-anonymous asset URLs, so building from
  the repo `HEAD` (as `test.yaml` does) is the reliable path. Server still uses
  the published GHCR images.
- **Disk sizing**: 50GB download + extraction needs >=150-200GB; hence the
  client volume and `data_volume_gb`. The **server** currently uses its droplet
  base disk for filer-stub storage; for a real 50GB submit it likely needs its
  own large volume too. That is the next thing to add if a full run fills the
  server disk. Start with the smoke run below.
- **Cost**: each matrix job runs two droplets plus a volume for the duration of
  the build + benchmark. Pick `droplet_size`/`data_volume_gb` accordingly and
  remember `keep_droplets: true` keeps billing until manual cleanup.

## Verifying before a full run

- Lint: `bash -n` the scripts and `node --check benchmark/summarize.js`.
- Stub path: set `vcs: ["perforce"]` and dispatch to confirm provision +
  fast-fail + teardown without a full build.
- Smoke run: set `vcs: ["checkpoint"]` with a **small** `tarball_url` to validate
  the whole path cheaply before pointing it at the real 50GB object.
- After any run, confirm no leaks:
  `doctl compute droplet list --tag-name bench-<run_id>-<attempt>-checkpoint`
  (and the same for volumes / the SSH key) should be empty.
