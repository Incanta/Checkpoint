/**
 * pending.submit returns its job id straight away and does everything that
 * takes time (expanding folders, checking for conflicts, the submit itself)
 * in that job.
 *
 * It used to expand and check before answering, which for a big submit (a
 * junction to an engine install turned 19 staged rows into 377,595 files)
 * ran past the caller's HTTP timeout: the desktop showed a bare "fetch
 * failed" while the daemon carried on, and a retry started a second submit
 * alongside the first. These pin that a conflict now arrives as the job's
 * failure, and that a workspace runs one submit at a time.
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
  apiAs,
  contentAtHead,
  makeScene,
  overrides,
  put,
  resetStack,
  stageAndSubmit,
  syncLatest,
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

/** Waits for a job to end and returns how: "completed", or the failure. */
async function outcomeOf(jobId: string): Promise<string> {
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

describe("submitting as a job", { timeout: 120_000 }, () => {
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

  it("reports a conflict as the job's failure, not the request's", async () => {
    const { alice, bob } = scene!;
    const d = await daemon();
    await put(alice, "art.uasset", "art v1");
    await stageAndSubmit(alice, ["art.uasset"]);

    await syncLatest(bob);
    await put(bob, "art.uasset", "art v2 (bob)");
    await stageAndSubmit(bob, ["art.uasset"]);

    // Alice edits the asset without syncing Bob's version first.
    await put(alice, "art.uasset", "art v1 (alice)");
    await d.workspaces.pending.stage({ ...ids(alice), paths: ["art.uasset"] });

    const { jobId } = await d.workspaces.pending.submit({
      ...ids(alice),
      message: "alice's art",
      noProgress: true,
    });
    const outcome = await outcomeOf(jobId);
    // Same message as before, which the desktop matches on to offer a pull.
    expect(outcome).toMatch(/conflicting file\(s\) detected/);
    expect(outcome).toMatch(/: art\.uasset$/);
    expect(
      await contentAtHead(testDb.client, scene!.repoId, "main", "art.uasset"),
    ).toBe("art v2 (bob)");
  });

  it("runs one submit per workspace at a time", async () => {
    const { alice } = scene!;
    const d = await daemon();
    await put(alice, "a.txt", "a\n");
    await d.workspaces.pending.stage({ ...ids(alice), paths: ["a.txt"] });

    // Hold the first submit inside its job, at its conflict check.
    let reached!: () => void;
    const atConflictCheck = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    overrides.procedures = {
      branch: {
        getBranch: async (input) => {
          reached();
          await released;
          return apiAs(alice).branch.getBranch(input as never);
        },
      },
    };

    const first = await d.workspaces.pending.submit({
      ...ids(alice),
      message: "first",
      noProgress: true,
    });
    await atConflictCheck;

    await expect(
      d.workspaces.pending.submit({
        ...ids(alice),
        message: "second",
        noProgress: true,
      }),
    ).rejects.toThrow(/already running/);

    release();
    expect(await outcomeOf(first.jobId)).toBe("completed");
    delete overrides.procedures;

    // The slot is free again once the first one is done.
    await put(alice, "b.txt", "b\n");
    await d.workspaces.pending.stage({ ...ids(alice), paths: ["b.txt"] });
    const next = await d.workspaces.pending.submit({
      ...ids(alice),
      message: "next",
      noProgress: true,
    });
    expect(await outcomeOf(next.jobId)).toBe("completed");
  });

  it("frees the slot when the job fails", async () => {
    const { alice } = scene!;
    const d = await daemon();
    await put(alice, "a.txt", "a\n");
    await d.workspaces.pending.stage({ ...ids(alice), paths: ["a.txt"] });

    overrides.procedures = {
      branch: {
        getBranch: async () => {
          throw new Error("server unavailable");
        },
      },
    };
    const failed = await d.workspaces.pending.submit({
      ...ids(alice),
      message: "fails",
      noProgress: true,
    });
    expect(await outcomeOf(failed.jobId)).toMatch(/server unavailable/);
    delete overrides.procedures;

    const retry = await d.workspaces.pending.submit({
      ...ids(alice),
      message: "retry",
      noProgress: true,
    });
    expect(await outcomeOf(retry.jobId)).toBe("completed");
  });
});
