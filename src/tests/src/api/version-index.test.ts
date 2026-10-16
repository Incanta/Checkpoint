/**
 * The app records a changelist (or attaches artifacts) only when its version
 * index is in the repo's own storage (src/app/src/server/version-index.ts),
 * whoever calls it: a changelist pointing files at content that does not exist
 * can never be synced. Asked of the core server; here fetch stands in for it.
 * Moved here from the data-loss red team (DL-16).
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
import config from "@incanta/config";

import { createTestDb, type TestDb } from "../harness/db";
import {
  makeOrg,
  makeRepo,
  makeUser,
  makeWorkspace,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

const REAL = `${"a".repeat(64)}.lvi`;
const OTHER = `${"b".repeat(64)}.lvi`;

describe("version indexes a changelist names", () => {
  let testDb: TestDb;
  let caller: Caller;
  let repoId: string;
  let orgId: string;
  let workspaceId: string;
  /** Storage paths the stand-in core server says exist. */
  let stored: Set<string>;
  let asked: string[];

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
    const owner = await makeUser(testDb.client);
    const org = await makeOrg(testDb.client, {
      ownerId: owner.id,
      ownerRole: "ADMIN",
    });
    const repo = await makeRepo(testDb.client, org.id, owner.id);
    const workspace = await makeWorkspace(
      testDb.client,
      repo.id,
      org.id,
      owner.id,
    );
    caller = await makeAppCaller({ asUser: owner });
    repoId = repo.id;
    orgId = org.id;
    workspaceId = workspace.id;

    stored = new Set([`/${orgId}/${repoId}/versions/${REAL}`]);
    asked = [];
    const realGet = config.get.bind(config);
    vi.spyOn(config, "get").mockImplementation(((key: string) =>
      key === "storage.verify-version-index"
        ? true
        : realGet(key)) as typeof config.get);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/system/version-exists") {
        throw new Error(`unexpected request to ${url.pathname}`);
      }
      const p = url.searchParams.get("path")!;
      asked.push(p);
      return new Response(JSON.stringify({ exists: stored.has(p) }), {
        status: 200,
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const submit = (versionIndex: string, path = "Content/level.txt") =>
    caller.changelist.createChangelist({
      message: "m",
      repoId,
      versionIndex,
      branchName: "main",
      modifications: [{ path, delete: false, baseChangelist: null }],
      keepCheckedOut: false,
      workspaceId,
    });

  it("records a changelist whose version index is in the repo's storage", async () => {
    await expect(submit(REAL)).resolves.toBeDefined();
    expect(asked).toEqual([`/${orgId}/${repoId}/versions/${REAL}`]);
  });

  it("refuses a changelist that names no version index for the files it writes", async () => {
    await expect(submit("")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a version index that is not in storage", async () => {
    await expect(submit(OTHER)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("not in this repo's storage"),
    });
  });

  it("refuses another repo's version index", async () => {
    stored.add(`/${orgId}/some-other-repo/versions/${OTHER}`);
    await expect(submit(OTHER)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a name that is not a version index", async () => {
    await expect(submit("../../x.lvi")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(asked).toEqual([]);
  });

  it("refuses when storage cannot be asked, rather than letting it through", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(submit(REAL)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("could not confirm"),
    });
  });

  it("records a delete-only changelist, which names no index", async () => {
    const added = (await submit(REAL)).number;
    await expect(
      caller.changelist.createChangelist({
        message: "delete",
        repoId,
        versionIndex: "",
        branchName: "main",
        modifications: [
          { path: "Content/level.txt", delete: true, baseChangelist: added },
        ],
        keepCheckedOut: false,
        workspaceId,
      }),
    ).resolves.toBeDefined();
  });
});
