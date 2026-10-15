/**
 * Red team: working on a feature branch overlaid on the domain root.
 *
 * A workspace materializes from a domain root (main) and overlays feature
 * branches; switching to a feature branch pulls that branch's head and
 * records it in `activeBranches`. Nothing after the switch reads
 * `activeBranches`: pull, sync status, the pre-submit merge, and the conflict
 * check all aim at the domain root's head. And no daemon code sets a state
 * entry's `branch`, so every tracked file "came from" the domain root, and a
 * submit to the feature branch sends no base changelist for any of them.
 *
 * Driven through the daemon's own endpoints against the real app routers,
 * with only the native addon faked (see ./stack.ts). See ./README.md.
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

vi.mock(
  "@checkpointvcs/longtail-addon",
  async () => (await import("./stack")).fakeAddon,
);
vi.mock("@checkpointvcs/common", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stack = await import("./stack");
  return {
    ...actual,
    CreateApiClientAuth: stack.createApiClientAuth,
    GetAuthConfigUser: stack.getAuthConfigUser,
  };
});
vi.mock(
  "../../../core/daemon/src/daemon-config.js",
  async () => (await import("./stack")).fakeDaemonConfigModule,
);
vi.mock(
  "../../../core/daemon/src/logging.js",
  async () => (await import("./stack")).fakeLoggingModule,
);

import { createTestDb, type TestDb } from "../harness/db";
import { closeAllStateStores } from "../../../core/daemon/src/util/state-store.js";
import {
  checkConflicts,
  pullTextFilesForSubmit,
  submit,
} from "../../../core/daemon/src/util/index.js";
import {
  apiAs,
  contentAtHead,
  lastSubmit,
  makeScene,
  put,
  read,
  resetStack,
  stageAndSubmit,
  storeVersion,
  switchBranch,
  syncLatest,
  tearDownScene,
  type Scene,
  type Seat,
} from "./stack";

const FIVE_LINES = "one\ntwo\nthree\nfour\nfive\n";

describe("data loss: feature branches", () => {
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

    // main has notes.txt; "feature" is cut from it.
    const { alice } = scene;
    await put(alice, "notes.txt", FIVE_LINES);
    await stageAndSubmit(alice, ["notes.txt"]);
    await apiAs(alice).branch.createBranch({
      repoId: scene.repoId,
      name: "feature",
      type: "FEATURE",
      parentBranchName: "main",
    });
  });

  afterEach(async () => {
    closeAllStateStores();
    await tearDownScene(scene);
    scene = undefined;
  });

  const featureHas = (relativePath: string) =>
    contentAtHead(testDb.client, scene!.repoId, "feature", relativePath);

  /**
   * Everything the daemon's submit endpoint runs once it has its list of
   * modifications (api/routers/workspace/pending.ts), with the same arguments:
   * the conflict check, the pre-submit merge of outdated text files, and the
   * submit itself. Today the endpoint's own filter never lets a modified file
   * through to a feature branch (see the "gate" test below), so this is the
   * path a feature-branch submit takes as soon as that is fixed.
   */
  async function submitBehindTheGate(
    seat: Seat,
    paths: string[],
    branch: string,
  ) {
    const workspaceInfo = {
      id: seat.workspace.id,
      repoId: seat.workspace.repoId,
      domainBranchName: seat.workspace.domainBranchName,
      workspaceName: seat.workspace.name,
      localPath: seat.root,
      daemonId: seat.workspace.daemonId,
    };
    const conflicts = await checkConflicts(workspaceInfo, paths);
    if (conflicts.hasConflicts) {
      throw new Error(
        `conflicts: ${conflicts.conflicts.map((c) => c.path).join(", ")}`,
      );
    }
    const merged = await pullTextFilesForSubmit(
      workspaceInfo,
      seat.orgId,
      paths,
    );
    if (merged.conflictMerges.length > 0) {
      throw new Error(`merge conflicts: ${merged.conflictMerges.join(", ")}`);
    }
    await submit(
      workspaceInfo,
      seat.orgId,
      `${seat.name} on ${branch}`,
      paths.map((p) => ({ path: p, delete: false })),
      seat.workspace.id,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      branch,
    );
  }

  it("keeps the branch's changes in the workspace when you pull with the branch active", async () => {
    // Live today. Bob activates "feature" and gets its version of notes.txt.
    // Then he presses Pull. The pull targets main's head, so the diff takes
    // feature's change back out of his workspace, and the state now says
    // notes.txt is main's version.
    // (Alice's feature work goes straight to the API: see the gate test.)
    const { alice, bob } = scene!;
    const featureNotes = FIVE_LINES.replace("one", "one (feature)");
    await apiAs(alice).changelist.createChangelist({
      message: "feature work",
      repoId: scene!.repoId,
      versionIndex: storeVersion({ "notes.txt": featureNotes }),
      branchName: "feature",
      modifications: [{ path: "notes.txt", delete: false, baseChangelist: 1 }],
      keepCheckedOut: false,
      workspaceId: alice.workspace.id,
    });

    await syncLatest(bob);
    await switchBranch(bob, "feature");
    expect(bob.workspace.activeBranches).toEqual(["feature"]);
    expect(await read(bob, "notes.txt")).toBe(featureNotes);

    await syncLatest(bob);

    expect(await read(bob, "notes.txt")).toBe(featureNotes);
  });

  it("gate: submits a modified file staged to an active feature branch", async () => {
    // Not data loss, but the reason the two tests after it are latent rather
    // than live. Changed files in the daemon's pending list never carry their
    // claims, and the submit endpoint (like the desktop's bucket view) puts a
    // file in a branch's bucket only by its claim, so every changed file is
    // "destined" for the domain root and a feature-branch submit finds
    // nothing: "Nothing staged for feature".
    const { alice } = scene!;
    await switchBranch(alice, "feature");
    await put(alice, "notes.txt", FIVE_LINES.replace("one", "one (feature)"));

    await stageAndSubmit(alice, ["notes.txt"], { branch: "feature" });

    expect(await featureHas("notes.txt")).toBe(
      FIVE_LINES.replace("one", "one (feature)"),
    );
  });

  it("latent: a second edit on a feature branch does not revert the first", async () => {
    // One person, no concurrency. The pre-submit merge compares the
    // workspace with main's head, so main's older notes.txt looks like an
    // upstream change. It merges cleanly (different lines) and the first
    // feature edit is taken back out, on disk and in the changelist.
    const { alice } = scene!;
    await switchBranch(alice, "feature");

    const first = FIVE_LINES.replace("one", "one (first feature edit)");
    await put(alice, "notes.txt", first);
    await submitBehindTheGate(alice, ["notes.txt"], "feature");
    expect(await featureHas("notes.txt")).toBe(first);

    await put(
      alice,
      "notes.txt",
      first.replace("five", "five (second feature edit)"),
    );
    await submitBehindTheGate(alice, ["notes.txt"], "feature");

    expect(await featureHas("notes.txt")).toBe(
      "one (first feature edit)\ntwo\nthree\nfour\nfive (second feature edit)\n",
    );
    expect(await read(alice, "notes.txt")).toContain(
      "one (first feature edit)",
    );
  });

  it("latent: a stale submit to a feature branch does not silently replace a teammate's change", async () => {
    // Alice and Bob both have "feature" active. Alice submits an edit; Bob,
    // who has not pulled it, submits his. With no base on either submit the
    // server cannot tell Bob's copy is stale, and both checks the daemon runs
    // first look at main, where nothing changed. Text files take advisory
    // claims, so nothing else stands in the way.
    const { alice, bob } = scene!;
    await syncLatest(bob);
    await switchBranch(alice, "feature");
    await switchBranch(bob, "feature");

    await put(alice, "notes.txt", FIVE_LINES.replace("one", "one (alice)"));
    await submitBehindTheGate(alice, ["notes.txt"], "feature");

    await put(bob, "notes.txt", FIVE_LINES.replace("five", "five (bob)"));
    // Refusing Bob's submit is a safe outcome; so is merging Alice's line in.
    await submitBehindTheGate(bob, ["notes.txt"], "feature").catch(
      () => undefined,
    );

    expect(await featureHas("notes.txt")).toContain("one (alice)");
  });

  it("latent: a submit to a feature branch tells the server what each file was based on", async () => {
    // The cause of the test above, checked directly. Alice's notes.txt is
    // recorded at changelist 1, which is exactly what "feature" holds, so the
    // base is comparable. It is dropped because the state entry has no
    // `branch`, so the file is taken to have come from main.
    const { alice } = scene!;
    await switchBranch(alice, "feature");
    await put(alice, "notes.txt", FIVE_LINES.replace("one", "one (feature)"));

    await submitBehindTheGate(alice, ["notes.txt"], "feature");

    expect(lastSubmit.modifications?.[0]).toHaveProperty("baseChangelist", 1);
  });
});
