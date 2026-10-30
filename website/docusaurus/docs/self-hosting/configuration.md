---
sidebar_position: 3
---

# Configuration

This page lists every configuration file for the Checkpoint app and storage server, what each key does, and its default. For a first deployment, start with [Deploy with Docker Compose](./deploy-docker-compose.md).

## How configuration is loaded

Both services read YAML files. Each file name becomes the first part of the key, so `email.yaml` holds the `email.*` keys and `smtp.host` inside it is `email.smtp.host`.

Every Checkpoint version ships its own defaults. In the Docker Compose bundle, your files are mounted over them:

- `config/app/` is merged over the app's defaults.
- `config/server/` is merged over the storage server's defaults.

You only need the keys you change. To change one key in a file you don't have yet, create the file with just that key. Objects merge key by key, but **lists replace the default list entirely**, so to add one item to a list you must repeat the whole list.

After editing, restart the affected service: `docker compose restart app` or `docker compose restart server`.

## Secrets

Any of the keys marked "secret reference OK" below can hold `secret|name` instead of a literal value. Checkpoint then looks `name` up through the secrets provider configured in that service's `secrets.yaml`. Fetched values are cached for `cache-duration-seconds` (default `1800`).

| `provider`             | Where secrets come from                                   | Authentication and settings                                                                                                            |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `none`                 | Nowhere; references are not resolved. The default outside Docker Compose. | None                                                                                                                  |
| `local`                | A `name=value` file. The Compose bundle's choice.         | `local.file-path`, `/app/.secrets` in Compose (relative paths resolve against the process's working directory)                          |
| `vault`                | HashiCorp Vault KV                                        | AppRole: `VAULT_ROLE_ID` and `VAULT_SECRET_ID` environment variables. Settings: `vault.endpoint`, `vault.namespace`, `vault.path-prefix`, `vault.kv-engine` (`v1` or `v2`), `vault.engine-name` |
| `aws-secrets-manager`  | AWS Secrets Manager (the secret's string value)           | The AWS SDK's default credential chain, for example `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. See the note below about the region. |
| `azure-key-vault`      | Azure Key Vault                                           | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` environment variables. Setting: `azure-key-vault.endpoint`              |
| `gcp-secret-manager`   | Google Cloud Secret Manager (latest version)              | `GOOGLE_APPLICATION_CREDENTIALS`, or a service account key file at `gcp-secret-manager.credentials-file`. Setting: `gcp-secret-manager.project-id` |

The app and the storage server each have their own `secrets.yaml`, so configure both.

The local secrets file has one `name=value` per line. Blank lines and lines starting with `#` are ignored, and a line with an empty value counts as missing. A reference that cannot be resolved stops the feature that needs it, and for the core secrets, startup.

:::note AWS region
The current AWS provider reads its region from `secrets.aws-kms.region`, not `secrets.aws-secrets-manager.region`. Set `aws-kms.region` in `secrets.yaml` when you use AWS Secrets Manager.
:::

Environment variables such as `VAULT_ROLE_ID` go in the service's `environment:` block in `docker-compose.yaml`.

## Environment variables

Configuration lives in YAML. These environment variables are read directly and take precedence over the matching key:

| Variable                         | Service        | Overrides                                     |
| -------------------------------- | -------------- | --------------------------------------------- |
| `CHECKPOINT_AUTH_SECRET`         | app            | `auth.secret`                                 |
| `CHECKPOINT_STORAGE_SIGNING_KEY` | app and server | `storage.jwt.signing-key` (set it on both)    |
| `CHECKPOINT_STORAGE_INDEX_KEY`   | server         | `storage.index.signing-key`                   |

The runtime image reads these to decide what to run. See [Updates](./updates.md) for details.

| Variable                           | Default              | Meaning                                                                                            |
| ---------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `CHECKPOINT_COMPONENT`             | (required)           | `app` or `server`                                                                                  |
| `CHECKPOINT_DB_PROVIDER`           | `sqlite` in the image | `postgresql` or `sqlite`. Selects the app bundle. Must match `db.provider`.                        |
| `CHECKPOINT_BUNDLE_CHANNEL`        | `release`            | `release` or `nightly`. Set the same value on both services.                                       |
| `CHECKPOINT_BUNDLE_VERSION`        | unset                | Pin both services to one released version. Disables installing updates from the web app.           |
| `CHECKPOINT_BUNDLE_PATH`           | unset                | Run a bundle file you mounted, for air-gapped installs                                             |
| `CHECKPOINT_BUNDLE_KEEP`           | `2`                  | How many superseded versions to keep on disk for rollback                                          |
| `CHECKPOINT_BUNDLE_KEY_HOST`       | `key.checkpointvcs.com` | DNS name whose TXT record holds the bundle signing public key                                   |

Other environment variables are not read as configuration. The app's `environment.yaml` works the other way around: it passes a few config values (`db.url` as `DATABASE_URL`, `db.provider`, `server.listen-port`, and `server.external-url`) to the app process as environment variables, so you don't set those variables yourself.

## App configuration (`config/app/`)

### server.yaml

| Key            | Default                  | Meaning                                                                                                   |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `listen-port`  | `13000`                  | Port the app listens on inside the container. Change the Compose port mapping with it.                    |
| `external-url` | `http://localhost:13000` | The address users browse to. Used for sign-in callbacks, passkeys, and links in emails.                   |

### db.yaml

| Key        | Default (built-in)    | Compose bundle         | Meaning                                                    |
| ---------- | --------------------- | ---------------------- | ---------------------------------------------------------- |
| `provider` | `sqlite`              | `postgresql`           | `postgresql` or `sqlite`. Must match `CHECKPOINT_DB_PROVIDER`. |
| `url`      | `file:./db.sqlite`    | `secret\|database_url` | Database connection URL. Secret reference OK.              |

See [Choose a database](./deploy-docker-compose.md#2-choose-a-database).

### auth.yaml

| Key           | Default   | Meaning                                                                                                    |
| ------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `secret`      | (none)    | Signs sign-in sessions. Required, at least 32 random characters. Secret reference OK.                      |
| `invite-only` | `"admin"` | Who may register: `"public"`, `"member"`, or `"admin"`.                                                    |
| `dev.allow-dev-login` | `false` | For automated tests only. Never enable in production.                                              |

Sign-in methods, two-factor, passkeys, and identity providers (`email-password`, `okta`, `auth0`, `google`, `microsoft-entra-id`, `keycloak`, `oidc`) are covered in [Authentication](./authentication.md).

### storage.yaml

| Key                        | Default                 | Meaning                                                                                              |
| -------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `mode`                     | `local`                 | `local`, `s3`, or `r2`. Must match the server's.                                                      |
| `jwt.signing-key`          | (none)                  | Signs storage tokens. Required, the same as the server's. Secret reference OK.                        |
| `token-expiration-seconds` | `3600`                  | Lifetime of a storage token.                                                                         |
| `verify-version-index`     | `true`                  | Before recording a changelist, confirm with the storage server that its content is stored. Leave on. |
| `backend-url.internal`     | `http://localhost:13001` (Compose: `http://checkpoint-server:13001`) | How the app reaches the storage server.                       |
| `backend-url.external`     | `http://localhost:13001` | The storage server address clients use.                                                             |
| `backend-url.external-lan` | `null`                  | Optional LAN address the daemon prefers when it can reach it.                                        |
| `r2.account-id`, `r2.access-key-id`, `r2.secret-access-key`, `r2.api-token` | empty | For `r2` mode. The credential keys accept secret references.                          |
| `r2.location-override`     | unset                   | Optional R2 location hint for new buckets.                                                           |

See [Storage](./storage.md).

### longtail.yaml

How content is chunked, hashed, and compressed for the whole instance. Each repository keeps the values it was first used with. See [Storage](./storage.md#content-format-longtailyaml) for the keys and defaults.

### state-tree.yaml

| Key                 | Default                  | Meaning                                                                                                    |
| ------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `block-store`       | `"storage"`              | Where file-tree snapshot blocks are stored: `"storage"` (the storage backend) or `"postgres"` (the database). |
| `block-cache-bytes` | `134217728` (128 MiB)    | Memory cap for the in-process cache of these blocks.                                                       |
| `incremental`       | `"verify"`               | How a submit computes the new tree: `"on"` (update changed paths), `"verify"` (do that, also rebuild fully and log any `[state-tree] MISMATCH`), or `"off"` (always rebuild). |

### binary-extensions.yaml

`defaults` is the list of file extensions treated as binary (never auto-merged). It ships with common image, audio, video, 3D, archive, Unreal, and executable extensions. Because lists replace rather than merge, copy the whole default list from your current version if you only want to add to it.

### email.yaml

Email is off by default. Invitations, notifications, and update alerts are sent only when it is on.

| Key                | Default               | Meaning                                                                                   |
| ------------------ | --------------------- | ----------------------------------------------------------------------------------------- |
| `enabled`          | `false`               | Turn email on.                                                                            |
| `smtp.host`        | empty                 | SMTP server. Email stays off while this is empty.                                         |
| `smtp.port`        | `587`                 | SMTP port.                                                                                |
| `smtp.secure`      | `false`               | `true` for implicit TLS (usually port 465). Leave `false` for STARTTLS on 587.            |
| `smtp.auth.user`   | empty                 | SMTP user name. Authentication is used only when both user and password are set.          |
| `smtp.auth.pass`   | empty (Compose: `secret\|email_smtp_password`) | SMTP password. Secret reference OK.                              |
| `from.name`        | `Checkpoint VCS`      | Sender name.                                                                              |
| `from.address`     | `noreply@example.com` | Sender address. Change it to an address your SMTP server may send as.                     |

Example:

```yaml
# config/app/email.yaml
enabled: true
smtp:
  host: "smtp.example.com"
  port: 587
  secure: false
  auth:
    user: "checkpoint@example.com"
    pass: "secret|email_smtp_password"
from:
  name: "Checkpoint"
  address: "checkpoint@example.com"
```

Then add `email_smtp_password=...` to `config/.secrets`.

### updates.yaml

| Key                    | Default              | Meaning                                                                                                         |
| ---------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `enabled`              | `true`               | Master switch for update checks, emails, and installing from **Admin > Updates**.                               |
| `channel`              | `release`            | `release` or `nightly`. In a Docker Compose deployment, `CHECKPOINT_BUNDLE_CHANNEL` decides instead.            |
| `check-interval-hours` | `6`                  | How often to check (minimum 1).                                                                                 |
| `notify-emails`        | `[]`                 | Who to email about a new version. Empty means the admin who completed setup. Requires email.                     |
| `repository`           | `Incanta/Checkpoint` | GitHub repository to check.                                                                                      |
| `manifest-url`         | empty                | Override the channel manifest URL, for mirrors.                                                                 |
| `nightly-tag`          | `nightly`            | Release tag of the nightly build.                                                                               |

See [Updates](./updates.md).

### logging.yaml

The same keys apply to the app and the storage server.

| Key                          | Default                | Meaning                                                                                       |
| ---------------------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| `level`                      | `info`                 | Lowest level written to standard output: `trace`, `debug`, `info`, `warn`, `error`, or `fatal`. |
| `longtail-level`             | `off`                  | Log level of the native content engine: `debug`, `info`, `warn`, `error`, or `off`.            |
| `prettify.enabled`           | `true`                 | Human-readable, colored output. Turn off for one JSON object per line.                        |
| `prettify.*`                 | (see defaults)         | Formatting options passed to pino-pretty, such as `colorize`, `translateTime`, and `singleLine`. |
| `log-file.enabled`           | `false`                | Also write to a file.                                                                         |
| `log-file.level`             | `trace`                | Lowest level written to the file.                                                             |
| `log-file.path`              | `logs/checkpoint.log`  | File path. Relative paths resolve against the process's working directory, which is inside the bundle, so use an absolute path on a volume. |
| `log-file.max-archived-files`| `10`                   | Older log files to keep; `-1` keeps all.                                                      |

In Docker Compose, logs go to standard output, so `docker compose logs app server` shows them.

### security.yaml

| Key              | Default | Meaning                                                                                                                                                       |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encryption-key` | empty   | Encrypts stored integration secrets, such as issue tracker API tokens. 32 random bytes, base64 encoded (`openssl rand -base64 32`). Secret reference OK. When empty, a key is derived from `auth.secret`, so changing that secret means re-entering those tokens. |

### telemetry.yaml, newsletter.yaml, and stripe.yaml

These are off by default and a self-hosted instance does not need them.

- `telemetry.enabled` (default `false`): send a weekly anonymous report (organization, repository, and user counts plus a random instance id) to `telemetry.endpoint-url`. Reports also require the admin to have opted in during first-run setup.
- `newsletter.kit.enabled` (default `false`): newsletter signup through Kit.
- `stripe.enabled` (default `false`): billing. Used by Checkpoint's hosted service.

## Storage server configuration (`config/server/`)

### server.yaml

| Key           | Default | Meaning                                     |
| ------------- | ------- | ------------------------------------------- |
| `listen-port` | `13001` | Port the storage server listens on.         |

### checkpoint.yaml

| Key                | Default (built-in)       | Compose bundle               | Meaning                               |
| ------------------ | ------------------------ | ---------------------------- | ------------------------------------- |
| `api.url.internal` | `http://localhost:13000` | `http://checkpoint-app:13000` | How the storage server reaches the app. |

### storage.yaml

| Key                       | Default            | Meaning                                                                                         |
| ------------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `mode`                    | `local`            | `local`, `s3`, or `r2`. Must match the app's.                                                   |
| `jwt.signing-key`         | (none)             | Verifies storage tokens. Required, the same as the app's. Secret reference OK.                   |
| `local.path`              | `./data/storage` (Compose: `/app/data`) | Content directory in `local` mode.                                         |
| `s3.endpoint`, `s3.region`, `s3.bucket`, `s3.force-path-style`, `s3.access-key-id`, `s3.secret-access-key` | empty, `force-path-style: true` | For `s3` mode. Credentials accept secret references. |
| `r2.account-id`, `r2.access-key-id`, `r2.secret-access-key`, `r2.api-token` | empty | For `r2` mode. Credentials accept secret references.                       |
| `index.signing-key`       | empty              | Key for dedup index names. Empty uses the storage signing key.                                   |
| `index.cache-bytes`       | `1073741824`       | Memory cap for in-memory dedup indexes.                                                          |

See [Storage](./storage.md) for each mode.

### logging.yaml and secrets.yaml

Same keys as the app's [logging.yaml](#loggingyaml) and [secrets](#secrets).
