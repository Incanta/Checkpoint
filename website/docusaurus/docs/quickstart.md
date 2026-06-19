---
sidebar_position: 2
---

# Quickstart

This guide gets you from zero to a working Checkpoint setup using the official released artifacts: a self-hosted server (via Docker Compose) and the desktop client (from the GitHub Releases installers).

:::info Self-hosting is free and fully featured
Self-hosted Checkpoint instances have access to all features with no license required. You only need a license/subscription if you use Incanta's hosted cloud offering.
:::

Checkpoint has two pieces:

- **The server**: the app (web UI + API) plus the core storage server. You run this once, somewhere your team can reach it.
- **The desktop client**: what each team member installs to clone, lock, and sync repositories. It bundles the CLI, background daemon, and tray app.

All downloads come from the **[latest GitHub Release](https://github.com/Incanta/Checkpoint/releases/latest)**.

## Prerequisites

- A host (server, VM, or workstation) with [Docker](https://docs.docker.com/get-docker/) and the Docker Compose v2 plugin installed.
- The host's LAN IP or hostname that clients will connect to (for a purely local trial, `localhost` works).

## Step 1: Deploy the server with Docker Compose

The release includes a ready-to-run Docker Compose bundle. Download and extract it:

```bash
wget https://github.com/Incanta/Checkpoint/releases/latest/download/checkpoint-docker-compose.tar.gz
tar xf checkpoint-docker-compose.tar.gz
cd docker-compose
```

This bundle runs the **app** (port `13000`), the **server** (port `13001`), and **Postgres**.

### Set your host address

Clients and browsers connect from outside the Docker network, so replace every `IP_ADDRESS` placeholder with your host's hostname or IP in:

- `config/app/server.yaml` (`external-url`)
- `config/app/storage.yaml` (`backend-url.external`)
- `config/server/storage.yaml` (the filer `external.host`)

For a purely local trial, use `localhost`.

### Set your secrets

Secrets live in `config/.secrets` (one `key=value` per line). Lines with an empty value are ignored, so referenced secrets must be non-empty or startup fails. At minimum, set:

```bash
betterauth_secret=<random>
storage_signing_key=<random>
database_url=postgresql://checkpoint:checkpoint@postgres:5432/checkpoint
```

Generate strong random values with `openssl rand -hex 32`. If you change the Postgres password, update it in **both** `database_url` and `POSTGRES_PASSWORD` in `docker-compose.yaml`.

### Choose a storage mode

Checkpoint can store file data in one of three ways. Pick one and make sure `mode` matches in both `config/app/storage.yaml` and `config/server/storage.yaml`:

- **Filer w/ stub (default)**: files stored on the local disk, no extra services. Best for smaller teams or just trying Checkpoint out.
- **Filer w/ SeaweedFS**: a real distributed cluster, started with the `seaweedfs` compose profile. Best for larger deployments.
- **Cloudflare R2**: managed cloud object storage with a good balance of performance, reliability, and cost.

See the comments in `config/server/storage.yaml` and the bundle's `README.md` for the exact settings each mode needs.

### Start it

```bash
# Filer w/ stub (default) or R2:
docker compose up -d

# Filer w/ SeaweedFS:
docker compose --profile seaweedfs up -d
```

The app applies its database migrations automatically on first boot. Watch startup with:

```bash
docker compose logs -f app
```

Once it's healthy, open `http://YOUR_HOST:13000` in a browser and create your first account.

## Step 2: Install the desktop client

Each team member installs the desktop client from the **[latest GitHub Release](https://github.com/Incanta/Checkpoint/releases/latest)**. Download the installer for your platform:

| Platform | Asset                          |
| -------- | ------------------------------ |
| Windows  | `.exe` installer               |
| macOS    | `.pkg` installer               |
| Linux    | `.deb` (Debian/Ubuntu) or `.rpm` (Fedora/RHEL) |

The installer includes the desktop app, the `checkpoint` (`chk`) CLI, the background sync daemon, and the tray app.

:::tip
On Linux, install the package with your package manager, e.g. `sudo apt install ./checkpoint_*.deb` or `sudo dnf install ./checkpoint-*.rpm`.
:::

## Step 3: Connect the client to your server

1. Launch the Checkpoint desktop app.
2. Point it at your server's web URL (`http://YOUR_HOST:13000`).
3. Sign in with the account you created in Step 1.

You're ready to create an organization and your first repository.

## Need help?

- Browse the [GitHub Discussions](https://github.com/Incanta/Checkpoint/discussions)
- Open an [issue on GitHub](https://github.com/Incanta/Checkpoint/issues)
- [Contact us](https://checkpointvcs.com/contact) directly
