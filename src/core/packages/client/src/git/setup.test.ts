import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { dir, type DirectoryResult } from "tmp-promise";
import { promises as fs, existsSync } from "fs";
import path from "path";
import {
  AttributeFilterSuffix,
  InstallFilter,
  lfsError,
  SetUpGitAttributes,
  Track,
  UpdateGitHooks,
} from "./setup";
import { exec } from "../util";
import { GetGitConfig } from "./config";
import { getConfig } from "../config";

describe("Git Setup", () => {
  let gitDir: DirectoryResult;

  beforeAll(async () => {
    gitDir = await dir({
      unsafeCleanup: true,
    });

    await exec(`git init`, gitDir.path);
  });

  it("installs the filter", async () => {
    await InstallFilter(gitDir.path);

    const gitConfig = await GetGitConfig(
      path.join(gitDir.path, ".git", "config")
    );

    // expect(gitConfig.filter.checkpoint.process).toBe("git-chk filter-process");
    expect(gitConfig.filter.checkpoint.required).toBe("true");
    expect(gitConfig.filter.checkpoint.clean).toBe("git-chk clean %f");
    expect(gitConfig.filter.checkpoint.smudge).toBe("git-chk smudge %f");
  });

  it("installs .gitattributes", async () => {
    const checkpointConfig = await getConfig(gitDir.path);
    expect(checkpointConfig.gitRoot).toBe(gitDir.path);

    await SetUpGitAttributes(checkpointConfig);

    const gitAttributes = await fs.readFile(
      path.join(gitDir.path, ".gitattributes"),
      "utf-8"
    );

    expect(
      gitAttributes.includes(
        "filter=checkpoint diff=checkpoint merge=checkpoint -text"
      )
    ).toBeTrue();
  });

  it("installs the hook files", async () => {
    const checkpointConfig = await getConfig(gitDir.path);
    expect(checkpointConfig.gitRoot).toBe(gitDir.path);

    await UpdateGitHooks(checkpointConfig, false);

    expect(
      existsSync(path.join(gitDir.path, ".git", "hooks", "post-commit"))
    ).toBeTrue();
  });

  it("tracks an individual pattern", async () => {
    const checkpointConfig = await getConfig(gitDir.path);
    expect(checkpointConfig.gitRoot).toBe(gitDir.path);

    await Track(checkpointConfig, "*.xyz");

    const gitattributes = await fs.readFile(
      path.join(gitDir.path, ".gitattributes"),
      "utf-8"
    );

    expect(gitattributes.split("\n").at(-1)).toBe(
      `*.xyz ${AttributeFilterSuffix}`
    );
  });

  it("fails to install hook files if LFS is enabled on the current repo", async () => {
    const checkpointConfig = await getConfig(gitDir.path);
    expect(checkpointConfig.gitRoot).toBe(gitDir.path);

    await exec(`git lfs track "*.abc"`, gitDir.path);

    const gitattributes = await fs.readFile(
      path.join(gitDir.path, ".gitattributes"),
      "utf-8"
    );
    expect(gitattributes.includes("lfs")).toBeTrue();

    const promise = UpdateGitHooks(checkpointConfig, false);

    expect(promise).rejects.toBe(lfsError);
  });

  afterAll(async () => {
    await gitDir.cleanup();
  });
});
