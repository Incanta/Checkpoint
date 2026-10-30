---
sidebar_position: 1
---

# Welcome to Checkpoint

Checkpoint is a modern version control system built for media-heavy workflows: games, film, product design, architecture, and more.

:::caution Public beta
Checkpoint is in public beta. It's ready for small teams to self-host and use day to day, but expect rough edges. Keep regular [backups](./self-hosting/backups.md) of your server, and read [what the beta means](./getting-started/beta.md) before you start.
:::

## Why Checkpoint?

Traditional version control systems like Git were designed for source code. Checkpoint is purpose-built for projects with large binary files, like textures, 3D models, video, and CAD drawings, where performance and workflow matter.

### Key Features

- **Massive file support**: content is chunked, deduplicated, and compressed, with no artificial file size limits.
- **Checkouts and locking**: claim a binary file before you edit it, so nobody else changes it at the same time. Text files auto-merge.
- **Pending changelists**: group your work into separate changelists and submit each on its own, Perforce-style.
- **Branches and merge requests**: branch, review changelists, and merge with merge requests in the web app.
- **Team Sync**: sync to any changelist, use precompiled binaries from CI, run local build steps, and see build status per changelist.
- **Every client you need**: a desktop app, the `chk` CLI, a web app, a VS Code extension, an Unreal Engine plugin, and an Unreal Horde integration.
- **Self-hosted**: run the server with Docker Compose, store files on its disk, on any S3-compatible store, or on Cloudflare R2, and install updates from the admin panel.

## Getting Started

1. **Set up a server.** Follow the **[Quickstart](./getting-started/quickstart.md)** to run Checkpoint with Docker Compose and install the desktop app.
2. **Learn the basics.** [Concepts](./getting-started/concepts.md) explains workspaces, changelists, branches, and checkouts, and [Everyday Workflow](./guides/workflow.md) walks through syncing, editing, and submitting.
3. **Pick your tools.** See the [desktop app](./clients/desktop-app.md), [CLI](./clients/cli.md), [VS Code](./clients/vscode.md), and [Unreal Engine](./clients/unreal.md) guides.

Running the server for your team? The [Self-Hosting](./self-hosting/deploy-docker-compose.md) section covers deployment, storage, sign-in, members, updates, and backups.

## Need Help?

- Check [Troubleshooting](./troubleshooting.md), which also explains how to collect logs for a bug report
- Browse the [GitHub Discussions](https://github.com/Incanta/Checkpoint/discussions) for community support
- Open an [issue on GitHub](https://github.com/Incanta/Checkpoint/issues) for bug reports
- [Contact us](https://checkpointvcs.com/contact) directly
