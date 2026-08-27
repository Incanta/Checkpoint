import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { exec, type Workspace, type WorkspaceState } from "../util.js";
import type { EditorLaunchInfo, EngineInfo } from "./types.js";

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
 * Look up a GUID-associated build in the Windows registry
 * (HKCU\Software\Epic Games\Unreal Engine\Builds).
 */
async function resolveRegisteredWin32(guid: string): Promise<string | null> {
  const value = guid.replace(/[{}]/g, "");
  const command = `reg query "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds" /v ${value}`;
  const { stdout, code } = await exec(command);
  if (code !== 0) {
    return null;
  }

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/REG_SZ\s+(.+)$/);
    if (match) {
      const engineDir = match[1].trim();
      if (await pathExists(engineDir)) {
        return engineDir;
      }
    }
  }
  return null;
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
  if (association) {
    const command = `reg query "HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${association}" /v InstalledDirectory`;
    const { stdout, code } = await exec(command);
    if (code === 0) {
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
 * Best-effort GUID lookup on macOS/Linux via the Epic Install.ini file.
 * The [Installations] section holds `GUID=path` lines.
 */
async function resolveRegisteredUnix(guid: string): Promise<string | null> {
  const home = os.homedir();
  const value = guid.replace(/[{}]/g, "").toLowerCase();
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

    let inSection = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        inSection = trimmed.toLowerCase() === "[installations]";
        continue;
      }
      if (!inSection) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const key = trimmed.slice(0, eq).replace(/[{}]/g, "").toLowerCase();
      const val = trimmed.slice(eq + 1).trim();
      if (key === value && (await pathExists(val))) {
        return val;
      }
    }
  }

  return null;
}

/**
 * Resolve the engine to use for a workspace given its EngineAssociation.
 *
 * Resolution order:
 *  a. In-workspace engine (Engine/Build/Build.version in state or on disk).
 *  b. GUID association -> registered build (Windows registry / Unix Install.ini).
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
    ) || (state.markedForAdd ?? []).includes("Engine/Build/Build.version");
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

  const assoc = association ?? "";

  // b. GUID association -> registered build.
  if (assoc && GUID_RE.test(assoc)) {
    if (process.platform === "win32") {
      const engineDir = await resolveRegisteredWin32(assoc);
      if (engineDir) {
        return {
          kind: "registered",
          engineDir,
          association,
          version: await readBuildVersion(engineDir),
        };
      }
    } else if (process.platform === "darwin" || process.platform === "linux") {
      const engineDir = await resolveRegisteredUnix(assoc);
      if (engineDir) {
        return {
          kind: "registered",
          engineDir,
          association,
          version: await readBuildVersion(engineDir),
        };
      }
    }
    return null;
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
