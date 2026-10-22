/**
 * Which backend holds a workspace's state, and what a state save may touch.
 *
 * The regressions these pin:
 * - Callers that omitted the backend argument got "json" on a workspace whose
 *   state lives in state.db. The build executor read an empty state and wrote
 *   a fresh state.json holding only `lastBuiltChangelist`.
 * - A state.json that failed to import left behind an empty state.db, which
 *   every later open took as the workspace's real (empty) state.
 * - Every state save also rewrote workspace.json from whatever workspace
 *   object the caller held, which dropped teamSync settings on stage/unstage.
 * - An old daemon.json without `stateBackend` read as undefined.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeAllStateStores,
  getStateStore,
  resolveStateBackend,
} from "../../../core/daemon/src/util/state-store.js";
import {
  getWorkspaceState,
  saveWorkspaceState,
  type WorkspaceState,
} from "../../../core/daemon/src/util/util.js";
import { fillMissing } from "../../../core/daemon/src/daemon-config.js";

let root: string;
const dir = () => path.join(root, ".checkpoint");
const dbPath = () => path.join(dir(), "state.db");
const jsonPath = () => path.join(dir(), "state.json");

const sample: WorkspaceState = {
  changelistNumber: 42,
  files: {
    "Content/a.uasset": { fileId: "a", changelist: 40, md5: "", size: 3 },
  },
  staged: ["Content/a.uasset"],
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "chk-backend-"));
  await mkdir(dir(), { recursive: true });
});

afterEach(async () => {
  closeAllStateStores();
  await rm(root, { recursive: true, force: true });
});

async function writeSqliteState(state: WorkspaceState): Promise<void> {
  await getStateStore(root, "sqlite").save(state);
  closeAllStateStores();
}

describe("resolveStateBackend", () => {
  it.each(["json", "sqlite", undefined] as const)(
    "is sqlite for a new workspace whatever the preference (%s)",
    (preferred) => {
      expect(resolveStateBackend(root, preferred)).toBe("sqlite");
    },
  );

  it("picks sqlite whenever state.db exists, whatever was asked for", async () => {
    await writeSqliteState(sample);
    expect(resolveStateBackend(root, "json")).toBe("sqlite");
    expect(resolveStateBackend(root, undefined)).toBe("sqlite");
  });

  it("moves a stray state.json beside an existing state.db out of the way", async () => {
    await writeSqliteState(sample);
    await writeFile(
      jsonPath(),
      JSON.stringify({ changelistNumber: 0, files: {} }),
    );

    expect(resolveStateBackend(root, "json")).toBe("sqlite");

    const names = await readdir(dir());
    expect(names).not.toContain("state.json");
    expect(names.some((n) => n.startsWith("state.json.stray-"))).toBe(true);
  });

  it("imports a workspace still on state.json even when json is configured", async () => {
    // JSON stopped being a backend; such a workspace moves to state.db.
    await writeFile(jsonPath(), JSON.stringify(sample));
    expect(resolveStateBackend(root, "json")).toBe("sqlite");
    expect((await getStateStore(root, "json").load()).changelistNumber).toBe(
      42,
    );
    expect(existsSync(dbPath())).toBe(true);
    expect(existsSync(`${jsonPath()}.bak`)).toBe(true);
  });
});

describe("state store selection", () => {
  it("reads state.db even when a caller asks for json", async () => {
    await writeSqliteState(sample);
    const state = await getStateStore(root, "json").load();
    expect(state.changelistNumber).toBe(42);
    expect(existsSync(jsonPath())).toBe(false);
  });

  it("shares one store per workspace regardless of the backend asked for", () => {
    expect(getStateStore(root, "sqlite")).toBe(getStateStore(root, "json"));
  });

  it("does not create state.json when a caller omits the backend (build executor)", async () => {
    await writeSqliteState(sample);

    // What executor.ts does: read without a backend, change one field, save.
    const latest = await getWorkspaceState(root);
    expect(latest.changelistNumber).toBe(42);
    await saveWorkspaceState(
      { localPath: root },
      {
        ...latest,
        teamSync: { ...(latest.teamSync ?? {}), lastBuiltChangelist: 42 },
      },
    );
    closeAllStateStores();

    expect(existsSync(jsonPath())).toBe(false);
    const reopened = await getStateStore(root, "sqlite").load();
    expect(reopened.teamSync?.lastBuiltChangelist).toBe(42);
    expect(Object.keys(reopened.files)).toEqual(["Content/a.uasset"]);
  });
});

describe("importing state.json into sqlite", () => {
  it("imports and keeps the original as .bak", async () => {
    await writeFile(jsonPath(), JSON.stringify(sample));

    const state = await getStateStore(root, "sqlite").load();

    expect(state.changelistNumber).toBe(42);
    expect(state.staged).toEqual(["Content/a.uasset"]);
    expect(existsSync(`${jsonPath()}.bak`)).toBe(true);
    expect(existsSync(jsonPath())).toBe(false);
  });

  it.each([
    ["cut short mid-write", '{"changelistNumber": 42, "files": {"a"'],
    ["empty", ""],
  ])(
    "refuses a state.json that is %s instead of starting empty",
    async (_name, content) => {
      await writeFile(jsonPath(), content);

      await expect(getStateStore(root, "sqlite").load()).rejects.toThrow(
        /unreadable/,
      );

      // No half-made database that later opens would take as the real state,
      // and the evidence is untouched.
      expect(existsSync(dbPath())).toBe(false);
      expect(await readFile(jsonPath(), "utf8")).toBe(content);
    },
  );

  it("retries the import once the file is fixed", async () => {
    await writeFile(jsonPath(), "{");
    await expect(getStateStore(root, "sqlite").load()).rejects.toThrow();
    closeAllStateStores();

    await writeFile(jsonPath(), JSON.stringify(sample));
    const state = await getStateStore(root, "sqlite").load();
    expect(state.changelistNumber).toBe(42);
  });
});

describe("saveWorkspaceState", () => {
  it("leaves workspace.json alone", async () => {
    const configPath = path.join(dir(), "workspace.json");
    const config = JSON.stringify(
      {
        id: "ws",
        repoId: "repo",
        domainBranchName: "main",
        activeBranches: [],
        workspaceName: "mine",
        localPath: root,
        daemonId: "d",
        teamSync: { preset: "artist", customExcludeRules: ["Binaries/**"] },
      },
      null,
      2,
    );
    await writeFile(configPath, config);

    // The daemon manager passes the daemon.json entry, which has `name`
    // rather than `workspaceName` and no teamSync settings.
    const daemonJsonEntry = {
      id: "ws",
      repoId: "repo",
      name: "mine",
      domainBranchName: "feature/x",
      localPath: root,
      daemonId: "d",
    };
    await saveWorkspaceState(daemonJsonEntry, sample, "sqlite");

    expect(await readFile(configPath, "utf8")).toBe(config);
  });
});

describe("fillMissing (daemon.json backfill)", () => {
  const defaults = {
    stateBackend: "sqlite",
    mcp: { enabled: false, port: 13011 },
    workspaces: [] as unknown[],
    logging: {
      level: "info",
      logFile: { enabled: false, maxArchivedFiles: 10 },
    },
  };

  it("adds missing keys at every depth without overriding present ones", () => {
    const config: Record<string, unknown> = {
      mcp: { enabled: true },
      workspaces: [{ id: "ws" }],
      logging: { level: "debug", logFile: { enabled: true } },
    };

    expect(fillMissing(config, defaults)).toBe(true);
    expect(config).toEqual({
      stateBackend: "sqlite",
      mcp: { enabled: true, port: 13011 },
      workspaces: [{ id: "ws" }],
      logging: {
        level: "debug",
        logFile: { enabled: true, maxArchivedFiles: 10 },
      },
    });
  });

  it("reports nothing added for a complete config", () => {
    const config = structuredClone(defaults) as Record<string, unknown>;
    expect(fillMissing(config, defaults)).toBe(false);
  });

  it("does not share default objects with the filled config", () => {
    const config: Record<string, unknown> = {};
    fillMissing(config, defaults);
    (config.mcp as { port: number }).port = 1;
    expect(defaults.mcp.port).toBe(13011);
  });
});
