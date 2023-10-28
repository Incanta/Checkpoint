import config from "@incanta/config";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { dir } from "tmp-promise";
import { existsSync, promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import util from "util";
import crc32 from "crc/crc32";
import { Longtail, IChangesetManifest } from "../packages/common/src/index";

function getMd5Hash(str: string): string {
  const crc32 = crypto.createHash("md5");
  crc32.update(str);
  return crc32.digest("hex");
}

describe("Basic Scenario", () => {
  let repoStoreDir: string;
  let cleanupRepoStore: () => Promise<void>;

  let repoDir: string;
  let cleanupRepo: () => Promise<void>;

  let workspaceDir: string;
  let cleanupWorkspace: () => Promise<void>;

  let v2Dir: string;
  let cleanupV2Dir: () => Promise<void>;

  let v3Dir: string;
  let cleanupV3Dir: () => Promise<void>;

  const readmeName = "README.md";
  const readmeOriginalContents = "# My Repo";
  const readmeAdditionalContents = "\n\nThis is my repo";

  const file1Name = "file-1.txt";
  const file1Contents = "hello world";

  const file2Name = "file-2.txt";
  const file2Contents = "goodbye universe";

  let changesetManifest: IChangesetManifest;

  beforeAll(async () => {
    process.env.LONGTAIL_PATH = "../golongtail/cmd/longtail";

    const repoResult = await dir({ unsafeCleanup: true });
    cleanupRepo = repoResult.cleanup;
    repoDir = repoResult.path;

    const repoStoreResult = await dir({ unsafeCleanup: true });
    cleanupRepoStore = repoStoreResult.cleanup;
    repoStoreDir = repoStoreResult.path;

    const workspaceResult = await dir({ unsafeCleanup: true });
    cleanupWorkspace = workspaceResult.cleanup;
    workspaceDir = workspaceResult.path;

    const v2Result = await dir({ unsafeCleanup: true });
    cleanupV2Dir = v2Result.cleanup;
    v2Dir = v2Result.path;

    const v3Result = await dir({ unsafeCleanup: true });
    cleanupV3Dir = v3Result.cleanup;
    v3Dir = v3Result.path;
  });

  test("Creates a repo", async () => {
    await fs.writeFile(path.join(repoDir, readmeName), readmeOriginalContents, {
      encoding: "utf-8",
    });

    const contents = await fs.readFile(path.join(repoDir, readmeName), {
      encoding: "utf-8",
    });

    expect(contents).toBe(readmeOriginalContents);

    await Longtail.put({
      version: "1",
      localPath: repoDir,
      remotePath: repoStoreDir,
    });

    expect(existsSync(path.join(repoStoreDir, "1.json"))).toBe(true);
    expect(existsSync(path.join(repoStoreDir, "store"))).toBe(true);
    expect(existsSync(path.join(repoStoreDir, "version-data"))).toBe(true);
  });

  test("Gets a workspace", async () => {
    await Longtail.get({
      version: "1",
      localPath: workspaceDir,
      remotePath: repoStoreDir,
    });

    expect(existsSync(path.join(workspaceDir, readmeName))).toBe(true);

    const contents = await fs.readFile(path.join(workspaceDir, readmeName), {
      encoding: "utf-8",
    });

    expect(contents).toBe(readmeOriginalContents);
  });

  test("Modify workspace contents", async () => {
    // create file 1
    await fs.writeFile(path.join(workspaceDir, file1Name), file1Contents, {
      encoding: "utf-8",
    });

    let contents = await fs.readFile(path.join(workspaceDir, file1Name), {
      encoding: "utf-8",
    });

    expect(contents).toBe(file1Contents);

    // create file 2
    await fs.writeFile(path.join(workspaceDir, file2Name), file2Contents, {
      encoding: "utf-8",
    });

    contents = await fs.readFile(path.join(workspaceDir, file2Name), {
      encoding: "utf-8",
    });

    expect(contents).toBe(file2Contents);

    // modify readme
    await fs.appendFile(
      path.join(workspaceDir, readmeName),
      readmeAdditionalContents,
      { encoding: "utf-8" }
    );

    contents = await fs.readFile(path.join(workspaceDir, readmeName), {
      encoding: "utf-8",
    });

    expect(contents).toBe(readmeOriginalContents + readmeAdditionalContents);
  });

  test("Make commit '2' for 1 added, 1 changed, 1 not committed", async () => {
    const file1Stats = await fs.stat(path.join(workspaceDir, file1Name));
    const readmeStats = await fs.stat(path.join(workspaceDir, readmeName));

    // todo: use the module to calculate potential files and check
    // values
    changesetManifest = {
      message: "test changeset",
      files: [
        {
          type: "add",
          path: "",
          name: file1Name,
          size: file1Stats.size,
          modifiedTime: file1Stats.mtimeMs,
          changedTime: file1Stats.ctimeMs,
          crc32: crc32(file1Contents).toString(16),
          md5: getMd5Hash(file1Contents),
        },
        {
          type: "change",
          path: "",
          name: readmeName,
          size: readmeStats.size,
          modifiedTime: readmeStats.mtimeMs,
          changedTime: readmeStats.ctimeMs,
          crc32: crc32(
            readmeOriginalContents + readmeAdditionalContents
          ).toString(16),
          md5: getMd5Hash(readmeOriginalContents + readmeAdditionalContents),
        },
      ],
    };

    await Longtail.commit("1", changesetManifest, {
      version: "2",
      localPath: workspaceDir,
      remotePath: repoStoreDir,
    });
  });

  test("Checks commit '2'", async () => {
    await Longtail.get({
      version: "2",
      localPath: v2Dir,
      remotePath: repoStoreDir,
    });

    expect(existsSync(path.join(v2Dir, readmeName))).toBe(true);
    expect(existsSync(path.join(v2Dir, file1Name))).toBe(true);
    expect(existsSync(path.join(v2Dir, file2Name))).toBe(false);

    let contents = await fs.readFile(path.join(v2Dir, file1Name), {
      encoding: "utf-8",
    });

    expect(contents).toBe(file1Contents);

    contents = await fs.readFile(path.join(v2Dir, readmeName), {
      encoding: "utf-8",
    });

    expect(contents).toBe(readmeOriginalContents + readmeAdditionalContents);
  });

  test("Make commit '3' for 1 removed and 1 not committed", async () => {
    changesetManifest = {
      message: "test delete changeset",
      files: [
        {
          type: "delete",
          path: "",
          name: file1Name,
          size: 0,
          modifiedTime: 0,
          changedTime: 0,
          crc32: "",
          md5: "",
        },
      ],
    };

    await fs.rm(path.join(workspaceDir, file1Name));
    expect(existsSync(path.join(workspaceDir, file1Name))).toBe(false);

    await Longtail.commit("2", changesetManifest, {
      version: "3",
      localPath: workspaceDir,
      remotePath: repoStoreDir,
    });
  });

  test("Checks commit '3'", async () => {
    await Longtail.get({
      version: "3",
      localPath: v3Dir,
      remotePath: repoStoreDir,
    });

    expect(existsSync(path.join(v3Dir, readmeName))).toBe(true);
    expect(existsSync(path.join(v3Dir, file1Name))).toBe(false);
    expect(existsSync(path.join(v3Dir, file2Name))).toBe(false);

    const contents = await fs.readFile(path.join(v3Dir, readmeName), {
      encoding: "utf-8",
    });

    expect(contents).toBe(readmeOriginalContents + readmeAdditionalContents);
  });

  afterAll(async () => {
    await cleanupV3Dir();
    await cleanupV2Dir();
    await cleanupWorkspace();
    await cleanupRepoStore();
    await cleanupRepo();
  });
});
