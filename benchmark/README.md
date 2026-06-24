# VCS benchmark harness

Compares version-control systems on a large-asset workload by provisioning two
DigitalOcean droplets (a **server** and a **client**), driving a fixed sequence
of operations over SSH, and recording the durations (whole seconds) of the
operations that matter: staging, committing (where applicable), submitting, and
pulling into a fresh workspace.

The GitHub Actions runner is only a **coordinator**: it provisions, orchestrates
over SSH, collects timings, and tears the droplets down. The 50GB workload lives
on the droplets, never on the runner.

Scope today: five adapters are implemented end-to-end: **Checkpoint**, **Lore**
(Epic Games' Lore VCS), **Gitea** (git + Git LFS), **Perforce** (Helix Core),
and **Ark** (Ark VCS). See `adapters/*.sh`.

## How to run

1. Edit `config.json` (this is the single, version-controlled source of truth
   for a run, intentionally not a dispatch input):

   ```json
   {
     "tarball_url": "https://<bucket>.<region>.digitaloceanspaces.com/<key>",
     "region": "sfo3",
     "droplet_size": "c-8",
     "data_volume_gb": 400,
     "server_volume_gb": 200,
     "small_change_file": "",
     "vcs": ["checkpoint"],
     "checkpoint_version": "",
     "keep_droplets": false
   }
   ```

   - `tarball_url`: a **private** DigitalOcean Spaces object (virtual-hosted or path style). The client authenticates with the Spaces keys to download it.
   - `data_volume_gb`: size of the **client** volume (working copy plus per-VCS caches; LFS roughly doubles it for Gitea, and the fresh pull doubles it again).
   - `server_volume_gb`: size of the **server** volume mounted at `/data`, where every adapter keeps its backend storage (the submitted payload, stored once).
   - `small_change_file`: relative path (under the payload tree) of a file to make a ~100-byte change to after the initial submit. The run then submits that change and records how many bytes the **server** store grew (delta/dedup efficiency). Empty = skip this stage. Pick a large binary asset to make the difference meaningful. This stage is untimed; it only affects the storage-delta metric, never the timing metrics.
   - `vcs`: list; each entry runs as an isolated matrix job with its own droplet pair.
   - `checkpoint_version`: empty uses the compose `latest` images and the source at `HEAD`; set it to pin server image tags.
   - `keep_droplets`: `true` skips teardown (for debugging). **This leaves both droplets, both volumes, and the VPC running and billing until you delete them manually.**

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

1. **Provision** (`lib/provision.sh`): a VPC, two `ubuntu-24-04-x64` droplets in it, and two block-storage volumes, one attached to the client and one to the server, each mounted at `/data` on its droplet. All resources are tagged `bench-<run_id>-<attempt>-<vcs>`.
2. **Server setup** (Checkpoint): install Docker, point its `data-root` at the
   server volume (`/data/docker`) so the named volumes land there, then deploy
   the repo's `docker-compose/` bundle (app `:13000`, server `:13001`, Postgres)
   with the private IP templated in, secrets generated, and dev-login enabled.
   Storage uses the default filer-stub mode.
3. **Client setup** (Checkpoint): build the CLI (CMake) and daemon (Node) from
   the repo source shipped via `git archive` of `HEAD`, start the daemon, then
   authenticate headlessly (devLogin to an API token, written to
   `~/.checkpoint/auth.json`) and create the org/repo. This mirrors
   `.github/workflows/test.yaml`.
4. **Payload**: download the Spaces tarball to `/data` and extract into the work
   tree (both timed, reported separately from the VCS operations).
5. **Benchmark** (timed): `add` + submit the ignore file, then `add` the full
   tree, `submit` it, run `status` on the clean tree (its own phase, not part of
   the submit total), and `pull` it into a fresh workspace. Across the whole
   full-tree publish (add + commit + submit), a lightweight sampler records
   whole-system CPU% and used RAM (GB) on both droplets every 30s (from `/proc`)
   for the resource charts. It spans all three phases because the heavy work
   lands in different phases per VCS (e.g. Lore commits locally then pushes in
   seconds).
6. **Pull verification** (right after the pull, untimed): a cheap deterministic
   fingerprint of the pulled tree, the sha256 of a sorted `path\tsize` manifest
   of every payload file (VCS metadata and per-VCS ignore/config files
   excluded). The same payload yields the same hash across all VCS, so a
   mismatch or a smaller file count flags a VCS that did not materialize the
   full content. Metadata only (no byte reads), so it is cheap; it catches
   missing/truncated/extra files but not same-size byte corruption.
7. **Small update** (only if `small_change_file` is set): measure the server
   store size, make a ~100-byte change to that file, then submit it. The submit
   is timed on its own (the `update_submit` phase). The server store is then
   measured again and the byte delta recorded. The storage measurement and
   settle wait stay outside the timer, so only the submit itself is timed and no
   other metric is affected.
8. **Report**: Markdown tables in the job summary (including the pull-verification
   table, which should show identical hashes across VCS), plus Mermaid `xychart`
   resource graphs (CPU% and RAM, two line series each: blue = client, green =
   server; x-axis in minutes). Artifacts: `timings.<vcs>.json` (timings +
   embedded resource samples + verification) and `resources.<vcs>.json` (raw
   CPU/RAM samples).
9. **Teardown** (`lib/teardown.sh`): destroys everything by ID with a tag sweep
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
    "status": 30,
    "pull_elsewhere": 4310,
    "update_submit": 8
  },
  "payload": { "payload_download": 600, "payload_extract": 120 },
  "storage": { "update_delta_bytes": 65536 },
  "resources": {
    "interval_s": 30,
    "client": [{ "t": 0, "cpu_pct": 80, "ram_gb": 3.1 }],
    "server": [{ "t": 0, "cpu_pct": 20, "ram_gb": 1.2 }]
  },
  "verify": {
    "pull_manifest_sha256": "…",
    "pull_file_count": 193925,
    "pull_bytes": 52821000000
  },
  "meta": {
    "run_tag": "...",
    "region": "...",
    "droplet_size": "...",
    "recorded_at": "..."
  }
}
```

`commit_all` is `null` for Checkpoint because it has no separate local commit (`add` stages, `submit` publishes). **Lore** records `commit_all` as a real phase: `add` is `lore stage --scan .`, `commit_all` is `lore commit`, and `submit_all` is `lore push`.

`storage.update_delta_bytes` is the server store growth (bytes) from the ~100-byte change to `small_change_file`. It is a storage measurement only (untimed), and is rendered as its own "Server storage delta" table with the Checkpoint comparison. The `storage` object is absent when `small_change_file` is empty.

## Lore adapter notes

- **Install**: prebuilt `lore` CLI and `loreserver` binaries from the public EpicGames/lore GitHub releases (the official `install.sh`), no build step.
- **Server**: `loreserver` runs non-demo from a small TOML config (cert + a node-local store under `/data/lore-store` on the server volume). QUIC and gRPC share `:41337`; HTTP health is `:41339/health_check`.
- **TLS**: the client URL uses the plain `lore://` scheme. Lore only verifies the server certificate when the scheme ends in `s` (`lores://`), so `lore://` skips verification, the same trust model the official quickstart uses. That avoids distributing a CA to reach the server over the private VPC IP. The server still presents a self-signed cert (private IP in the SAN).
- **Ignore file**: `.loreignore`, gitignore-style patterns.

## Gitea adapter notes

- **Install**: server is the official `gitea/gitea` Docker image (SQLite, LFS server on, install lock set); client uses `git` + `git-lfs` from apt.
- **Auth**: HTTP basic, stored once in `/root/.git-credentials` so neither `git` nor `git-lfs` prompts. The benchmark user is created with `gitea admin user create`; the repo is created over the API.
- **LFS**: large binary asset types (a representative Unreal set: `*.uasset`, `*.umap`, textures, audio, models, etc.) are routed through Git LFS via a committed `.gitattributes`. Source/config files stay as normal git objects, matching a real Unreal-on-git workflow. Files whose extensions are not in that list go through plain git, so adjust `.gitattributes` in the adapter if a payload has other large types.
- **Phases**: git separates local commit from network push, so all three are timed: `add_all` = `git add -A` (runs the LFS clean filter), `commit_all` = `git commit`, `submit_all` = `git push` (LFS objects upload here).
- **Disk**: git-lfs keeps a local object cache (`.git/lfs/objects`) on top of the working copy, so a tracked tree costs roughly 2x its size on the client, and the fresh pull doubles that again. Budget a larger `data_volume_gb` for Gitea than for Checkpoint/Lore at the same payload size. The server's repo + LFS storage (`/data/gitea`) lives on the server volume.

## Perforce adapter notes

- **Install**: server is the `helix-p4d` package from Perforce's APT repo, configured headless via `configure-helix-p4d.sh` (plaintext `:1666`, a superuser); client is the `helix-cli` package (`p4`). A fresh p4d auto-creates the default `//depot`.
- **Auth**: connection settings persist in `~/.p4enviro` (`p4 set P4PORT/P4USER`), and a login ticket in `~/.p4tickets` is obtained from the superuser password so commands never prompt. Plaintext (no SSL/`p4 trust`) over the private VPC IP.
- **Phases**: Perforce has no separate local commit, so `commit_all` is `null` (same as Checkpoint). `add_all` = `p4 reconcile -a` (opens every new, non-ignored file for add, honoring `P4IGNORE`), `submit_all` = `p4 submit` (upload + server archive in one step).
- **Ignore file**: `.p4ignore` (set via `P4IGNORE`), gitignore-style patterns.
- **Pull**: a second client workspace rooted at a fresh directory, then `p4 sync` to materialize the head revision. `P4ROOT` (db + depot archives) lives under `/data/perforce` on the server volume.

## Ark adapter notes

- **Install**: server and client are the same `ark` binary from the published Linux zip. The server runs `ark server -path /data/ark -port 9000 -allow_dv_upgrade true -allow_non_empty_path true` (data on the server volume); the client uses `ark init`/`changes`/`commit`/`get-latest`.
- **Model**: centralized with a shelve-then-commit flow. `ark commit` uploads (shelves) the changelist and marks it committed in one step, so `commit_all` is `null` (like Checkpoint/Perforce). Change detection is automatic, so `add` maps to `ark changes` (workspace scan) and `submit` to `ark commit` (the upload).
- **Ignore file**: `.ark_ignore` (`*` globs, `!` negation, `#` comments).
- **Caveats (may need a CI iteration)**: the CLI prompts for a password with no flag/env, so the adapter feeds it over a pseudo-tty via `script`; `ark commit` needs a `-ws_cl` id which the adapter parses from `ark changes` (best-effort, adjust to the real output if needed); and the server's auto-generated self-signed cert is assumed to be trusted on connect. These are documented inline in `adapters/ark.sh`.

## Notes, costs, and caveats

- **Client is built from source**, not installed from a `.deb`: the installer
  releases are GitHub _drafts_ with non-anonymous asset URLs, so building from
  the repo `HEAD` (as `test.yaml` does) is the reliable path. Server still uses
  the published GHCR images.
- **Disk sizing**: the droplet base disk is small (a `c-8` ships ~25GB), so all bulk storage is on the attached volumes. The **client** volume (`data_volume_gb`) holds the download, the extracted tree, per-VCS caches, and the fresh pull, so size it well above the payload (the committed default is 400GiB for a ~50GB payload). The **server** volume (`server_volume_gb`) holds the submitted payload once; 150-200GiB is comfortable. Every adapter mounts its volume at `/data` and keeps its backend there.
- **Cost**: each matrix job runs two droplets plus two volumes for the duration of the build + benchmark. Pick `droplet_size`, `data_volume_gb`, and `server_volume_gb` accordingly, and remember `keep_droplets: true` keeps billing until manual cleanup.

## Verifying before a full run

- Lint: `bash -n` the scripts and `node --check benchmark/summarize.js`.
- Smoke run: set `vcs` to the adapter under test with a **small** `tarball_url` to validate the whole path (provision, server up, client setup, ignore + full submit, pull, summary, teardown) cheaply before pointing it at the real 50GB object. All four adapters are implemented, so there is no longer a fast-fail stub path.
- After any run, confirm no leaks:
  `doctl compute droplet list --tag-name bench-<run_id>-<attempt>-checkpoint`
  (and the same for volumes / the SSH key) should be empty.
