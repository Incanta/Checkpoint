# Checkpoint quickstart (Docker Compose)

A self-hosted Checkpoint instance: the **app** (UI + API), the **server** (core storage), and **Postgres**. Self-hosted instances are fully featured with no license required.

## Services

| Service    | Purpose                   | Host port  |
| ---------- | ------------------------- | ---------- |
| `app`      | Next.js UI + API          | 13000      |
| `server`   | Core storage server       | 13001      |
| `postgres` | Application database      | (internal) |
| SeaweedFS  | Object storage (optional) | 13002      |

## 1. Set your host address

The browser and the Checkpoint CLI/daemon connect from outside the Docker network, so they need a real address. Replace every `IP_ADDRESS` placeholder with your machine's hostname or IP in:

- `config/app/server.yaml` (`external-url`)
- `config/app/storage.yaml` (`backend-url.external`)
- `config/server/storage.yaml` (`filer ... external.host`)

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

- **Smaller team or just trying Checkpoint out?** Use the default **Filer w/ stub**. It just stores files on the local disk and needs no extra services.
- **Larger deployment?** **Filer w/ SeaweedFS** runs a real distributed cluster.
- **Want a simple cloud-based storage system (what we use internally)?** **R2** gives a good balance of performance, reliability (e.g. cloud backup), and cost.

### a. Filer w/ stub (default)

The server serves files from a local volume. No extra services. Good for trying Checkpoint out and smaller deployments.

```bash
docker compose up -d
```

### b. Filer w/ SeaweedFS

A real SeaweedFS cluster (master + volume + filer), started via the `seaweedfs` compose profile. Likely only useful for larger deployments. In `config/server/storage.yaml`: set `seaweedfs.stub.enabled: false` and switch the `connection` block to the SeaweedFS values (see the commented section in that file). Leave `mode` as `seaweedfs` in both files. Then:

```bash
docker compose --profile seaweedfs up -d
```

The filer is published on host port `13002`; set the external filer host to your `IP_ADDRESS` so remote clients can reach it.

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
docker compose up -d        # stub or R2
# or
docker compose --profile seaweedfs up -d   # full SeaweedFS

docker compose logs -f app  # watch startup + DB migrations
```

The app applies database migrations automatically on boot. Once healthy, open `http://IP_ADDRESS:13000`.

## Notes

- **Database:** Postgres is recommended and is the only documented setup here.
- **Email** is disabled by default (`config/app/email.yaml`). Enable it and set `email_smtp_password` in `config/.secrets` to send invites/notifications.
- **Images** are pulled from `ghcr.io/incanta/checkpoint-*`. The app uses the `latest-postgres` tag.
