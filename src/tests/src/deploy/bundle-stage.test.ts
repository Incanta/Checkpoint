/**
 * Bundle staging: dependency closure and symlink resolution.
 *
 * Both of these encode facts about how the build toolchains lay out
 * node_modules, and both have already shipped bundles that booted and then
 * died in the container:
 *
 *   - copying node_modules/prisma without its hoisted dependencies produced
 *     `Cannot find module 'effect'` during migrations
 *   - leaving Turbopack's and Yarn's absolute symlinks in place produced
 *     `Cannot find module 'pino-28069d5257187539'` at server start
 *
 * The failures only appear once a bundle is extracted somewhere other than the
 * path it was built at, which no build-time check catches, so they are pinned
 * here instead.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const { copyPackageClosure, resolveStagedSymlinks, verifyBundleResolves } =
  require("../../../../scripts/bundle/stage.js") as {
    copyPackageClosure: (opts: {
      roots: string[];
      repoRoot: string;
      stageDir: string;
    }) => { copied: string[]; kept: string[] };
    resolveStagedSymlinks: (opts: {
      repoRoot: string;
      stageDir: string;
      log?: (line: string) => void;
    }) => { relinked: number; materialised: number; dropped: number };
    verifyBundleResolves: (opts: {
      stageDir: string;
      scanDirs: string[];
    }) => { scanned: number };
  };

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function writeFile(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writePackage(
  root: string,
  name: string,
  pkg: Record<string, unknown> = {},
): string {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js", ...pkg }),
  );
  writeFile(path.join(dir, "index.js"), `module.exports = ${JSON.stringify(name)};\n`);
  return dir;
}

describe("copyPackageClosure", () => {
  it("copies a package with its transitive dependencies", () => {
    const repoRoot = scratch("cp-repo-");
    const stageDir = scratch("cp-stage-");

    writePackage(repoRoot, "cli", { dependencies: { mid: "^1" } });
    writePackage(repoRoot, "mid", { dependencies: { "@scope/leaf": "^1" } });
    writePackage(repoRoot, "@scope/leaf");

    const result = copyPackageClosure({ roots: ["cli"], repoRoot, stageDir });

    expect(result.copied.sort()).toEqual(["@scope/leaf", "cli", "mid"]);
    for (const name of ["cli", "mid", "@scope/leaf"]) {
      expect(
        fs.existsSync(path.join(stageDir, "node_modules", name, "index.js")),
      ).toBe(true);
    }
  });

  it("keeps an already-staged copy rather than overwriting it", () => {
    const repoRoot = scratch("cp-repo-");
    const stageDir = scratch("cp-stage-");

    writePackage(repoRoot, "cli", { dependencies: { mid: "^1" } });
    writePackage(repoRoot, "mid");
    // Stands in for Next's traced copy, which is the version the app was built
    // against and must win over the hoisted one.
    writeFile(
      path.join(stageDir, "node_modules/mid/index.js"),
      "module.exports = 'traced';\n",
    );

    const result = copyPackageClosure({ roots: ["cli"], repoRoot, stageDir });

    expect(result.kept).toEqual(["mid"]);
    expect(
      fs.readFileSync(path.join(stageDir, "node_modules/mid/index.js"), "utf8"),
    ).toContain("traced");
  });

  it("ignores an optional dependency that is not installed", () => {
    const repoRoot = scratch("cp-repo-");
    const stageDir = scratch("cp-stage-");

    writePackage(repoRoot, "cli", {
      optionalDependencies: { "platform-only": "^1" },
    });

    expect(() =>
      copyPackageClosure({ roots: ["cli"], repoRoot, stageDir }),
    ).not.toThrow();
  });

  it("fails the build when a required dependency is missing", () => {
    const repoRoot = scratch("cp-repo-");
    const stageDir = scratch("cp-stage-");

    writePackage(repoRoot, "cli", { dependencies: { absent: "^1" } });

    expect(() =>
      copyPackageClosure({ roots: ["cli"], repoRoot, stageDir }),
    ).toThrow(/cannot resolve absent/);
  });
});

describe("resolveStagedSymlinks", () => {
  it("rewrites a link to a staged package as a relative link", () => {
    // Turbopack: .next/node_modules/<pkg>-<hash> -> <workspace>/node_modules/<pkg>
    const repoRoot = scratch("cp-repo-");
    const stageDir = scratch("cp-stage-");

    writePackage(repoRoot, "pino");
    writeFile(
      path.join(stageDir, "node_modules/pino/index.js"),
      "module.exports = 'pino';\n",
    );
    writeFile(path.join(stageDir, "node_modules/pino/package.json"), "{}");

    const aliasDir = path.join(stageDir, "src/app/.next/node_modules");
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "node_modules/pino"),
      path.join(aliasDir, "pino-abc123"),
      "dir",
    );

    const summary = resolveStagedSymlinks({ repoRoot, stageDir });

    expect(summary.relinked).toBe(1);
    const link = path.join(aliasDir, "pino-abc123");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(path.isAbsolute(fs.readlinkSync(link))).toBe(false);
    // Resolves back inside the bundle, which is the only thing that matters
    // once it is extracted somewhere else.
    expect(fs.realpathSync(link)).toBe(
      fs.realpathSync(path.join(stageDir, "node_modules/pino")),
    );
  });

  it("materialises a link to a package the bundle does not stage", () => {
    const repoRoot = scratch("cp-repo-");
    const stageDir = scratch("cp-stage-");

    writePackage(repoRoot, "only-hoisted");
    fs.mkdirSync(path.join(stageDir, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "node_modules/only-hoisted"),
      path.join(stageDir, "node_modules/alias"),
      "dir",
    );

    const summary = resolveStagedSymlinks({ repoRoot, stageDir });

    expect(summary.materialised).toBe(1);
    const staged = path.join(stageDir, "node_modules/alias");
    expect(fs.lstatSync(staged).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(staged, "index.js"))).toBe(true);
  });

  it("relinks a staged workspace and drops the workspaces it does not ship", () => {
    // Yarn's node-modules linker symlinks every workspace into node_modules
    // with an absolute path. A server bundle stages src/core/common but not
    // src/app, and materialising src/app would drag a whole source tree in.
    const repoRoot = scratch("cp-repo-");
    const stageDir = scratch("cp-stage-");

    writeFile(path.join(repoRoot, "src/core/common/lib/index.js"), "//\n");
    writeFile(path.join(repoRoot, "src/app/huge.js"), "//\n");
    writeFile(path.join(stageDir, "src/core/common/lib/index.js"), "//\n");

    const scope = path.join(stageDir, "node_modules/@checkpointvcs");
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "src/core/common"),
      path.join(scope, "common"),
      "dir",
    );
    fs.symlinkSync(
      path.join(repoRoot, "src/app"),
      path.join(scope, "app"),
      "dir",
    );

    const summary = resolveStagedSymlinks({ repoRoot, stageDir });

    expect(summary).toMatchObject({ relinked: 1, dropped: 1 });
    // Windows stores the link with its own separator, so compare the resolved
    // path rather than the literal target.
    expect(path.isAbsolute(fs.readlinkSync(path.join(scope, "common")))).toBe(
      false,
    );
    expect(fs.realpathSync(path.join(scope, "common"))).toBe(
      fs.realpathSync(path.join(stageDir, "src/core/common")),
    );
    expect(fs.existsSync(path.join(scope, "app"))).toBe(false);
  });

  it("drops a link whose target does not exist at all", () => {
    const repoRoot = scratch("cp-repo-");
    const stageDir = scratch("cp-stage-");

    fs.mkdirSync(path.join(stageDir, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "node_modules/never-installed"),
      path.join(stageDir, "node_modules/ghost"),
      "dir",
    );

    const summary = resolveStagedSymlinks({ repoRoot, stageDir });

    expect(summary.dropped).toBe(1);
    expect(fs.existsSync(path.join(stageDir, "node_modules/ghost"))).toBe(false);
  });

  it("leaves a link that already points inside the bundle alone", () => {
    const stageDir = scratch("cp-stage-");
    const repoRoot = scratch("cp-repo-");

    writeFile(path.join(stageDir, "real/index.js"), "//\n");
    fs.mkdirSync(path.join(stageDir, "sub"), { recursive: true });
    fs.symlinkSync("../real", path.join(stageDir, "sub/link"), "dir");

    const summary = resolveStagedSymlinks({ repoRoot, stageDir });

    expect(summary).toEqual({ relinked: 0, materialised: 0, dropped: 0 });
    expect(fs.lstatSync(path.join(stageDir, "sub/link")).isSymbolicLink()).toBe(
      true,
    );
    expect(fs.realpathSync(path.join(stageDir, "sub/link"))).toBe(
      fs.realpathSync(path.join(stageDir, "real")),
    );
  });
});

describe("verifyBundleResolves", () => {
  const stageWithCode = (source: string): string => {
    const stageDir = scratch("cp-stage-");
    writeFile(path.join(stageDir, "src/core/server/lib/index.js"), source);
    fs.mkdirSync(path.join(stageDir, "node_modules"), { recursive: true });
    return stageDir;
  };

  const check = (stageDir: string) =>
    verifyBundleResolves({ stageDir, scanDirs: ["src/core/server/lib"] });

  it("names a package the code imports but the bundle does not carry", () => {
    // The exact shape that shipped: nine files importing @incanta/config,
    // declared in no workspace, pruned away by `yarn workspaces focus`.
    const stageDir = stageWithCode(`import config from "@incanta/config";\n`);
    expect(() => check(stageDir)).toThrow(/@incanta\/config/);
  });

  it("passes when the package is present", () => {
    const stageDir = stageWithCode(`import config from "@incanta/config";\n`);
    writePackage(stageDir, "@incanta/config");
    expect(check(stageDir).scanned).toBe(1);
  });

  it("accepts a subpath import of a package that is present", () => {
    // Presence, not full resolution: an "exports" map makes require.resolve
    // throw for packages that load perfectly well.
    const stageDir = stageWithCode(`import { x } from "pkg/deep/thing.js";\n`);
    writePackage(stageDir, "pkg");
    expect(() => check(stageDir)).not.toThrow();
  });

  it("ignores relative imports and node builtins", () => {
    const stageDir = stageWithCode(
      `import "./local.js";\nimport fs from "node:fs";\nimport path from "path";\n`,
    );
    expect(check(stageDir).scanned).toBe(0);
  });

  it("does not mistake quoted prose for an import", () => {
    // Compiled output is full of strings. An unanchored /from ["']/ pattern
    // matched SQL fragments, and matching require() matched prose, both of
    // which turned a working bundle into a failed build.
    const stageDir = stageWithCode(
      `const sql = "select a from \\"users\\" order by b";\n` +
        `const note = 'require("not-a-real-package") in a string';\n`,
    );
    expect(check(stageDir).scanned).toBe(0);
  });

  it("catches a dynamic import too", () => {
    const stageDir = stageWithCode(`await import("lazy-dep");\n`);
    expect(() => check(stageDir)).toThrow(/lazy-dep/);
  });
});
