# @checkpointvcs/tests

Full system integration tests for Checkpoint.

## Overview

This package provides integration tests for the complete Checkpoint stack. Tests assume services are already running:

- **App**: Next.js web application and tRPC API (port 13000)
- **Daemon**: Background service for file monitoring and workspace management (port 13010)
- **Server**: Bun server for chunk uploads and version submissions (port 13001)

## Prerequisites

Before running tests:

1. Start the app: `cd src/app && yarn dev`
2. Start the daemon: `cd src/core && bun daemon`
3. Start the server: `cd src/core && bun server`

## Installation

```bash
cd src/tests
yarn install
```

## Running Tests

```bash
# Run all tests
yarn test

# Run tests in watch mode
yarn test:watch

# Run tests with CI configuration
yarn test:ci
```

## Test Structure

```
src/
├── fixtures/           # Test fixtures
│   ├── index.ts
│   └── test-environment.ts   # Environment setup with tRPC clients
├── utils/              # Test utilities
│   ├── index.ts
│   ├── async.ts        # Async helpers (waitFor, retry, sleep)
│   └── workspace.ts    # Test workspace management
├── integration/        # Integration tests
│   ├── system.test.ts  # Basic system tests
│   └── workspace.test.ts # Workspace operation tests
├── setup.ts            # Jest setup
└── index.ts            # Main exports
```

## Writing Tests

### Basic Test Structure

```typescript
import { createTestEnvironment, type TestEnvironment } from "../fixtures";

describe("My Feature", () => {
  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment();
  });

  it("should do something", async () => {
    // Use env.apiClient, env.daemonClient, env.appUrl, etc.
    const response = await fetch(`${env.appUrl}/api/health`);
    expect(response.ok).toBe(true);
  });
});
```

### Using Test Workspaces

```typescript
import {
  createTestWorkspace,
  createTestFile,
  type TestWorkspace,
} from "../utils";

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await createTestWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

it("should create files", async () => {
  await createTestFile(workspace, "src/index.ts", "console.log('hello');");
});
```

## Configuration

Default service ports:

| Service | Default Port |
| ------- | ------------ |
| App     | 13000        |
| Server  | 13001        |
| Daemon  | 13010        |

Override ports when creating the environment:

```typescript
const env = createTestEnvironment({
  appPort: 4000,
  serverPort: 4001,
  daemonPort: 4010,
});
```

## Integration tests (real addon, running services)

`src/integration/` holds tests that call the native longtail addon directly against a running app, daemon, and server. They are excluded from `yarn test` and run with:

```bash
export CHECKPOINT_TEST_DAEMON_ID=<daemon id with an entry in ~/.checkpoint/auth.json>
yarn test:integration
```

Without `CHECKPOINT_TEST_DAEMON_ID` every integration file skips itself. Each file creates its own org and repo so it never shares changelists with anything else in the run. CI runs these after the CLI flow in `.github/workflows/test.yaml`, against an addon built from the checkout (see `scripts/ci/build-longtail-addon.mjs`).

The daemon-driven counterpart, which seeds a realistic tree, stages whole directories through the daemon API, and compares the pulled tree by hash, lives in `scripts/ci/tree-roundtrip.mjs`.

## Data-loss red-team suite

`src/data-loss/` holds tests for scenarios that lose work during push, pull, merge, and branch use. Each test states the safe outcome, so its failures are open bugs; the findings and recommended fixes are in `src/data-loss/README.md`. The suite is excluded from `yarn test` and runs with:

```bash
yarn test:data-loss
```

It needs no running services: the daemon's own endpoints run in-process against the app routers, with only the native addon faked (`src/harness/stack.ts`). Its OS-dependent tests (`src/data-loss/os.test.ts`) probe the filesystem and skip what does not apply. `.github/workflows/data-loss.yaml` runs the suite on Linux, Windows, and macOS, and fails while any of its findings reproduces: open findings mean the commit is not clean. It is kept out of `test.yaml`, so a known finding never turns the main CI red and a regression never hides among findings.

`src/data-loss/native/` covers what the real addon does (`yarn test:data-loss:native`): the include-filter test needs only the addon, and the file-mode tests also need running services and `CHECKPOINT_TEST_DAEMON_ID`, like the integration tests. CI runs them in the `native` job of `data-loss.yaml`.

## Timeouts

Integration tests have a default timeout of 2 minutes (120000ms). Adjust per-test if needed:

```typescript
it("slow operation", async () => {
  // test code
}, 300000); // 5 minute timeout
```
