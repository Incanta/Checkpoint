---
sidebar_position: 4
---

# Updates

A Docker Compose deployment updates itself from the web app. The containers run a version-independent runtime image that downloads, verifies, and runs signed Checkpoint bundles, so you never pull a new image for a new Checkpoint version. Nothing installs automatically: an instance admin decides when.

## Updating from Admin > Updates

Open **Admin > Updates** as an instance admin. The page shows the running version, the channel, the deployment mode, the storage server's version, and the previous version kept for rollback.

When a newer version is on your channel:

1. Click **Download**. Both the app and storage server bundles are downloaded and their signatures verified while the current version keeps serving. Nothing is interrupted, and a failed download costs no downtime.
2. Once it shows **Downloaded**, click **Install and restart**. Both services exit and Docker's restart policy brings them back on the new version. Because the bundles are already on disk, this is a restart, not a download.
3. On boot, the app applies any new database migrations.

The app checks for new versions 45 seconds after it starts and then every 6 hours (`updates.check-interval-hours`). **Check now** checks immediately.

:::tip Back up first
Take a [database backup](./backups.md) before installing. A rollback does not undo database migrations, so a backup from before the update is the safe way back.
:::

:::warning Restart policy
Both services need `restart: unless-stopped` (the shipped compose file has it). Without it, **Install and restart** stops the services instead of upgrading them.
:::

## Rolling back

The previous version stays on disk, and the **Roll back** section offers **Roll back and restart** to return to it.

Rollback does not reverse database migrations. The page checks whether the database has migrations the previous version doesn't know about:

- If there are none, it says the rollback is safe.
- If there are some, it lists them and asks you to confirm. The older version may fail against the changed schema. Restoring a database backup taken before the update is the safe alternative.
- If it can't tell, it asks you to confirm and to roll back only if you know the update applied no migrations.

`CHECKPOINT_BUNDLE_KEEP` (default `2`) controls how many superseded versions are kept on disk.

## Channels

| Channel   | What it gets                                                       |
| --------- | ------------------------------------------------------------------ |
| `release` | Published releases. The default.                                   |
| `nightly` | Automated builds of the main branch, built on a daily schedule.    |

Set the channel with `CHECKPOINT_BUNDLE_CHANNEL` on **both** services in `docker-compose.yaml`, then `docker compose up -d`:

```yaml
environment:
  CHECKPOINT_BUNDLE_CHANNEL: nightly
```

In a Docker Compose deployment this variable decides the channel. `channel` in `updates.yaml` only applies to deployments that don't run from bundles.

Switching from `nightly` back to `release` does not downgrade. A nightly version is numbered as a prerelease of the next version, so it reads as newer than the current release until that release ships.

## Pinning a version

To hold the instance on one released version, set `CHECKPOINT_BUNDLE_VERSION` on both services:

```yaml
environment:
  CHECKPOINT_BUNDLE_VERSION: 0.5.0
```

The services download that version once and stay on it. The Updates page still tells you when a newer version exists, but it doesn't offer to install it: you change the version in `docker-compose.yaml` and run `docker compose up -d`. Only published releases can be pinned, not nightly builds.

## Email notifications

The app can email when a new version appears on your channel, once per version. It needs email configured (see [Configuration](./configuration.md#emailyaml)). By default it emails the admin who completed first-run setup. To email others, create `config/app/updates.yaml`:

```yaml
notify-emails:
  - ops@example.com
```

## Turning update checks off

To stop checking entirely, put `enabled: false` in `config/app/updates.yaml`. This is the master switch: no checks, no emails, and the Updates page reports nothing available, so nothing can be installed from it either.

## Air-gapped installs

A host without internet access can run a bundle you copy to it:

1. On a connected machine, download from the GitHub release the bundle for each service and its `.sig.json` signature file:
   - `checkpoint-bundle-app-<version>-postgres.tar.zst` (or `-sqlite.tar.zst`, matching `CHECKPOINT_DB_PROVIDER`)
   - `checkpoint-bundle-server-<version>.tar.zst`
2. Put them in a directory on the Checkpoint host, keeping each `.sig.json` next to its bundle.
3. Mount the directory into both services and point each one at its bundle:

   ```yaml
   services:
     app:
       environment:
         CHECKPOINT_BUNDLE_PATH: /bundles/checkpoint-bundle-app-0.5.0-postgres.tar.zst
       volumes:
         - ./bundles:/bundles:ro
     server:
       environment:
         CHECKPOINT_BUNDLE_PATH: /bundles/checkpoint-bundle-server-0.5.0.tar.zst
       volumes:
         - ./bundles:/bundles:ro
   ```

4. Set `enabled: false` in `config/app/updates.yaml`, since the instance can't reach GitHub to check.

Nothing is downloaded in this mode, and the Updates page can't install anything. To update, copy in the new files, change the paths, and run `docker compose up -d`.

:::caution Signature check needs DNS
Bundles are verified against a public key published as a DNS TXT record on `key.checkpointvcs.com`, even in this mode, each time a new bundle is extracted. If the host cannot resolve that name, serve the same TXT record from an internal DNS name and set `CHECKPOINT_BUNDLE_KEY_HOST` to that name on both services.
:::

## Client updates and compatibility

The desktop app, daemon, and CLI update separately from the server: they check GitHub Releases themselves, on a channel each user chooses in the desktop app's settings. See [Desktop app](../clients/desktop-app.md).

Every server publishes the minimum client API version it supports. Each daemon checks every server it is signed in to every 5 minutes. If the daemon is below a server's minimum, it refuses other requests with an "update required" error until it is updated; updating and diagnostics keep working. Newer clients are not blocked by an older server in this check.

In practice: when you update the server, have your team update their clients too, and keep everyone on the same channel as the server.
