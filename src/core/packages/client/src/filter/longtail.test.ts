import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { dir, type DirectoryResult } from "tmp-promise";
import { promises as fs, existsSync } from "fs";
import path from "path";
import { CreateVersion } from "./longtail";
import { TestClientStubbedServer } from "./test-client-stubbed-server";
import { DefaultConfig } from "../config";

describe("Longtail", () => {
  let repoDir: DirectoryResult;
  const file1Path = "test1.bin";
  const file1Contents = "hello world 1";
  const file2Path = "test2.bin";
  const file2Contents = "goodbye universe 2";
  const filePath = "test3.bin";
  const file3Contents = "whats up 3";

  beforeAll(async () => {
    repoDir = await dir({
      unsafeCleanup: true,
    });

    await fs.writeFile(path.join(repoDir.path, file1Path), file1Contents);
    await fs.writeFile(path.join(repoDir.path, file2Path), file2Contents);
    await fs.writeFile(path.join(repoDir.path, filePath), file3Contents);
  });

  it("creates a VersionIndex for the first file", async () => {
    const config = DefaultConfig;
    config.repoRoot = repoDir.path;
    const client = new TestClientStubbedServer();
    await CreateVersion(config, client, [file1Path]);
  });

  afterAll(async () => {
    await repoDir.cleanup();
  });
});
