/**
 * Feature branches overlaid on a workspace. Every pull and pre-submit check
 * targets the active branch's head (syncTargetBranch), every submit tells the
 * server what each file was based on, and a file staged to a branch is
 * submitted there. Moved here from the data-loss red team (DL-10, DL-11,
 * DL-12, and the gate).
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
  pendingChanges,
} from "../harness/stack";

const FIVE_LINES = "one\ntwo\nthree\nfour\nfive\n";

// Each test runs two daemons' worth of submits and pulls (and the Windows
// lock tests start a PowerShell), which hosted runners can take well past the
// suite's default timeout on.
describe("feature branches", { timeout: 120_000 }, () => {
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

  it("submits a modified file staged to an active feature branch", async () => {
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

  it("a second edit on a feature branch does not revert the first", async () => {
    // One person, no concurrency. The pre-submit merge compares the
    // workspace with main's head, so main's older notes.txt looks like an
    // upstream change. It merges cleanly (different lines) and the first
    // feature edit is taken back out, on disk and in the changelist.
    const { alice } = scene!;
    await switchBranch(alice, "feature");

    const first = FIVE_LINES.replace("one", "one (first feature edit)");
    await put(alice, "notes.txt", first);
    await stageAndSubmit(alice, ["notes.txt"], { branch: "feature" });
    expect(await featureHas("notes.txt")).toBe(first);

    await put(
      alice,
      "notes.txt",
      first.replace("five", "five (second feature edit)"),
    );
    await stageAndSubmit(alice, ["notes.txt"], { branch: "feature" });

    expect(await featureHas("notes.txt")).toBe(
      "one (first feature edit)\ntwo\nthree\nfour\nfive (second feature edit)\n",
    );
    expect(await read(alice, "notes.txt")).toContain(
      "one (first feature edit)",
    );
  });

  it("a stale submit to a feature branch does not silently replace a teammate's change", async () => {
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
    await stageAndSubmit(alice, ["notes.txt"], { branch: "feature" });

    await put(bob, "notes.txt", FIVE_LINES.replace("five", "five (bob)"));
    // Refusing Bob's submit is a safe outcome; so is merging Alice's line in.
    await stageAndSubmit(bob, ["notes.txt"], { branch: "feature" }).catch(
      () => undefined,
    );

    expect(await featureHas("notes.txt")).toContain("one (alice)");
  });

  it("a submit to a feature branch tells the server what each file was based on", async () => {
    // The cause of the test above, checked directly. Alice's notes.txt is
    // recorded at changelist 1, which is exactly what "feature" holds, so the
    // base is comparable. It is dropped because the state entry has no
    // `branch`, so the file is taken to have come from main.
    const { alice } = scene!;
    await switchBranch(alice, "feature");
    await put(alice, "notes.txt", FIVE_LINES.replace("one", "one (feature)"));

    await stageAndSubmit(alice, ["notes.txt"], { branch: "feature" });

    expect(lastSubmit.modifications?.[0]).toHaveProperty("baseChangelist", 1);
  });

  it("keeps a stacked branch's changes, and its parent's, when you pull with it active", async () => {
    const { alice, bob } = scene!;
    await apiAs(alice).branch.createBranch({
      repoId: scene!.repoId,
      name: "upper",
      type: "FEATURE",
      parentBranchName: "feature",
    });
    await switchBranch(alice, "feature");
    const lower = FIVE_LINES.replace("one", "one (feature)");
    await put(alice, "notes.txt", lower);
    await stageAndSubmit(alice, ["notes.txt"], { branch: "feature" });
    await switchBranch(alice, "upper");
    const upper = lower.replace("five", "five (upper)");
    await put(alice, "notes.txt", upper);
    await stageAndSubmit(alice, ["notes.txt"], { branch: "upper" });

    await syncLatest(bob);
    await switchBranch(bob, "upper");
    expect(bob.workspace.activeBranches).toEqual(["feature", "upper"]);
    await syncLatest(bob);

    expect(await read(bob, "notes.txt")).toBe(upper);
  });

  it("goes back to the domain root's version when the branch is deactivated", async () => {
    const { alice, bob } = scene!;
    await switchBranch(alice, "feature");
    await put(alice, "notes.txt", FIVE_LINES.replace("one", "one (feature)"));
    await stageAndSubmit(alice, ["notes.txt"], { branch: "feature" });

    await syncLatest(bob);
    await switchBranch(bob, "feature");
    await switchBranch(bob, "main");
    await syncLatest(bob);

    expect(await read(bob, "notes.txt")).toBe(FIVE_LINES);
    expect(await pendingChanges(bob)).toEqual({});
  });

  it("still submits to the domain root with the base checked", async () => {
    const { alice, bob } = scene!;
    await syncLatest(bob);
    await put(alice, "notes.txt", FIVE_LINES.replace("one", "one (alice)"));
    await stageAndSubmit(alice, ["notes.txt"]);

    // Bob has not pulled Alice's change; his stale copy must not replace it.
    await put(bob, "notes.txt", FIVE_LINES.replace("five", "five (bob)"));
    await stageAndSubmit(bob, ["notes.txt"]).catch(() => undefined);

    expect(
      await contentAtHead(testDb.client, scene!.repoId, "main", "notes.txt"),
    ).toContain("one (alice)");
  });
});
