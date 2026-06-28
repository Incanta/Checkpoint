# Checkpoint quickstart (Docker Compose)

A self-hosted Checkpoint instance: the **app** (UI + API), the **server** (core storage), and **Postgres**. Self-hosted instances are fully featured with no license required.

## Services

| Service    | Purpose              | Host port  |
| ---------- | -------------------- | ---------- |
| `app`      | Next.js UI + API     | 13000      |
| `server`   | Core storage server  | 13001      |
| `postgres` | Application database  | (internal) |

## 1. Set your host address

The browser and the Checkpoint CLI/daemon connect from outside the Docker network, so they need a real address. Replace every `IP_ADDRESS` placeholder with your machine's hostname or IP in:

- `config/app/server.yaml` (`external-url`)
- `config/app/storage.yaml` (`backend-url.external`)

For a purely local trial you can use `localhost`.

## 2. Fill in secrets

Secrets live in `config/.secrets` (one `key=value` per line), read by the local secrets provider. **Lines with an empty value are ignored**, so referenced secrets must be non-empty or startup fails. At minimum set:

```ini
betterauth_secret=<random>
storage_signing_key=<random>
database_url=postgresql://checkpoint:checkpoint@postgres:5432/checkpoint
```

Generate strong values with `openssl rand -hex 32`. If you change the Postgres password, change it in **both** `database_url` (here) and `POSTGRES_PASSWORD` in `docker-compose.yaml`.

## 3. Choose a storage mode

Pick one and edit `config/app/storage.yaml` + `config/server/storage.yaml` (their `mode` must match).

Which to pick:

- **Smaller team or just trying Checkpoint out?** Use the default **local** mode. The server stores files on its own disk and serves them through its gateway; no extra services.
- **Larger self-hosted deployment?** Use **s3** with any S3-compatible store (MinIO, SeaweedFS's S3 gateway, AWS, DigitalOcean Spaces). The server proxies blocks to it through the gateway.
- **Want simple, cheap cloud storage (what we use internally)?** **R2** gives a good balance of performance, reliability (e.g. cloud backup), and cost, and clients talk to R2 directly (free egress).

### a. local (default)

The server serves files from a local volume. No extra services. Good for trying Checkpoint out and smaller deployments.

```bash
docker compose up -d
```

### b. s3 (any S3-compatible store)

Set `mode: "s3"` in both storage files, then fill the `s3` block in `config/server/storage.yaml` (endpoint, region, one shared bucket, `force-path-style` for MinIO/SeaweedFS) and add the credentials to `config/.secrets`:

```ini
s3_access_key_id=...
s3_secret_access_key=...
```

Run the S3 store separately (e.g. a MinIO container or SeaweedFS with its S3 gateway). Clients still talk only to the Checkpoint server, which proxies to S3.

```bash
docker compose up -d
```

### c. Cloudflare R2

Cloudflare R2 object storage. This is what Incanta uses internally for its balance of performance, reliability, and cost. Set `mode: "r2"` in both storage files, fill `r2.account-id` (a literal) in both, and add the credentials to `config/.secrets`:

```ini
r2_access_key_id=...
r2_secret_access_key=...
r2_api_token=...
```

```bash
docker compose up -d
```

## 4. Start

```bash
docker compose up -d        # any mode (local / s3 / r2)

docker compose logs -f app  # watch startup + DB migrations
```

The app applies database migrations automatically on boot. Once healthy, open `http://IP_ADDRESS:13000`.

## Notes

- **Database:** Postgres is recommended and is the only documented setup here.
- **Email** is disabled by default (`config/app/email.yaml`). Enable it and set `email_smtp_password` in `config/.secrets` to send invites/notifications.
- **Images** are pulled from `ghcr.io/incanta/checkpoint-*`. The app uses the `latest-postgres` tag.
