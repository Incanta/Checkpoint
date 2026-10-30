---
sidebar_position: 1
---

# Deploy with Docker Compose

This page walks through a production-minded Checkpoint server on a single host with Docker Compose: choosing a database, setting addresses and secrets, the first boot, creating the first admin, and putting the server behind HTTPS. If you only want to try Checkpoint on one machine, the [Quickstart](../getting-started/quickstart.md) is shorter.

## What you are deploying

A Checkpoint server is two services plus a database:

| Service    | Purpose                                                                   | Port  |
| ---------- | ------------------------------------------------------------------------- | ----- |
| `app`      | The web app and the API that the desktop app, CLI, and daemon talk to     | 13000 |
| `server`   | The core storage server: receives and serves file content                 | 13001 |
| `postgres` | PostgreSQL database (the default; removed if you opt into SQLite)        | internal only |

Both `app` and `server` run the same image, `ghcr.io/incanta/checkpoint-runtime:node24`. The image carries no Checkpoint code of its own. On boot it downloads the signed Checkpoint bundle for its component, verifies the signature, and runs it. That is also how [updates](./updates.md) work: you install a new version from the web app instead of pulling a new image.

## Requirements

- A host with Docker and the Docker Compose v2 plugin.
- The runtime image is published for `linux/amd64` only, so use an x86-64 host.
- Outbound HTTPS to `github.com` (bundles and the release manifest are downloaded from GitHub Releases) and DNS lookups of `key.checkpointvcs.com` (the TXT record that holds the bundle signing key). For hosts without internet access, see [air-gapped installs](./updates.md#air-gapped-installs).
- Enough disk for your file history if you use the `local` storage mode. See [Storage](./storage.md).

## 1. Download the Compose bundle

Every release publishes a ready-made Compose directory under a permanent URL:

```bash
wget https://github.com/Incanta/Checkpoint/releases/latest/download/checkpoint-docker-compose.tar.gz
tar xzf checkpoint-docker-compose.tar.gz
cd docker-compose
```

It contains:

- `docker-compose.yaml`
- `config/app/`: configuration for the app, mounted at `/app/config`
- `config/server/`: configuration for the storage server, mounted at `/app/config`
- `config/.secrets`: secret values, mounted read-only into both services
- `README.md`: a condensed version of this page

The files in `config/app/` and `config/server/` are merged over the built-in defaults, so they only need the keys you change. See the [configuration reference](./configuration.md) for every key.

:::warning Keep the restart policy
Both services must keep `restart: unless-stopped`. Installing an update works by exiting so Docker restarts the container onto the new version. Without a restart policy, installing an update stops the service instead.
:::

## 2. Choose a database

PostgreSQL is the default and recommended database. SQLite is available for development or a lighter deployment if you accept its limitations. Decide before the first boot: there is no built-in switch between them once the instance has data.

`CHECKPOINT_DB_PROVIDER` on the `app` service picks which app bundle is downloaded (PostgreSQL and SQLite builds are separate), so it must agree with `provider` in `config/app/db.yaml`.

### PostgreSQL (default)

The compose file runs a `postgres` container (`postgres:17-alpine`) with its data on the `postgres-data` volume, and the app is set to `CHECKPOINT_DB_PROVIDER: postgresql`. `config/app/db.yaml` already has `provider: "postgresql"` and `url: "secret|database_url"`.

1. In `docker-compose.yaml`, change `POSTGRES_PASSWORD` from the placeholder.
2. In `config/.secrets`, set the connection string with the same password:

   ```ini
   database_url=postgresql://checkpoint:<password>@postgres:5432/checkpoint
   ```

To use an existing PostgreSQL server instead, remove the `postgres` service and the app's `depends_on`, and point `database_url` at your server.

### SQLite (opt-in)

SQLite keeps the whole database in one file. It needs no extra service, but:

- It allows one writer at a time, so a busy team can see writes wait on each other.
- A live database file cannot be safely copied, so backups mean stopping the app first (see [Backups](./backups.md)).
- Moving to PostgreSQL later is a manual data migration.

To use it:

1. In `docker-compose.yaml`, remove the `postgres` service, the app's `depends_on` block, and the `postgres-data` volume.
2. On the `app` service, set `CHECKPOINT_DB_PROVIDER: sqlite`.
3. In `config/app/db.yaml`, set `provider: "sqlite"`. Keep `url: "secret|database_url"`.
4. In `config/.secrets`, point the database at the `app-data` volume:

   ```ini
   database_url=file:///app/data/db.sqlite
   ```

:::caution
Keep the SQLite file under `/app/data`, which is the `app-data` volume. A relative path would put the database inside the downloaded bundle, which is replaced on update.
:::

The app applies database migrations automatically every time it boots, for either database.

## 3. Set the host address

Browsers and Checkpoint clients connect from outside the Docker network, so the server has to know the address people use to reach it. Replace each `IP_ADDRESS` placeholder with your host's DNS name or IP address:

| File                      | Key                    | What it is                                                                 |
| ------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `config/app/server.yaml`  | `external-url`         | The web app's address, for example `http://checkpoint.lan:13000`           |
| `config/app/storage.yaml` | `backend-url.external` | The storage server's address, for example `http://checkpoint.lan:13001`    |

`backend-url.internal` (`http://checkpoint-server:13001`) is how the app reaches the storage server inside the Docker network. Leave it as is unless you rename the containers.

`external-url` is used for sign-in callbacks, passkeys, and links in emails, so it must be the exact address users type. If you later put Checkpoint behind HTTPS, change both values (see [HTTPS and reverse proxies](#https-and-reverse-proxies)).

## 4. Fill in secrets

`config/.secrets` holds one `name=value` per line. The YAML files refer to these entries with `secret|name`. A line with an empty value counts as missing, so every referenced secret needs a value or startup fails.

Set at least:

```ini
betterauth_secret=<random>
storage_signing_key=<random>
database_url=<see step 2>
```

Generate each random value with `openssl rand -hex 32`. Checkpoint refuses a `betterauth_secret` or `storage_signing_key` that is shorter than 32 characters or a well-known placeholder.

| Secret                 | Used for                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `betterauth_secret`    | Signs sign-in sessions. Anyone who knows it can sign in as anyone. Also encrypts stored integration tokens unless `security.encryption-key` is set. |
| `storage_signing_key`  | Signs the short-lived storage tokens the app issues and the storage server checks. Anyone who knows it can write to any repository.            |
| `database_url`         | The database connection string.                                                                                                               |

Your storage mode may need more (`s3_*` or `r2_*` keys), and email needs `email_smtp_password`. To keep secrets in Vault or a cloud secrets manager instead of a file, see [Configuration](./configuration.md#secrets).

:::danger
Keep `config/.secrets` out of version control and back it up with your [backups](./backups.md). Restoring without the same `betterauth_secret` signs everyone out, and stored integration tokens can no longer be decrypted.
:::

## 5. Choose a storage mode

By default, file content is stored on the storage server's own disk (the `storage-data` volume). You can also use any S3-compatible store or Cloudflare R2. Pick before you create repositories: existing content is not moved if you change modes later. See [Storage](./storage.md).

## 6. Start the server

```bash
docker compose up -d
docker compose logs -f app
```

The first boot takes noticeably longer than later ones. Each service reads the release channel manifest, downloads its bundle from GitHub, verifies the signature, and extracts it to the shared `bundles` volume. The logs show each step, for example `Signature verified against the published key`, then `Running database migrations...` on the app. Later restarts reuse the extracted bundle.

When the app is up, open the `external-url` you configured, for example `http://checkpoint.lan:13000`.

If a service exits right away, the log line starting with `[bootstrap] FATAL` or `Refusing to` names the problem. Common causes are a missing secret, a placeholder or short signing key, and a `CHECKPOINT_DB_PROVIDER` that does not match the bundle.

## 7. Create the first admin

1. On the sign-in page, choose **Sign up** and create an account. The first account created on an instance is always allowed to register and becomes the instance admin. This works with any sign-in method you have enabled.
2. You are taken to the **Welcome to Checkpoint** setup page. It asks one question: whether to share anonymous usage metrics (weekly aggregate counts of organizations, repositories, and users, plus a random instance id). Reports are only sent if `telemetry.enabled` is also `true` in the app config, and it is `false` by default.
3. Click **Continue**.

Until setup is completed, nobody else can register. After that, registration follows `auth.invite-only`, which defaults to `"admin"`: only people an instance admin invites can create accounts. See [Authentication](./authentication.md) to change sign-up rules or add single sign-on, and [Organizations and access](./organizations-and-access.md) to create your organization, repositories, and invites.

The admin who completes setup is also who update emails go to by default. See [Updates](./updates.md).

## Network and firewall

Open these ports from your users' machines (and from CI agents) to the Checkpoint host:

| Port  | Service  | Who connects                                                                  |
| ----- | -------- | ----------------------------------------------------------------------------- |
| 13000 | `app`    | Browsers, the desktop app, the daemon, the CLI, and integrations              |
| 13001 | `server` | The daemon and CLI, to upload and download content and to submit changelists |

Clients need port 13001 in every storage mode. In `r2` mode they also download and upload file content directly from Cloudflare R2 (`<account-id>.r2.cloudflarestorage.com`), so they need outbound HTTPS to it.

The database port is not published. The Checkpoint host itself needs outbound HTTPS to GitHub for bundles and update checks, DNS for `key.checkpointvcs.com`, your SMTP server if email is enabled, and `api.cloudflare.com` in `r2` mode.

### LAN and remote users

If some users are on the same LAN as the server and others connect from outside, set `backend-url.external-lan` in `config/app/storage.yaml` to the server's LAN address, for example `http://10.0.0.10:13001`. The daemon uses it when it can reach it over HTTP and falls back to `backend-url.external` otherwise. Leave it `null` to disable.

## HTTPS and reverse proxies

Checkpoint does not terminate TLS itself. To serve it over HTTPS, put a reverse proxy (nginx, Caddy, Traefik, or similar) in front of both services. Use two hostnames, one per service:

| Hostname (example)                  | Proxies to         | Config key                                     |
| ----------------------------------- | ------------------ | ---------------------------------------------- |
| `https://checkpoint.example.com`    | `app` on 13000     | `external-url` in `config/app/server.yaml`     |
| `https://checkpoint-backend.example.com` | `server` on 13001 | `backend-url.external` in `config/app/storage.yaml` |

Then:

1. Set both config values to the HTTPS addresses and restart: `docker compose restart app server`.
2. Allow large request bodies on the storage hostname. Clients upload content in blocks of up to `target-block-size` (8 MiB by default).
3. Optionally stop publishing the ports to the network. For example, change `"13000:13000"` to `"127.0.0.1:13000:13000"` when the proxy runs on the same host.

Passkeys only work when `external-url` is the HTTPS origin users browse to, or `http://localhost`. If you register an identity provider, its callback URL is built from `external-url` too, so set it before configuring SSO.

## Where data lives

| Volume or path    | Holds                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `app-data`        | The SQLite database, if you opted into SQLite                                                  |
| `postgres-data`   | The PostgreSQL database (default setup)                                                        |
| `storage-data`    | File content in `local` storage mode                                                           |
| `bundles`         | Downloaded Checkpoint versions and the record of which one should run. Safe to delete: it forces a fresh download on next boot. |
| `config/`         | Your configuration and secrets                                                                 |

See [Backups](./backups.md) for what to back up and in what order.

## Next steps

- [Storage](./storage.md): use S3-compatible storage or Cloudflare R2.
- [Configuration](./configuration.md): email, logging, secrets providers, and every other setting.
- [Authentication](./authentication.md): sign-up rules, two-factor, passkeys, and SSO.
- [Updates](./updates.md): keep the server current from the web app.
- [Backups](./backups.md): set these up before your team starts submitting work.
- [Desktop app](../clients/desktop-app.md): install the client and connect it to your server.
