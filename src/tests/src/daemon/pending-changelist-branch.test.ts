/**
 * Retargeting a pending changelist at another branch
 * (pending.setChangelistBranch). The flow it exists for: start a changelist
 * on the domain root, decide the work needs its own branch, create and
 * activate one, move the changelist there, and submit it to that branch.
 *
 * A file's branch is its claim's, so moving a changelist moves its files'
 * claims. These pin that the files go along, that nothing outside the
 * changelist moves, that a refused claim leaves everything where it was, and
 * that the submit lands on the new branch and not the old one.
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
  exists,
  headOf,
  makeScene,
  overrides,
  pendingChanges,
  pathsAtHead,
  put,
  read,
  resetStack,
  stageAndSubmit,
  switchBranch,
  syncLatest,
  tearDownScene,
  type Scene,
  type Seat,
} from "../harness/stack";

const ORIGINAL = "one\ntwo\nthree\n";
const EDITED = "one\ntwo (edited)\nthree\n";

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

async function waitForJob(jobId: string): Promise<void> {
  const { JobManager } =
    await import("../../../core/daemon/src/job-manager.js");
  const deadline = Date.now() + 60_000;
  for (;;) {
    const job = JobManager.Get().getJob(jobId);
    if (job?.status === "completed") return;
    if (job?.status === "failed" || job?.status === "cancelled") {
      throw new Error(`${job.type} failed: ${job.error ?? job.status}`);
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Each pending path's open claim branch (or "none"), and whether staged. */
async function claimsOf(seat: Seat): Promise<Record<string, string>> {
  const result = await (await daemon()).workspaces.pending.refresh(ids(seat));
  return Object.fromEntries(
    Object.entries(result?.files ?? {}).map(([p, f]) => {
      const claim = f.claims.find((c) => c.state === "OPEN") ?? f.claims[0];
      return [p, `${claim?.branchName ?? "none"}${f.staged ? "+staged" : ""}`];
    }),
  );
}

describe("moving a pending changelist to another branch", { timeout: 120_000 }, () => {
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

    // main has notes.txt and stay.txt. Alice edits both and adds extra.txt,
    // and starts a changelist on main for notes.txt and extra.txt; stay.txt
    // goes in main's default changelist.
    const { alice } = scene;
    await put(alice, "notes.txt", ORIGINAL);
    await put(alice, "stay.txt", ORIGINAL);
    await stageAndSubmit(alice, ["notes.txt", "stay.txt"]);
    await put(alice, "notes.txt", EDITED);
    await put(alice, "stay.txt", EDITED);
    await put(alice, "extra.txt", "extra\n");
  });

  afterEach(async () => {
    delete overrides.procedures;
    closeAllStateStores();
    await tearDownScene(scene);
    scene = undefined;
  });

  /** A changelist on main holding notes.txt and extra.txt; stay.txt staged to main's default. */
  async function startOnMain(alice: Seat): Promise<number> {
    const d = await daemon();
    const cl = await d.workspaces.pending.createChangelist({
      ...ids(alice),
      description: "needs its own branch",
    });
    await d.workspaces.pending.stage({
      ...ids(alice),
      paths: ["notes.txt", "extra.txt"],
      changelistId: cl.id,
    });
    await d.workspaces.pending.stage({ ...ids(alice), paths: ["stay.txt"] });
    return cl.id;
  }

  async function createAndActivateFeature(alice: Seat) {
    await apiAs(alice).branch.createBranch({
      repoId: scene!.repoId,
      name: "feature",
      type: "FEATURE",
      parentBranchName: "main",
    });
    await switchBranch(alice, "feature");
  }

  it("moves the changelist and its files' claims, and submits to the new branch", async () => {
    const { alice } = scene!;
    const d = await daemon();
    const clId = await startOnMain(alice);
    await createAndActivateFeature(alice);

    const result = await d.workspaces.pending.setChangelistBranch({
      ...ids(alice),
      changelistId: clId,
      branchName: "feature",
    });
    expect(result.paths.sort()).toEqual(["extra.txt", "notes.txt"]);

    const state = await d.workspaces.pending.listChangelists(ids(alice));
    expect(state.changelists).toMatchObject([
      { id: clId, branchName: "feature" },
    ]);
    expect(await claimsOf(alice)).toEqual({
      "notes.txt": "feature+staged",
      "extra.txt": "feature+staged",
      // Outside the changelist: not moved.
      "stay.txt": "main+staged",
    });

    const { jobId } = await d.workspaces.pending.submit({
      ...ids(alice),
      message: "feature work",
      changelistId: clId,
      noProgress: true,
    });
    await waitForJob(jobId);

    const db = testDb.client;
    expect(
      await contentAtHead(db, scene!.repoId, "feature", "notes.txt"),
    ).toBe(EDITED);
    expect(await contentAtHead(db, scene!.repoId, "main", "notes.txt")).toBe(
      ORIGINAL,
    );
    expect(await pathsAtHead(db, scene!.repoId, "feature")).toContain(
      "extra.txt",
    );
    expect(await pathsAtHead(db, scene!.repoId, "main")).not.toContain(
      "extra.txt",
    );

    // Submitted, so gone; main's default keeps what it had.
    expect(
      (await d.workspaces.pending.listChangelists(ids(alice))).changelists,
    ).toEqual([]);
    expect((await claimsOf(alice))["stay.txt"]).toBe("main+staged");
  });

  it("cuts a new branch where the workspace is synced, without pulling it forward", async () => {
    // A busy team: Bob lands work on main after Alice's last sync, including
    // a new version of an asset Alice is editing. Alice moving her changelist
    // to a new branch must neither drag her up to head nor be refused over
    // changes she is not receiving.
    const { alice, bob } = scene!;
    const d = await daemon();
    await put(alice, "art.uasset", "art v1");
    await stageAndSubmit(alice, ["art.uasset"]);
    const aliceAt = await headOf(testDb.client, scene!.repoId, "main");

    await syncLatest(bob);
    await put(bob, "art.uasset", "art v2 (bob)");
    await put(bob, "bobs.txt", "bob\n");
    await stageAndSubmit(bob, ["art.uasset", "bobs.txt"]);
    const mainHead = await headOf(testDb.client, scene!.repoId, "main");
    expect(mainHead).toBeGreaterThan(aliceAt);

    await put(alice, "art.uasset", "art v1 (alice local edit)");
    const clId = await startOnMain(alice);
    // The precondition for the switch's overwrite check: a local binary edit
    // to a file main has moved on from.
    expect((await pendingChanges(alice))["art.uasset"]).toMatch(/^Changed/);

    // What the desktop's "New branch..." does: create with no head, activate.
    await d.workspaces.branches.create({
      ...ids(alice),
      name: "feature",
      type: "FEATURE",
      parentBranchName: "main",
    });
    expect(await headOf(testDb.client, scene!.repoId, "feature")).toBe(
      aliceAt,
    );
    await switchBranch(alice, "feature");
    await d.workspaces.pending.setChangelistBranch({
      ...ids(alice),
      changelistId: clId,
      branchName: "feature",
    });

    // Nothing of Bob's arrived, and her local edit is untouched.
    expect(await exists(alice, "bobs.txt")).toBe(false);
    expect(await read(alice, "art.uasset")).toBe("art v1 (alice local edit)");

    const { jobId } = await d.workspaces.pending.submit({
      ...ids(alice),
      message: "feature work",
      changelistId: clId,
      noProgress: true,
    });
    await waitForJob(jobId);
    expect(
      await contentAtHead(testDb.client, scene!.repoId, "feature", "notes.txt"),
    ).toBe(EDITED);
    expect(await headOf(testDb.client, scene!.repoId, "main")).toBe(mainHead);
  });

  it("refuses a branch that is not active here, and changes nothing", async () => {
    const { alice } = scene!;
    const d = await daemon();
    const clId = await startOnMain(alice);
    await apiAs(alice).branch.createBranch({
      repoId: scene!.repoId,
      name: "feature",
      type: "FEATURE",
      parentBranchName: "main",
    });
    const before = await claimsOf(alice);

    await expect(
      d.workspaces.pending.setChangelistBranch({
        ...ids(alice),
        changelistId: clId,
        branchName: "feature",
      }),
    ).rejects.toThrow(/not active/);

    expect(
      (await d.workspaces.pending.listChangelists(ids(alice))).changelists[0]
        ?.branchName,
    ).toBe("main");
    expect(await claimsOf(alice)).toEqual(before);
  });

  it("puts every claim back when the server refuses one", async () => {
    const { alice } = scene!;
    const d = await daemon();
    const clId = await startOnMain(alice);
    await createAndActivateFeature(alice);
    const before = await claimsOf(alice);

    // The server refuses to move extra.txt to feature, whichever order the
    // files are moved in; every other checkout goes through for real.
    overrides.procedures = {
      file: {
        checkout: async (input: unknown) => {
          const { filePath, branchName } = input as {
            filePath: string;
            branchName: string;
          };
          if (filePath === "extra.txt" && branchName === "feature") {
            throw new Error("held elsewhere");
          }
          return apiAs(alice).file.checkout(input as never);
        },
      },
    } as never;

    await expect(
      d.workspaces.pending.setChangelistBranch({
        ...ids(alice),
        changelistId: clId,
        branchName: "feature",
      }),
    ).rejects.toThrow(/held elsewhere/);
    delete overrides.procedures;

    expect(
      (await d.workspaces.pending.listChangelists(ids(alice))).changelists[0]
        ?.branchName,
    ).toBe("main");
    expect(await claimsOf(alice)).toEqual(before);
  });

  it("is a no-op for the branch it already targets, and refuses a missing changelist", async () => {
    const { alice } = scene!;
    const d = await daemon();
    const clId = await startOnMain(alice);
    const before = await claimsOf(alice);

    const same = await d.workspaces.pending.setChangelistBranch({
      ...ids(alice),
      changelistId: clId,
      branchName: "main",
    });
    expect(same.paths).toEqual([]);
    expect(await claimsOf(alice)).toEqual(before);

    await expect(
      d.workspaces.pending.setChangelistBranch({
        ...ids(alice),
        changelistId: 999,
        branchName: "main",
      }),
    ).rejects.toThrow(/999/);
  });
});
