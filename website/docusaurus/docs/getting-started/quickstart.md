---
sidebar_position: 1
slug: /quickstart
---

# Quickstart

This guide gets you from zero to a working Checkpoint setup using the official released artifacts: a self-hosted server (via Docker Compose) and the desktop client (from the GitHub Releases installers).

:::caution Public beta
Checkpoint is in public beta. Before your team relies on it, read [Public Beta](./beta.md) and set up [backups](../self-hosting/backups.md).
:::

Checkpoint has two pieces:

- **The server**: the app (web UI and API), the storage server, and a database. You run this once, somewhere your team can reach it.
- **The desktop client**: what each team member installs to create workspaces, lock files, and sync. It bundles the CLI, the background daemon, and the tray app.

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

This bundle runs the **app** (port `13000`), the **storage server** (port `13001`), and **Postgres** (internal only).

### Set your host address

Clients and browsers connect from outside the Docker network, so replace every `IP_ADDRESS` placeholder with your host's hostname or IP in:

- `config/app/server.yaml` (`external-url`)
- `config/app/storage.yaml` (`backend-url.external`)

For a purely local trial, use `localhost`.

### Set your secrets

Secrets live in `config/.secrets` (one `key=value` per line). Lines with an empty value are ignored, so referenced secrets must be non-empty or startup fails. At minimum, set:

```ini
betterauth_secret=<random>
storage_signing_key=<random>
database_url=postgresql://checkpoint:checkpoint@postgres:5432/checkpoint
```

Generate strong random values with `openssl rand -hex 32`. Change the Postgres password before real use, and change it in **both** `database_url` and `POSTGRES_PASSWORD` in `docker-compose.yaml`.

### Choose a storage mode

Checkpoint can store file content in one of three ways. Pick one, and make sure `mode` matches in both `config/app/storage.yaml` and `config/server/storage.yaml`:

- **`local` (default)**: content lives on the storage server's own disk (the `storage-data` volume). No extra services. Best for trying Checkpoint out and for most small teams.
- **`s3`**: content lives in one bucket on any S3-compatible store (MinIO, SeaweedFS's S3 gateway, AWS S3, DigitalOcean Spaces). Clients still talk only to your Checkpoint server, which proxies to the bucket.
- **`r2`**: Cloudflare R2, which clients access directly. A good balance of performance, reliability, and cost.

The `local` mode needs no changes. For the others, see [Storage](../self-hosting/storage.md).

### Start it

```bash
docker compose up -d
docker compose logs -f app
```

The first boot downloads and verifies the server bundle, so it takes noticeably longer than later ones. The app applies its database migrations automatically.

Once it's healthy, open `http://YOUR_HOST:13000` in a browser and create your account. **The first account on a new server becomes its administrator**, and the web app then walks you through a short initial setup. After that, new accounts need an invitation (see [Organizations and Access](../self-hosting/organizations-and-access.md)).

For HTTPS, other databases, email, and production hardening, see [Deploying with Docker Compose](../self-hosting/deploy-docker-compose.md).

## Step 2: Install the desktop client

Each team member installs the desktop client from **[checkpointvcs.com/download](https://checkpointvcs.com/download)** or the **[latest GitHub Release](https://github.com/Incanta/Checkpoint/releases/latest)**:

| Platform | Asset                                          |
| -------- | ---------------------------------------------- |
| Windows  | `.exe` installer (x64)                         |
| macOS    | `.pkg` installer (Apple Silicon or Intel)      |
| Linux    | `.deb` (Debian/Ubuntu) or `.rpm` (Fedora/RHEL) |

The installer includes the desktop app, the `checkpoint` (`chk`) CLI, the background daemon, and the tray app. Build machines and CI can use the standalone [CLI packages](../clients/cli.md) instead.

:::tip
On Linux, install the package with your package manager, e.g. `sudo apt install ./Checkpoint-*.deb` or `sudo dnf install ./Checkpoint-*.rpm`.
:::

## Step 3: Connect the client to your server

1. Launch the Checkpoint desktop app.
2. Point it at your server's web URL (`http://YOUR_HOST:13000`).
3. Sign in with your account.

## Step 4: Create a repository and invite your team

1. In the web app, create an organization and your first repository.
2. In the desktop app, create a workspace for the repository: a local folder that Checkpoint keeps in sync.
3. Invite teammates from the web app, then have each of them install the desktop client and sign in.

From here, [Concepts](./concepts.md) explains how Checkpoint thinks about workspaces, changelists, and locks, and [Everyday Workflow](../guides/workflow.md) shows the day-to-day loop.

## Need help?

- [Troubleshooting](../troubleshooting.md), including how to collect logs for a bug report
- [GitHub Discussions](https://github.com/Incanta/Checkpoint/discussions)
- [GitHub Issues](https://github.com/Incanta/Checkpoint/issues)
- [Contact us](https://checkpointvcs.com/contact) directly
