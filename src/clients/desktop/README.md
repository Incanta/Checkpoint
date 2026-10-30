# Checkpoint Desktop

The Checkpoint desktop app: an Electron application with a React renderer. It talks to the local daemon (`src/core/daemon`) and manages workspaces, pending changes and pending changelists, history, branches, and Team Sync.

User documentation: [Desktop App](https://checkpointvcs.com/docs/clients/desktop-app) (source in [`website/docusaurus/docs/clients/desktop-app.md`](../../../website/docusaurus/docs/clients/desktop-app.md)).

## Development

From the repo root, start the backend services and daemon, then the app:

```bash
yarn dev       # app, storage server, and daemon
yarn desktop   # this Electron app, with hot reload
```

Or from this directory:

| Script | What it does |
| --- | --- |
| `yarn dev` | Run the app with Vite and hot reload |
| `yarn dev:mock` | Run with mock data, no daemon needed |
| `yarn typecheck` | Type-check without emitting |
| `yarn build` | Type-check, build, and package installers with electron-builder |

## Layout

- `src/main/`: Electron main process (window, menus, IPC to the daemon)
- `src/common/`: types shared by both processes
- `src/renderer/`: React UI (`pages/` for routes, `components/ui/` for shared primitives)
- `electron-builder.json`: installer targets and artifact names (the website's download page matches on these names)

The renderer shares the web app's design tokens (light and dark). Tailwind v4 is configured CSS-first, without Tailwind's preflight reset, so set margins and `box-sizing` explicitly.
