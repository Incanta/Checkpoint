/**
 * Racily clean baselines (git's "racy git" problem). Change detection calls a
 * file unchanged when its size and mtime match what was recorded, and a pull
 * records no hash. A filesystem's clock moves in ticks (2 s on FAT32 and
 * exFAT, 1 s on HFS+), so a same-size rewrite in the tick a file was recorded
 * in keeps its mtime. Each baseline now records when it was taken, files
 * written within a tick of that are hashed, and their content decides
 * (src/core/daemon/src/util/baseline.ts). Moved here from the data-loss red
 * team (DL-20).
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts). overrides.writeTime
 * stamps every write with one mtime, as writes within one tick are stamped.
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

import { createHash } from "node:crypto";

import type { WorkspaceStateFile } from "@checkpointvcs/common";
import { createTestDb, type TestDb } from "../harness/db";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import { getWorkspaceState } from "../../../core/daemon/src/util/util.js";
import {
  compareWithBaseline,
  isRacilyClean,
} from "../../../core/daemon/src/util/baseline.js";
import {
  describeFile,
  makeScene,
  overrides,
  pendingChanges,
  put,
  resetStack,
  stageAndSubmit,
  survives,
  syncLatest,
  tearDownScene,
  type Scene,
} from "../harness/stack";

/**
 * The tick a coarse clock (one that counts in `ms`) stamps writes made in the
 * same tick as the recording with. The harness takes seconds per pull, so
 * "now" would already be outside the tick by the time the pull records its
 * baselines: a tick a minute ahead is inside it however long the pull takes.
 */
const recordingTick = (ms: number) =>
  new Date(Math.floor((Date.now() + 60_000) / ms) * ms);

describe("compareWithBaseline and racily clean entries", () => {
  const entry = (over: Partial<WorkspaceStateFile>): WorkspaceStateFile => ({
    fileId: "f",
    changelist: 1,
    md5: "",
    size: 4,
    mtime: 10_000,
    ...over,
  });
  const same = { size: 4, mtimeMs: 10_000 };

  it("trusts equal size and mtime for a file written well before it was recorded", () => {
    const e = entry({ recordedAt: 20_000 });
    expect(isRacilyClean(e)).toBe(false);
    expect(compareWithBaseline(same, e, { whenUnknowable: "unchanged" })).toBe(
      "unchanged",
    );
  });

  it("does not trust them for a file written within a tick of being recorded", () => {
    const hashed = entry({ recordedAt: 11_000, md5: "abc" });
    expect(isRacilyClean(hashed)).toBe(true);
    expect(
      compareWithBaseline(same, hashed, { whenUnknowable: "unchanged" }),
    ).toBe("compare-hash");
    // Recording hashes such files; one without a hash cannot be proved
    // unchanged.
    expect(
      compareWithBaseline(same, entry({ recordedAt: 11_000 }), {
        whenUnknowable: "unchanged",
      }),
    ).toBe("changed");
  });

  it("treats entries from older daemons, with no recording time, as before", () => {
    expect(
      compareWithBaseline(same, entry({}), { whenUnknowable: "changed" }),
    ).toBe("unchanged");
  });
});

// Each test runs two daemons' worth of submits and pulls (and the Windows
// lock tests start a PowerShell), which hosted runners can take well past the
// suite's default timeout on.
describe("racily clean baselines", { timeout: 120_000 }, () => {
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
    vi.restoreAllMocks();
    closeAllStateStores();
    await tearDownScene(scene);
    scene = undefined;
  });

  const stillPending = expect.stringMatching(/^Changed/);

  it.each([
    ["2 s (FAT32, exFAT)", 2000],
    ["1 s (HFS+)", 1000],
  ])(
    "still sees a same-size edit made within one timestamp tick of a pull, on a %s clock",
    async (_clock, tick) => {
      const { alice, bob } = scene!;
      await put(alice, "notes.txt", "status: draft\n");
      await stageAndSubmit(alice, ["notes.txt"]);
      await syncLatest(bob);
      await put(alice, "notes.txt", "status: final\n");
      await stageAndSubmit(alice, ["notes.txt"]);

      overrides.writeTime = recordingTick(tick);
      await syncLatest(bob);
      await put(bob, "notes.txt", "status: fixed\n"); // the same length
      delete overrides.writeTime;

      expect(await pendingChanges(bob)).toHaveProperty(
        ["notes.txt"],
        stillPending,
      );

      await put(alice, "notes.txt", "status: shipped\n");
      await stageAndSubmit(alice, ["notes.txt"]);
      await syncLatest(bob);

      expect(
        await survives(bob, "notes.txt", "status: fixed"),
        `${await describeFile(bob, "notes.txt")}, and no backup holds Bob's edit`,
      ).toBe(true);
    },
  );

  it("leaves nothing pending after such a pull when nobody edited", async () => {
    const { alice, bob } = scene!;
    await put(alice, "notes.txt", "status: draft\n");
    await stageAndSubmit(alice, ["notes.txt"]);

    overrides.writeTime = recordingTick(2000);
    await syncLatest(bob);
    delete overrides.writeTime;

    expect(await pendingChanges(bob)).toEqual({});
  });

  it("still sees a same-size edit made after the native write but before the pull records it, in the same tick", async () => {
    // R9's residual: hashing racily clean files when the pull records its
    // baselines would hash this edit as the pulled version. The native layer
    // hashes what it writes as it writes it (R10), so the edit shows.
    const { alice, bob } = scene!;
    await put(alice, "notes.txt", "status: draft\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await syncLatest(bob);
    await put(alice, "notes.txt", "status: final\n");
    await stageAndSubmit(alice, ["notes.txt"]);

    overrides.writeTime = recordingTick(2000);
    overrides.duringPull = async () => {
      await put(bob, "notes.txt", "status: fixed\n"); // the same length
    };
    await syncLatest(bob);
    delete overrides.duringPull;
    delete overrides.writeTime;

    const state = await getWorkspaceState(bob.root, "sqlite");
    // The baseline is the content the pull wrote, not the edit.
    expect(state.files["notes.txt"]?.md5).toBe(
      createHash("md5").update("status: final\n").digest("hex"),
    );
    expect(await pendingChanges(bob)).toHaveProperty(
      ["notes.txt"],
      stillPending,
    );

    await put(alice, "notes.txt", "status: shipped\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await syncLatest(bob);

    expect(
      await survives(bob, "notes.txt", "status: fixed"),
      `${await describeFile(bob, "notes.txt")}, and no backup holds Bob's edit`,
    ).toBe(true);
  });

  it("hashes only the files written within a tick of the recording, when the addon reports no hashes", async () => {
    const { alice, bob } = scene!;
    overrides.omitWriteHashes = true;
    await put(alice, "old.txt", "written long ago\n");
    await stageAndSubmit(alice, ["old.txt"]);
    overrides.writeTime = new Date("2026-01-01T00:00:00Z");
    await syncLatest(bob);
    await put(alice, "new.txt", "written just now\n");
    await stageAndSubmit(alice, ["new.txt"]);
    overrides.writeTime = recordingTick(2000);
    await syncLatest(bob);
    delete overrides.writeTime;

    const state = await getWorkspaceState(bob.root, "sqlite");
    expect(state.files["old.txt"]?.md5).toBe("");
    expect(state.files["new.txt"]?.md5).not.toBe("");
    expect(state.files["new.txt"]?.recordedAt).toBeGreaterThan(0);
  });

  it("still sees a same-size edit made within one timestamp tick of a submit", async () => {
    const { bob } = scene!;
    overrides.writeTime = recordingTick(2000);
    await put(bob, "notes.txt", "status: draft\n");
    await stageAndSubmit(bob, ["notes.txt"]);
    await put(bob, "notes.txt", "status: fixed\n");
    delete overrides.writeTime;

    expect(await pendingChanges(bob)).toHaveProperty(
      ["notes.txt"],
      expect.stringMatching(/^Changed|Local|Added/),
    );
  });
});
