import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Workspace, WorkspaceState } from "../util.js";
import type { EditorLaunchInfo, EngineInfo } from "./types.js";

const execFileAsync = promisify(execFile);

/** Match a GUID with optional braces (32-38 hex/dash chars). */
const GUID_RE = /^\{?[0-9A-Fa-f-]{32,38}\}?$/;

/**
 * Try to read "MajorVersion.MinorVersion" out of an Engine/Build/Build.version
 * JSON file. Returns null when the file is absent or unreadable.
 */
async function readBuildVersion(engineDir: string): Promise<string | null> {
  try {
    const abs = path.join(engineDir, "Engine", "Build", "Build.version");
    const raw = await fs.readFile(abs, "utf-8");
    const parsed = JSON.parse(raw) as {
      MajorVersion?: unknown;
      MinorVersion?: unknown;
    };
    if (
      typeof parsed.MajorVersion === "number" &&
      typeof parsed.MinorVersion === "number"
    ) {
      return `${parsed.MajorVersion}.${parsed.MinorVersion}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when a path exists on disk. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `reg` with arguments passed straight to it, never through a shell. The
 * association comes from a committed .uproject, so it must never be able to
 * become part of a command line.
 */
async function regQuery(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("reg", ["query", ...args], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * The key an association is compared by. UE treats engine identifiers
 * without regard to case, and writes GUIDs both with and without braces, so
 * a GUID compares without them.
 */
export function associationKey(association: string): string {
  const trimmed = association.trim();
  const bare = GUID_RE.test(trimmed) ? trimmed.replace(/[{}]/g, "") : trimmed;
  return bare.toLowerCase();
}

/**
 * Whether an association is something UE could have registered: a GUID or
 * a name a team chose (like "StudioEngine"). Rules out empty values, control
 * characters, and path separators.
 */
export function isRegistrableAssociation(association: string): boolean {
  const trimmed = association.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 260 &&
    !/[\u0000-\u001f\\/]/.test(trimmed)
  );
}

/**
 * Parses `reg query "HKCU\Software\Epic Games\Unreal Engine\Builds"` output
 * into identifier -> engine directory. Each value line is the name, its type,
 * and its data, separated by runs of four spaces; names can hold spaces.
 */
export function parseBuildsRegOutput(stdout: string): Map<string, string> {
  const builds = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s{4}(.+?)\s{4}REG_(?:EXPAND_)?SZ\s{4}(.*)$/);
    if (!match) continue;
    const dir = match[2]!.trim();
    if (dir) builds.set(associationKey(match[1]!), dir);
  }
  return builds;
}

/**
 * Parses an Epic `Install.ini` into identifier -> engine directory, from its
 * `[Installations]` section of `identifier=path` lines.
 */
export function parseInstallIni(raw: string): Map<string, string> {
  const builds = new Map<string, string>();
  let inSection = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = trimmed.toLowerCase() === "[installations]";
      continue;
    }
    if (!inSection) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const dir = trimmed.slice(eq + 1).trim();
    if (dir) builds.set(associationKey(trimmed.slice(0, eq)), dir);
  }
  return builds;
}

/**
 * Look up a registered build (a source engine registered by
 * UnrealVersionSelector, or by hand under a name the team chose) in the
 * Windows registry (HKCU\Software\Epic Games\Unreal Engine\Builds).
 */
async function resolveRegisteredWin32(
  association: string,
): Promise<string | null> {
  const stdout = await regQuery([
    "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds",
  ]);
  if (stdout === null) return null;
  const engineDir = parseBuildsRegOutput(stdout).get(
    associationKey(association),
  );
  return engineDir && (await pathExists(engineDir)) ? engineDir : null;
}

/**
 * Look up an installed engine by version on Windows. Tries the Epic launcher
 * manifest first, then the EpicGames registry key.
 */
async function resolveInstalledWin32(
  association: string,
): Promise<{ engineDir: string; version: string } | null> {
  // 1. LauncherInstalled.dat (JSON) under %ProgramData%.
  const programData = process.env["ProgramData"] ?? "C:\\ProgramData";
  const datPath = path.join(
    programData,
    "Epic",
    "UnrealEngineLauncher",
    "LauncherInstalled.dat",
  );
  try {
    const raw = await fs.readFile(datPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      InstallationList?: Array<{
        InstallLocation?: unknown;
        AppName?: unknown;
      }>;
    };
    for (const entry of parsed.InstallationList ?? []) {
      const appName = typeof entry.AppName === "string" ? entry.AppName : "";
      const installLocation =
        typeof entry.InstallLocation === "string" ? entry.InstallLocation : "";
      if (!appName.startsWith("UE_") || !installLocation) {
        continue;
      }
      const appVersion = appName.slice("UE_".length);
      if (association && appVersion !== association) {
        continue;
      }
      if (await pathExists(installLocation)) {
        return { engineDir: installLocation, version: appVersion };
      }
    }
  } catch {
    // No launcher manifest; fall through to the registry.
  }

  // 2. HKLM registry key keyed by version.
  if (association && isRegistrableAssociation(association)) {
    const stdout = await regQuery([
      `HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${association.trim()}`,
      "/v",
      "InstalledDirectory",
    ]);
    if (stdout !== null) {
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.match(/REG_SZ\s+(.+)$/);
        if (match) {
          const engineDir = match[1].trim();
          if (await pathExists(engineDir)) {
            return { engineDir, version: association };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Registered-build lookup on macOS/Linux via the Epic Install.ini file, whose
 * [Installations] section holds `identifier=path` lines (a GUID, or a name
 * the team chose).
 */
async function resolveRegisteredUnix(
  association: string,
): Promise<string | null> {
  const home = os.homedir();
  const key = associationKey(association);
  const candidates = [
    path.join(
      home,
      "Library",
      "Application Support",
      "Epic",
      "UnrealEngine",
      "Install.ini",
    ),
    path.join(home, ".config", "Epic", "UnrealEngine", "Install.ini"),
  ];

  for (const iniPath of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(iniPath, "utf-8");
    } catch {
      continue;
    }

    const engineDir = parseInstallIni(raw).get(key);
    if (engineDir && (await pathExists(engineDir))) {
      return engineDir;
    }
  }

  return null;
}

/** A registered build for the association on this platform, or null. */
async function resolveRegistered(association: string): Promise<string | null> {
  if (process.platform === "win32") return resolveRegisteredWin32(association);
  if (process.platform === "darwin" || process.platform === "linux") {
    return resolveRegisteredUnix(association);
  }
  return null;
}

/**
 * Resolve the engine to use for a workspace given its EngineAssociation.
 *
 * Resolution order:
 *  a. In-workspace engine (Engine/Build/Build.version in state or on disk).
 *  b. Registered build (Windows registry / Unix Install.ini), for a GUID or a
 *     name the team chose and registered (like "StudioEngine"). A GUID that
 *     is not registered resolves to nothing; a name falls through to c, since
 *     a launcher version like "5.4" can also be registered by hand.
 *  c. Version or empty association -> installed engine (launcher / registry).
 *  d. Returns null when nothing resolves.
 */
export async function resolveEngine(
  workspace: Workspace,
  state: WorkspaceState,
  association: string | null,
): Promise<EngineInfo | null> {
  // a. In-workspace engine.
  const hasEngineInState =
    Object.prototype.hasOwnProperty.call(
      state.files,
      "Engine/Build/Build.version",
    ) || (state.staged ?? []).includes("Engine/Build/Build.version");
  const engineOnDisk = await pathExists(
    path.join(workspace.localPath, "Engine", "Build", "Build.version"),
  );
  if (hasEngineInState || engineOnDisk) {
    return {
      kind: "workspace",
      engineDir: workspace.localPath,
      association,
      version: await readBuildVersion(workspace.localPath),
    };
  }

  const assoc = (association ?? "").trim();

  // b. Registered build, by GUID or by name.
  if (assoc && isRegistrableAssociation(assoc)) {
    const engineDir = await resolveRegistered(assoc);
    if (engineDir) {
      return {
        kind: "registered",
        engineDir,
        association,
        version: await readBuildVersion(engineDir),
      };
    }
    if (GUID_RE.test(assoc)) return null;
  }

  // c. Version string or empty association -> installed engine.
  if (process.platform === "win32") {
    const installed = await resolveInstalledWin32(assoc);
    if (installed) {
      return {
        kind: "installed",
        engineDir: installed.engineDir,
        association,
        version: installed.version,
      };
    }
  }

  // d. Nothing resolved.
  return null;
}

/**
 * Return the absolute path to the editor executable for the host platform.
 * This is the conventional fallback path; receipt-based resolution happens
 * later in the build engine.
 */
export function getEditorExePath(
  engine: EngineInfo,
  editorConfiguration: string | undefined,
): string {
  const binaries = path.join(engine.engineDir, "Engine", "Binaries");
  switch (process.platform) {
    case "darwin":
      return path.join(
        binaries,
        "Mac",
        "UnrealEditor.app",
        "Contents",
        "MacOS",
        "UnrealEditor",
      );
    case "linux":
      return path.join(binaries, "Linux", "UnrealEditor");
    case "win32":
    default: {
      const exe =
        editorConfiguration === "DebugGame"
          ? "UnrealEditor-Win64-DebugGame.exe"
          : "UnrealEditor.exe";
      return path.join(binaries, "Win64", exe);
    }
  }
}

/**
 * Compose the editor launch descriptor: the executable, the argument list
 * (the absolute uproject path when provided), and the working directory (the
 * engine binaries dir).
 */
export function getLaunchInfo(
  workspace: Workspace,
  engine: EngineInfo,
  uprojectRelPath: string | null,
  editorConfiguration: string | undefined,
): EditorLaunchInfo {
  const editorExe = getEditorExePath(engine, editorConfiguration);
  const args = uprojectRelPath
    ? [path.join(workspace.localPath, uprojectRelPath)]
    : [];
  return {
    editorExe,
    args,
    cwd: path.dirname(editorExe),
  };
}
