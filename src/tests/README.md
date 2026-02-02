# @checkpointvcs/tests

Full system integration tests for Checkpoint.

## Overview

This package provides integration tests for the complete Checkpoint stack. Tests assume services are already running:

- **App**: Next.js web application and tRPC API (port 3000)
- **Daemon**: Background service for file monitoring and workspace management (port 3010)
- **Server**: Bun server for chunk uploads and version submissions (port 3001)

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
| App     | 3000         |
| Server  | 3001         |
| Daemon  | 3010         |

Override ports when creating the environment:

```typescript
const env = createTestEnvironment({
  appPort: 4000,
  serverPort: 4001,
  daemonPort: 4010,
});
```

## Timeouts

Integration tests have a default timeout of 2 minutes (120000ms). Adjust per-test if needed:

```typescript
it("slow operation", async () => {
  // test code
}, 300000); // 5 minute timeout
```
