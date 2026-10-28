/**
 * Finding a registered engine by the .uproject's EngineAssociation
 * (src/core/daemon/src/util/unreal/engine-discovery.ts). A team can commit a
 * fixed name (like "StudioEngine") and register each machine's engine folder
 * under it, instead of the random per-machine GUIDs UnrealVersionSelector
 * writes. The association comes from a committed file, so it must never
 * reach a shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** What the fake `reg` answers for the Builds key; set per test. */
const reg = vi.hoisted(() => ({
  builds: "",
  calls: [] as { file: string; args: string[]; shell: unknown }[],
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      opts: { shell?: unknown },
      cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
    ) => {
      reg.calls.push({ file, args, shell: opts?.shell });
      if (args[1] === "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds") {
        cb(null, { stdout: reg.builds, stderr: "" });
      } else {
        cb(new Error("ERROR: The system was unable to find the specified registry key or value."));
      }
    },
  };
});

import {
  associationKey,
  isRegistrableAssociation,
  parseBuildsRegOutput,
  parseInstallIni,
  resolveEngine,
} from "../../../core/daemon/src/util/unreal/engine-discovery.js";

const GUID = "2F5BFB40-6C1A-4E0B-9D8A-1A2B3C4D5E6F";

describe("associationKey", () => {
  it("ignores case, and braces around a GUID", () => {
    expect(associationKey("StudioEngine")).toBe("studioengine");
    expect(associationKey(`{${GUID}}`)).toBe(GUID.toLowerCase());
    expect(associationKey(GUID)).toBe(GUID.toLowerCase());
  });

  it("keeps braces that are part of a name", () => {
    expect(associationKey("{Studio}")).toBe("{studio}");
  });
});

describe("isRegistrableAssociation", () => {
  it.each(["StudioEngine", "UE5 Custom", GUID, `{${GUID}}`, "5.4"])(
    "accepts %s",
    (value) => expect(isRegistrableAssociation(value)).toBe(true),
  );
  it.each(["", "   ", "a\nb", "..\\..\\Evil", "a/b", "x".repeat(261)])(
    "rejects %j",
    (value) => expect(isRegistrableAssociation(value)).toBe(false),
  );
});

describe("parseBuildsRegOutput", () => {
  it("reads GUID and named builds, including names with spaces", () => {
    const out = [
      "",
      "HKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds",
      `    {${GUID}}    REG_SZ    D:/Engines/UE5-Source`,
      "    StudioEngine    REG_SZ    E:/Engines/Studio",
      "    UE5 Custom Build    REG_SZ    F:/Engines/Custom Build",
      "    Expanded    REG_EXPAND_SZ    %USERPROFILE%/Engine",
      "    Empty    REG_SZ    ",
      "",
    ].join("\r\n");
    const builds = parseBuildsRegOutput(out);
    expect(builds.get(GUID.toLowerCase())).toBe("D:/Engines/UE5-Source");
    expect(builds.get("studioengine")).toBe("E:/Engines/Studio");
    expect(builds.get("ue5 custom build")).toBe("F:/Engines/Custom Build");
    expect(builds.get("expanded")).toBe("%USERPROFILE%/Engine");
    expect(builds.has("empty")).toBe(false);
  });
});

describe("parseInstallIni", () => {
  it("reads only the [Installations] section", () => {
    const ini = [
      "[Other]",
      "StudioEngine=/wrong",
      "[Installations]",
      `{${GUID}}=/engines/source`,
      "StudioEngine = /engines/studio",
      "=/no/name",
      "Broken",
    ].join("\n");
    const builds = parseInstallIni(ini);
    expect(builds.get(GUID.toLowerCase())).toBe("/engines/source");
    expect(builds.get("studioengine")).toBe("/engines/studio");
    expect(builds.size).toBe(2);
  });
});

describe("resolveEngine with a registered association", () => {
  let root: string;
  let engineDir: string;
  let workspaceDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chk-engine-assoc-"));
    engineDir = path.join(root, "Engines", "Studio");
    workspaceDir = path.join(root, "Game");
    await mkdir(path.join(engineDir, "Engine", "Build"), { recursive: true });
    await writeFile(
      path.join(engineDir, "Engine", "Build", "Build.version"),
      JSON.stringify({ MajorVersion: 5, MinorVersion: 6 }),
    );
    await mkdir(workspaceDir, { recursive: true });
    reg.calls.length = 0;
    reg.builds = "";
    process.env.HOME = root;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  });

  /** Registers the test engine under `name` the way this platform does. */
  const register = async (name: string) => {
    reg.builds = `\r\nHKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds\r\n    ${name}    REG_SZ    ${engineDir}\r\n`;
    const iniDir = path.join(root, ".config", "Epic", "UnrealEngine");
    await mkdir(iniDir, { recursive: true });
    await writeFile(
      path.join(iniDir, "Install.ini"),
      `[Installations]\n${name}=${engineDir}\n`,
    );
  };

  const resolve = (association: string | null) =>
    resolveEngine(
      { localPath: workspaceDir } as never,
      { changelistNumber: 0, files: {} },
      association,
    );

  const supported = ["win32", "linux", "darwin"].includes(process.platform);

  it.runIf(supported)("finds an engine registered under a name the team chose", async () => {
    await register("StudioEngine");
    expect(await resolve("StudioEngine")).toEqual({
      kind: "registered",
      engineDir,
      association: "StudioEngine",
      version: "5.6",
    });
    // UE compares identifiers without case.
    expect((await resolve("studioengine"))?.engineDir).toBe(engineDir);
  });

  it.runIf(supported)("finds a GUID with or without braces", async () => {
    await register(`{${GUID}}`);
    expect((await resolve(GUID))?.engineDir).toBe(engineDir);
    expect((await resolve(`{${GUID.toLowerCase()}}`))?.engineDir).toBe(engineDir);
  });

  it.runIf(supported)("finds nothing for a name that is not registered", async () => {
    await register("StudioEngine");
    expect(await resolve("OtherEngine")).toBeNull();
  });

  it.runIf(supported)("finds nothing when the registered folder is gone", async () => {
    await register("StudioEngine");
    await rm(engineDir, { recursive: true, force: true });
    expect(await resolve("StudioEngine")).toBeNull();
  });

  it.runIf(process.platform === "win32")(
    "never hands the association to a shell",
    async () => {
      const hostile = 'x" & echo pwned > owned.txt & "';
      expect(await resolve(hostile)).toBeNull();
      expect(reg.calls.length).toBeGreaterThan(0);
      for (const call of reg.calls) {
        expect(call.file).toBe("reg");
        expect(call.shell).toBeFalsy();
      }
      // The installed-engine lookup passes it as one argument, intact.
      const installed = reg.calls.find((c) => c.args[1]?.startsWith("HKLM"));
      expect(installed?.args[1]).toBe(
        `HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${hostile}`,
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "does not query the registry for an association with path separators",
    async () => {
      await resolve("..\\..\\Microsoft");
      expect(reg.calls).toEqual([]);
    },
  );
});
