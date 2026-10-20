/**
 * A submit chunks and hashes content the way the server says for the repo
 * (storage.getToken `longtail`), not the way this daemon's own config says,
 * so teammates with different daemon.json files still produce changelists
 * that pull in one pass.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("~/server/repo-path", async (importOriginal) =>
  (await import("../harness/repo-path-switch")).repoPathModule(importOriginal),
);
vi.mock(
  "@checkpointvcs/longtail-addon",
  async () => (await import("../harness/stack")).fakeAddon,
);
vi.mock("@checkpointvcs/common", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stack = await import("../harness/stack");
  return {
    ...actual,
    CreateApiClientAuth: stack.createApiClientAuth,
    GetAuthConfigUser: stack.getAuthConfigUser,
  };
});
vi.mock(
  "../../../core/daemon/src/daemon-config.js",
  async () => (await import("../harness/stack")).fakeDaemonConfigModule,
);
vi.mock(
  "../../../core/daemon/src/logging.js",
  async () => (await import("../harness/stack")).fakeLoggingModule,
);

import { createTestDb, type TestDb } from "../harness/db";
import { setConfig } from "../harness/config";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import { DaemonConfig } from "../../../core/daemon/src/daemon-config.js";
import {
  lastSubmit,
  makeScene,
  put,
  resetStack,
  stageAndSubmit,
  tearDownScene,
  type Scene,
} from "../harness/stack";

describe("the longtail format a submit uses", { timeout: 120_000 }, () => {
  let testDb: TestDb;
  let scene: Scene | undefined;

  beforeAll(async () => {
    testDb = await createTestDb();
    globalThis.__checkpointTestDb = testDb.client;
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
    delete globalThis.__checkpointTestDb;
  });

  beforeEach(async () => {
    await testDb.reset();
    resetStack();
    scene = await makeScene(testDb.client);
  });

  afterEach(async () => {
    closeAllStateStores();
    await tearDownScene(scene);
    scene = undefined;
  });

  it("is the server's, whatever this daemon's config says", async () => {
    const { alice } = scene!;
    // Setting up the scene used the repo, which pinned the instance's format.
    await testDb.client.repo.update({
      where: { id: scene!.repoId },
      data: {
        longtailParams: JSON.stringify({
          targetChunkSize: 65536,
          targetBlockSize: 8388608,
          maxChunksPerBlock: 1024,
          minBlockUsagePercent: 80,
          hashingAlgo: "blake2",
          compressionAlgo: "zstd",
        }),
      },
    });
    expect((await DaemonConfig.Get()).longtail.targetChunkSize).toBe(32768);

    await put(alice, "a.txt", "a\n");
    await stageAndSubmit(alice, ["a.txt"]);
    expect(lastSubmit.format).toEqual({
      targetChunkSize: 65536,
      hashingAlgo: "blake2",
    });
  });

  it("stays the repo's after the instance is retuned", async () => {
    const { alice, bob } = scene!;
    await put(alice, "a.txt", "a\n");
    await stageAndSubmit(alice, ["a.txt"]);

    setConfig("longtail.target-chunk-size", 65536);
    await put(bob, "b.txt", "b\n");
    await stageAndSubmit(bob, ["b.txt"]);
    expect(lastSubmit.format?.targetChunkSize).toBe(32768);
  });
});
