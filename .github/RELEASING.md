# Releasing

Everything ships through one workflow: **`.github/workflows/release.yaml`** (shown as "CD" in the Actions tab). It runs nightly on a schedule and can be dispatched by hand.

There are two delivery streams. Clients and servers subscribe to one of them.

| | `nightly` | `release` |
| --- | --- | --- |
| Trigger | Schedule (08:00 UTC) or manual | Manual only |
| Version | `<next patch>-nightly.<YYYYMMDDHHmm>.g<sha>` | Whatever `versions.json` says |
| Server bundles | Signed assets on the rolling `nightly` prerelease | Signed assets on `v<version>` |
| Installers | Rolling `nightly` GitHub prerelease | Draft release `v<version>`, published by hand |
| npm addon | `nightly` dist-tag | `latest` dist-tag |
| Commits to `main` | None | Addon version bump only |

Server builds ship as **signed deployment bundles**, not container images. See [Server deployment](#server-deployment) below.

## What gets built

Three components, defined in **`.github/release-config.json`**:

| Component | Covers | Triggered by |
| --- | --- | --- |
| `longtail-addon` | `@checkpointvcs/longtail-addon` (native prebuilds + TS) | `src/longtail/{addon,wrapper,library}` |
| `server` | App + core-server deployment bundles, docker-compose quickstart | `src/app`, `src/core/{server,common}`, `scripts/bundle/`, `docker-compose/`, root manifests |
| `client` | Desktop installers, headless CLI packages, daemon, tray | `src/clients/{cli,desktop,tray}`, `src/core/{daemon,common}`, `installer/` |

The runtime image is **not** a CD component. `publish-runtime-image.yaml` rebuilds it on pushes that touch `docker/runtime/`, independently of any release.

The addon **cascades** into the other two: `src/app`, `src/core/server`, and `src/core/daemon` all depend on it, so a new addon forces both to rebuild. Server and client are independent of each other.

`src/tests`, `website/`, `benchmark/`, and the `vscode` / `unreal` / `horde` clients are deliberately outside every filter, because nothing in these workflows builds them.

## How "did anything change?" is answered

Each component owns a marker tag, `cd-marker/<component>`, pointing at the commit it was last successfully built from. A run diffs `marker..HEAD` and matches the changed paths against that component's filters. Markers only move for components that actually succeeded, so a failed client is retried tomorrow while a server that shipped stays quiet.

Preview a run locally without touching anything:

```bash
node scripts/detect-changed-components.js                 # against the real markers
node scripts/detect-changed-components.js --base HEAD~20  # against an arbitrary commit
node scripts/detect-changed-components.js --only client   # what a forced run would do
```

A missing marker means "never built through CD" and the component is treated as changed, so the very first run builds everything.

**If a marker drifts** (a bad build got marked, or you want to force a rebuild), delete the tag and the next run rebuilds that component:

```bash
git push --delete origin cd-marker/client
```

## Cutting a release

1. Bump the versions and commit:

   ```bash
   node scripts/set-version.js 0.5.0
   git commit -am "chore: 0.5.0"
   git push
   ```

   Use `--client` / `--server` to move them independently, and the `--*-api` flags when the wire format actually breaks.

2. Run **CD** from the Actions tab with `stream: release`. Leave `components: auto` unless you want to force something.

3. The run publishes the signed server bundles and the npm addon, and leaves a **draft** GitHub release. Review it, then publish.

Publishing the draft is what makes the release real: `releases/latest` moves, the website download page follows it, and clients on the `release` channel start seeing it.

## Nightly specifics

- The rolling `nightly` tag holds exactly one build. Each run moves the tag to the built commit and deletes the previous run's installers, so old assets never accumulate.
- The prerelease is published with `make_latest: false`, so it never displaces `releases/latest`. This is load-bearing: the release channel and the website both read that pointer.
- Nightlies never commit to `main`. When the addon is rebuilt on a nightly, the bumped `package.json` files and refreshed `yarn.lock` travel to the downstream jobs as the `addon-pin` artifact instead.
- The nightly version bumps the patch on purpose. `versions.json` holds the last *released* version, so `0.4.15-nightly.*` would sort *below* the 0.4.15 already installed. Nightlies are prereleases of the version that comes next.

## Channel manifest

Every run publishes `checkpoint-<channel>.json` as a release asset:

- release: <https://github.com/Incanta/Checkpoint/releases/latest/download/checkpoint-release.json>
- nightly: <https://github.com/Incanta/Checkpoint/releases/download/nightly/checkpoint-nightly.json>

It records the current version of each component on that channel, merged so a server-only run leaves the client entry alone. This exists because server builds are container images and have no release asset of their own to compare against, which is what the self-hosted app polls (see below).

## Subscribing to a stream

**Desktop / daemon.** Settings, Updates, Channel. Under the hood this sets `updates.channel` in `~/.checkpoint/daemon.json`; `CHECKPOINT_UPDATE_CHANNEL=nightly` overrides it for one process.

Moving from nightly back to stable does not downgrade. A machine on `0.5.0-nightly.*` reads as newer than the released `0.4.x` and will report "up to date" until 0.5.0 actually ships. Reinstall from the release page if you need to get back sooner.

**Server.** Update awareness is **on by default**. The app polls the channel manifest, surfaces what it finds in Admin, Updates, and emails once per version when a newer server build appears. It never installs anything on its own.

Emailing additionally requires `email.enabled`; with no `notify-emails`, it falls back to whoever completed the initial instance setup. So out of the box you get the panel, and you get mail once SMTP is configured. Tune it in the app's config (see `src/app/config/default/updates.yaml`):

```yaml
channel: release # or nightly
notify-emails:
  - ops@example.com
```

To opt out entirely, set `enabled: false`. That switch covers everything, not just the email: the poller stops, the panel reports nothing available, and its "Check now" button becomes a no-op, so nothing can be installed from the UI either.

## Server deployment

Server builds ship as signed tarballs rather than per-release container images. One version-independent runtime image (`ghcr.io/incanta/checkpoint-runtime:node24`) resolves, verifies and runs the bundle it should be on, so a release publishes three assets instead of rebuilding three images:

```
checkpoint-bundle-app-<version>-sqlite.tar.zst
checkpoint-bundle-app-<version>-postgres.tar.zst
checkpoint-bundle-server-<version>.tar.zst
```

Each has a `.sig.json` sidecar holding an Ed25519 signature over its manifest, which in turn commits to the archive's SHA-256. The runtime verifies against the public key at `key.checkpointvcs.com` (the same trust anchor as license validation) and **refuses to run an unsigned or unverifiable bundle**. CI needs the `BUNDLE_SIGNING_KEY` secret: the base64 PKCS8 DER private key whose public half is that TXT record.

### Three deployment modes

One image, selected by environment:

| Mode | Set | Behavior |
| --- | --- | --- |
| Following | `CHECKPOINT_BUNDLE_CHANNEL=release\|nightly` | Boots the channel's current version, or whatever an admin has activated. Update button enabled. |
| Pinned | `CHECKPOINT_BUNDLE_VERSION=0.5.0` | Downloads that version once and stays. Update button disabled; the version lives in the deployment config. For GitOps and Kubernetes. |
| Local | `CHECKPOINT_BUNDLE_PATH=/bundles/x.tar.zst` | Uses a mounted bundle plus its sidecar. Never touches the network. For air-gapped installs. |

### Updating from the admin panel

Admin, Updates. Download stages and verifies both bundles while the current version keeps serving; Install writes the desired version and exits, and the restart policy brings both containers back on the new bundle. The previous bundle stays on disk (`CHECKPOINT_BUNDLE_KEEP`, default 2), so Roll back is the same restart pointed backwards. Database migrations are **not** reversed, so a rollback across a migration is not safe.

`restart: unless-stopped` is required. Installing an update works by exiting, so without a restart policy Install stops the service instead of upgrading it.

### The runtime ABI

Bundles carry native code (the longtail addon, Prisma query engines) built against a specific Node ABI, glibc and OpenSSL. The image advertises `CHECKPOINT_RUNTIME_ABI`, the bundle manifest records what it was built against, and the bootstrap refuses a mismatch rather than segfaulting on first load. Both strings live in exactly two places and `publish-runtime-image.yaml` fails the build if they drift:

- `docker/runtime/Dockerfile` (`CHECKPOINT_RUNTIME_ABI=`)
- `scripts/bundle/build-bundle.js` (`const RUNTIME_ABI =`)

Changing the Node major is therefore a coordinated change: publish a runtime image on the new ABI tag first, then cut a release whose bundles declare it, then move deployments to the new image tag.

### Migrating from the old images

`ghcr.io/incanta/checkpoint-app` and `ghcr.io/incanta/checkpoint-server` are no longer published, and the Dockerfiles that built them (`src/app/Dockerfile`, `src/core/server/Dockerfile`) have been removed along with `src/app/start-docker.sh`. `docker/runtime/Dockerfile` is now the only image in the repo.

Existing deployments keep running their pulled image until their compose file is updated; see `docker-compose/docker-compose.yaml` for the new shape. The important additions are `CHECKPOINT_COMPONENT`, a channel, and the shared `bundles:/var/lib/checkpoint` volume that both services mount.

### Building a bundle locally

```bash
yarn install
cd src/app && DB_PROVIDER=sqlite node scripts/set-db-provider.mjs && npx prisma generate && yarn build && cd ../..
node scripts/bundle/build-bundle.js --component app --version 0.0.0-dev --provider sqlite --out dist-bundles
```

Without `--sign` the sidecar carries no signature, so the runtime refuses it unless you also set `CHECKPOINT_BUNDLE_ALLOW_UNSIGNED=1`. Only do that against a bundle you built yourself.

## Running one workflow on its own

All the publish workflows still accept `workflow_dispatch`, so a single component can be rebuilt without the orchestrator:

- `Publish Longtail Addon` needs an explicit `version`, and defaults to committing the bump.
- `Publish Server Bundles` defaults to `versions.json` and the `release` stream.
- `Build Installers` defaults to `versions.json` and the `release` stream.
- `Publish Runtime Image` is independent of releases entirely.

These do not move marker tags, so the next nightly may rebuild what you just published.
