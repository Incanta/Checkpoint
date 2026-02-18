---
description: 'A coding agent for Checkpoint'
tools: ['vscode/getProjectSetupInfo', 'vscode/installExtension', 'vscode/newWorkspace', 'vscode/openSimpleBrowser', 'vscode/vscodeAPI', 'vscode/extensions', 'execute/runNotebookCell', 'execute/getTerminalOutput', 'execute/runTask', 'execute/createAndRunTask', 'execute/runInTerminal', 'read', 'edit', 'search', 'web', 'agent', 'todo']
---
You are a coding agent building a Version Control System called Checkpoint. The system is comprised of multiple components (all living in one monorepo at `/e/work/Checkpoint`):
- `src/app`: A web application and tRPC API meant to be the frontend for users to interact with the database and other systems. This is built with Node.js, TypeScript, React, Next.js, Tailwind CSS, tRPC, Prisma, SQLite (for dev), PostgreSQL (for prod), and yarn.
- `src/longtail/library`: A C library that implements the Longtail versioning and storage engine. Generally, we do not need to change this library, but we can if absolutely necessary.
- `src/longtail/wrapper`: A C++ wrapper around the Longtail C library to make it easier to use, which we do make modifications to more frequently than the library.
- `src/longtail/addon`: A Node.js addon that exposes the Longtail C++ wrapper to JavaScript. This is used by both the server and the daemon.
- `src/core`: A collection of modules that interface with the C++ Longtail wrapper using Node.js and TypeScript.
- `src/core/server`: A Node.js server that the web application will direct users to with auth tokens for uploading data chunks for Longtail storage and finalizing a version submission.
- `src/core/daemon`: A Node.js daemon service that runs on users' machines to monitor file changes, keeps a cached state of workspaces, handles authentication state, and acts as the gateway for other client applications to interact with Checkpoint.
- `src/core/client`: A Node.js library that has some client code; the daemon uses this library. There's also an outdated CLI in this folder that we do not use anymore and should be ignored.
- `src/core/common`: A Node.js library used by multiple core components with shared code.
- `src/clients/desktop`: An Electron desktop application that users can install on their machines to manage their Checkpoint workspaces and versions. This application uses the core client and daemon to interact with the user's data. Written in Node.js, TypeScript, Electron, React, Tailwind CSS, and yarn. Like all Electron apps, it has both a main process and a renderer process; it has an intelligent state sync system that should be used to communicate between the two processes. The main process has a `daemon-handler.ts` file that will communicate with the daemon (which communicates with the tRPC API, Longtail C++ wrapper for client side logic, and the Node.js server).
- `src/seaweedfs`: A fork of SeaweedFS that has custom modifications to support Checkpoint's storage needs. You can mostly ignore this component for now.
- `src/clients/unreal`: An Unreal Engine plugin that allows Unreal projects to use Checkpoint for version control.
- In the Root workspace folder, there are some Docker Compose files which host authentication and SeaweedFS. You will not interface with Docker directly.

You can run the Node.js server with `cd src/core && yarn server`. You can run the Daemon with `cd src/core && yarn daemon`. You can run the web app with `cd src/app && yarn dev`. You can run the desktop app with `cd src/clients/desktop && yarn dev`.

If you change the Prisma schema in `src/app/prisma/schema.prisma`, you can regenerate the types with `cd src/app && yarn generate`. You can create a new migration with `cd src/app && yarn db:generate`.

You can reset the SQLite dev database by deleting the `dev.db` file in `src/app/prisma/`.
