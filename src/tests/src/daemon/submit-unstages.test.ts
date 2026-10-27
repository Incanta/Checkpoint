/**
 * A submit takes what it sent out of the staged set.
 *
 * It used to clear only the changelist record and the partial-staging blobs,
 * so the submitted paths stayed staged: the next edit to one of them showed up
 * already staged, in the changelist that had just been submitted. These pin
 * that every way a path can be submitted (an edit, a new file, a collapsed
 * untracked folder, a numbered changelist) leaves it unstaged,
 * and that nothing outside the submit, or a submit that fails, is touched.
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (src/harness/stack.ts).
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
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import {
  contentAtHead,
  makeScene,
  overrides,
  put,
  resetStack,
  stageAndSubmit,
  tearDownScene,
  type Scene,
  type Seat,
} from "../harness/stack";

const ids = (seat: Seat) => ({
  daemonId: seat.workspace.daemonId,
  workspaceId: seat.workspace.id,
});

async function daemon() {
  const [{ createCaller }, { DaemonManager }] = await Promise.all([
    import("../../../core/daemon/src/api/index.js"),
    import("../../../core/daemon/src/daemon-manager.js"),
  ]);
  return createCaller({ manager: DaemonManager.Get() });
}

/** The raw staged set, which is what a submit filters on. */
async function stagedSet(seat: Seat): Promise<string[]> {
  const { DaemonManager } =
    await import("../../../core/daemon/src/daemon-manager.js");
  return [...DaemonManager.Get().getStaged(seat.workspace.id)].sort();
}

/** Each pending path and whether the daemon reports it staged. */
async function stagedFlags(seat: Seat): Promise<Record<string, boolean>> {
  const result = await (await daemon()).workspaces.pending.refresh(ids(seat));
  return Object.fromEntries(
    Object.entries(result?.files ?? {}).map(([p, f]) => [p, f.staged]),
  );
}

async function submitAndWait(
  seat: Seat,
  opts: { changelistId?: number } = {},
): Promise<string> {
  const d = await daemon();
  const { jobId } = await d.workspaces.pending.submit({
    ...ids(seat),
    message: "submit",
    noProgress: true,
    ...opts,
  });
  const { JobManager } =
    await import("../../../core/daemon/src/job-manager.js");
  const deadline = Date.now() + 60_000;
  for (;;) {
    const job = JobManager.Get().getJob(jobId);
    if (job?.status === "completed") return "completed";
    if (job?.status === "failed" || job?.status === "cancelled") {
      return `failed: ${job.error ?? job.status}`;
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("a submit unstages what it sent", { timeout: 120_000 }, () => {
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
    delete overrides.procedures;
    closeAllStateStores();
    await tearDownScene(scene);
    scene = undefined;
  });

  it("an edited tracked file is unstaged, and its next edit starts unstaged", async () => {
    const { alice } = scene!;
    await put(alice, "notes.txt", "v1\n");
    await stageAndSubmit(alice, ["notes.txt"]);
    await put(alice, "notes.txt", "v2\n");
    await stageAndSubmit(alice, ["notes.txt"]);

    expect(await stagedSet(alice)).toEqual([]);

    await put(alice, "notes.txt", "v3\n");
    expect(await stagedFlags(alice)).toEqual({ "notes.txt": false });
  });

  it("a new file is unstaged once it is tracked", async () => {
    const { alice } = scene!;
    await put(alice, "new.txt", "new\n");
    await stageAndSubmit(alice, ["new.txt"]);

    expect(await stagedSet(alice)).toEqual([]);

    await put(alice, "new.txt", "new, edited\n");
    expect(await stagedFlags(alice)).toEqual({ "new.txt": false });
  });

  it("a staged untracked folder row and its files are all unstaged", async () => {
    const { alice } = scene!;
    await put(alice, "folder/a.txt", "a\n");
    await put(alice, "folder/b.txt", "b\n");
    // Stages the collapsed "folder" row, which the submit expands.
    await stageAndSubmit(alice, ["folder/a.txt"]);
    expect(
      await contentAtHead(testDb.client, scene!.repoId, "main", "folder/b.txt"),
    ).toBe("b\n");

    expect(await stagedSet(alice)).toEqual([]);

    await put(alice, "folder/a.txt", "a, edited\n");
    expect(await stagedFlags(alice)).toEqual({ "folder/a.txt": false });
  });

  it("submitting a numbered changelist leaves the default changelist staged", async () => {
    const { alice } = scene!;
    const d = await daemon();
    await put(alice, "in-cl.txt", "cl\n");
    await put(alice, "in-default.txt", "default\n");
    const cl = await d.workspaces.pending.createChangelist({
      ...ids(alice),
      description: "numbered",
    });
    await d.workspaces.pending.stage({
      ...ids(alice),
      paths: ["in-cl.txt"],
      changelistId: cl.id,
    });
    await d.workspaces.pending.stage({
      ...ids(alice),
      paths: ["in-default.txt"],
    });

    expect(await submitAndWait(alice, { changelistId: cl.id })).toBe(
      "completed",
    );

    expect(await stagedSet(alice)).toEqual(["in-default.txt"]);
    await put(alice, "in-cl.txt", "cl, edited\n");
    expect(await stagedFlags(alice)).toEqual({
      "in-cl.txt": false,
      "in-default.txt": true,
    });
  });

  it("submitting the default changelist leaves a numbered changelist staged", async () => {
    const { alice } = scene!;
    const d = await daemon();
    await put(alice, "in-cl.txt", "cl\n");
    await put(alice, "in-default.txt", "default\n");
    const cl = await d.workspaces.pending.createChangelist({
      ...ids(alice),
      description: "numbered",
    });
    await d.workspaces.pending.stage({
      ...ids(alice),
      paths: ["in-cl.txt"],
      changelistId: cl.id,
    });
    await d.workspaces.pending.stage({
      ...ids(alice),
      paths: ["in-default.txt"],
    });

    expect(await submitAndWait(alice)).toBe("completed");

    expect(await stagedSet(alice)).toEqual(["in-cl.txt"]);
    const state = await d.workspaces.pending.listChangelists(ids(alice));
    expect(state.assignments).toEqual({ "in-cl.txt": cl.id });
  });

  it("a failed submit keeps everything staged", async () => {
    const { alice } = scene!;
    await put(alice, "a.txt", "a\n");
    await (
      await daemon()
    ).workspaces.pending.stage({ ...ids(alice), paths: ["a.txt"] });

    overrides.procedures = {
      branch: {
        getBranch: async () => {
          throw new Error("server unavailable");
        },
      },
    };
    expect(await submitAndWait(alice)).toMatch(/server unavailable/);
    delete overrides.procedures;

    expect(await stagedSet(alice)).toEqual(["a.txt"]);
  });
});
