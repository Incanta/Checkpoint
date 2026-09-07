# Releasing

Everything ships through one workflow: **`.github/workflows/release.yaml`** (shown as "CD" in the Actions tab). It runs nightly on a schedule and can be dispatched by hand.

There are two delivery streams. Clients and servers subscribe to one of them.

|                   | `nightly`                                         | `release`                                      |
| ----------------- | ------------------------------------------------- | ---------------------------------------------- |
| Trigger           | Schedule (08:00 UTC) or manual                    | Manual only                                    |
| Version           | `<next patch>-nightly.<YYYYMMDDHHmm>.g<sha>`      | Whatever `versions.json` says                  |
| Server bundles    | Signed assets on the rolling `nightly` prerelease | Signed assets on `v<version>`                  |
| Installers        | Rolling `nightly` GitHub prerelease               | Draft release `v<version>`, published by hand  |
| npm addon         | `nightly` dist-tag                                | `latest` dist-tag                              |
| VS Code extension | `.vsix` on the prerelease, no marketplace publish | Marketplace + Open VSX, `.vsix` on the release |
| Commits to `main` | None                                              | Addon version bump only                        |

Server builds ship as **signed deployment bundles**, not container images. See [Server deployment](#server-deployment) below.

## What gets built

Four components, defined in **`.github/release-config.json`**:

| Component        | Covers                                                          | Triggered by                                                                                |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `longtail-addon` | `@checkpointvcs/longtail-addon` (native prebuilds + TS)         | `src/longtail/{addon,wrapper,library}`                                                      |
| `server`         | App + core-server deployment bundles, docker-compose quickstart | `src/app`, `src/core/{server,common}`, `scripts/bundle/`, `docker-compose/`, root manifests |
| `client`         | Desktop installers, headless CLI packages, daemon, tray         | `src/clients/{cli,desktop,tray}`, `src/core/{daemon,common}`, `installer/`                  |
| `vscode`         | `checkpoint-vscode` extension (`.vsix`)                         | `src/clients/vscode`, `src/core/{daemon,common}`, root manifests                            |

The runtime image is **not** a CD component. `publish-runtime-image.yaml` rebuilds it on pushes that touch `docker/runtime/`, independently of any release.

The addon **cascades** into `server` and `client`: `src/app`, `src/core/server`, and `src/core/daemon` all depend on it, so a new addon forces both to rebuild. It deliberately does **not** cascade into `vscode`: the extension imports `FileStatus`/`FileType` and the `AppRouter` type from the daemon and esbuild bundles them, but nothing in that graph reaches the native addon, so a new addon changes nothing about the `.vsix`. The other three are independent of each other.

`vscode` is separate from `client` rather than folded into it so that a VS Code-only change does not rebuild the four-OS installer matrix, and a CLI-only change does not republish the extension. They still share a version: `scripts/set-version.js` stamps `src/clients/vscode/package.json` from `client_version` along with the other clients.

`src/tests`, `website/`, `benchmark/`, and the `unreal` / `horde` clients are deliberately outside every filter, because nothing in these workflows builds them.

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
- The nightly version bumps the patch on purpose. `versions.json` holds the last _released_ version, so `0.4.15-nightly.*` would sort _below_ the 0.4.15 already installed. Nightlies are prereleases of the version that comes next.

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

Each has a `.sig.json` sidecar holding an Ed25519 signature over its manifest, which in turn commits to the archive's SHA-256. The runtime verifies against the public key published as a DNS TXT record and **refuses to run an unsigned or unverifiable bundle**, because booting a bundle means executing whatever was downloaded.

### Signing keys

The trust anchor is a DNS TXT record. Its default host is `DEFAULT_KEY_HOST` in `scripts/bundle/signing.js` (`key.checkpointvcs.com`), overridable per deployment with `CHECKPOINT_BUNDLE_KEY_HOST`. The key host is deliberately **not** read from the sidecar: a bundle that named its own key host could just name one the attacker controls.

Generate a keypair. This uses the same `crypto` calls the signer and the runtime do, so there is no format to get wrong:

```bash
node -e '
const c = require("crypto");
const { publicKey, privateKey } = c.generateKeyPairSync("ed25519");
console.log("BUNDLE_SIGNING_KEY (repository secret):");
console.log(privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
console.log();
console.log("DNS TXT value (public half):");
console.log(publicKey.export({ type: "spki", format: "der" }).toString("base64"));
'
```

The equivalent with openssl, if you would rather keep the private key in a file:

```bash
openssl genpkey -algorithm ed25519 -outform DER -out bundle-key.der
base64 -w0 < bundle-key.der                                              # BUNDLE_SIGNING_KEY
openssl pkey -inform DER -in bundle-key.der -pubout -outform DER | base64 -w0   # DNS TXT value
```

Then:

1. **Private half → repository secret.** Settings, Secrets and variables, Actions, new secret named `BUNDLE_SIGNING_KEY`. It is 64 base64 characters (a 48-byte PKCS8 DER key). This is the only copy that matters; nothing else needs it, and nothing recovers it if lost. `publish-server-bundles.yaml` declares it `required: true`, so a release fails immediately rather than shipping unsigned.
2. **Public half → DNS TXT.** Publish it as a TXT record on the key host. At 60 characters it fits a single DNS string, so no chunking is needed (the resolver joins chunks anyway).
3. **Check it resolves** before the first release, from somewhere other than the machine that published it:

   ```bash
   dig +short TXT key.checkpointvcs.com
   node -e 'require("./scripts/bundle/signing.js").resolvePublicKey().then(() => console.log("key host OK"))'
   ```

**Rotation** is a coordinated change, not a swap. A running deployment verifies against whatever the TXT record says _right now_, so replacing the record invalidates every bundle already published under the old key, including the one a container would fall back to on its next restart. Publish the new record, re-sign and re-upload the current release's bundles with the new key, and only then retire the old one.

### Signing your own bundles in a fork

A fork cannot sign against `key.checkpointvcs.com`, and should not want to: the point of the check is that only the publisher can produce a bootable bundle. Four things to change:

| What           | Where                                                                                                                                                                                | Why                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Key host       | `DEFAULT_KEY_HOST` in `scripts/bundle/signing.js`, or `CHECKPOINT_BUNDLE_KEY_HOST` on both containers                                                                                | Points verification at a TXT record you control        |
| Signing key    | `BUNDLE_SIGNING_KEY` secret in your fork                                                                                                                                             | Signs the bundles your CD publishes                    |
| Release source | `CHECKPOINT_REPOSITORY` on both containers (default `Incanta/Checkpoint`)                                                                                                            | Where the runtime fetches manifests and assets         |
| Update source  | `repository` in `src/app/config/default/updates.yaml` (config), and `DEFAULT_CONFIG.repository` in `src/core/daemon/src/updater.ts` (source: `daemon.json` carries only the channel) | Where the app and desktop client look for new versions |

Changing `DEFAULT_KEY_HOST` in the source is the sturdier of the first two: `CHECKPOINT_BUNDLE_KEY_HOST` has to be set correctly on every container, and a deployment that misses it falls back to verifying against upstream's key, then fails to boot with a signature error that does not obviously point at a missing env var.

For local testing you do not need a key at all. `build-bundle.js` without `--sign` writes a sidecar with a null signature, and the runtime accepts it only under `CHECKPOINT_BUNDLE_ALLOW_UNSIGNED=1`. Use that for a bundle you built yourself, on that host, and nothing else.

### Three deployment modes

One image, selected by environment:

| Mode      | Set                                          | Behavior                                                                                                                              |
| --------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Following | `CHECKPOINT_BUNDLE_CHANNEL=release\|nightly` | Boots the channel's current version, or whatever an admin has activated. Update button enabled.                                       |
| Pinned    | `CHECKPOINT_BUNDLE_VERSION=0.5.0`            | Downloads that version once and stays. Update button disabled; the version lives in the deployment config. For GitOps and Kubernetes. |
| Local     | `CHECKPOINT_BUNDLE_PATH=/bundles/x.tar.zst`  | Uses a mounted bundle plus its sidecar. Never touches the network. For air-gapped installs.                                           |

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

## VS Code extension

`publish-vscode-extension.yaml` builds `src/clients/vscode` with esbuild, packages it with `@vscode/vsce`, and attaches `checkpoint-vscode-<version>.vsix` to the release for the stream. The extension has no version of its own: it is stamped from `client_version` like every other client.

**Nightly does not publish to a marketplace, and cannot.** Nightly versions carry a semver prerelease suffix and `vsce` refuses them outright ("The VS Marketplace doesn't support prerelease versions"). The Marketplace's own pre-release channel wants a plain `major.minor.patch` with an odd minor, which would mean maintaining a second version scheme for this one component. So a nightly gets the `.vsix` on the rolling prerelease and nothing more:

```bash
gh release download nightly -p 'checkpoint-vscode-*.vsix'
code --install-extension checkpoint-vscode-<version>.vsix
```

Two secrets, both optional, each gating its own step:

| Secret     | Registry            | Get one from                                                                   |
| ---------- | ------------------- | ------------------------------------------------------------------------------ |
| `VSCE_PAT` | VS Code Marketplace | An Azure DevOps PAT for the `incanta` publisher, scoped to Marketplace, Manage |
| `OVSX_PAT` | Open VSX            | An access token from open-vsx.org, for the `incanta` namespace                 |

With neither set, a release still builds and attaches the `.vsix`, and the job summary says which publishes were skipped and why. This is what makes the workflow usable in a fork without it trying to push to someone else's publisher. Open VSX is worth having: it is what Cursor, VSCodium and Windsurf install extensions from. Both registries are handed the same already-packaged `.vsix`, so they cannot serve differing artifacts.

Both publishes pass `--skip-duplicate`, so re-running a release that already went out is a no-op rather than a failure.

## Running one workflow on its own

All the publish workflows still accept `workflow_dispatch`, so a single component can be rebuilt without the orchestrator:

- `Publish Longtail Addon` needs an explicit `version`, and defaults to committing the bump.
- `Publish Server Bundles` defaults to `versions.json` and the `release` stream.
- `Build Installers` defaults to `versions.json` and the `release` stream.
- `Publish VS Code Extension` defaults to `versions.json` and the `release` stream. Untick `publish` to build and attach the `.vsix` without touching either marketplace.
- `Publish Runtime Image` is independent of releases entirely.

These do not move marker tags, so the next nightly may rebuild what you just published.
