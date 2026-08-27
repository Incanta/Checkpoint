/**
 * Discovered information about the Unreal project(s) in a workspace and the
 * engine that should be used to open them.
 */
export interface UnrealProjectInfo {
  /** Repo-relative forward-slash path to the selected .uproject. */
  uprojectPath: string;
  /** Basename of the selected .uproject without its extension. */
  projectName: string;
  /** All discovered .uproject repo-relative paths. */
  allProjects: string[];
  /** Resolved engine, or null when none could be located. */
  engine: EngineInfo | null;
  /** e.g. "MyGameEditor", or "UnrealEditor" for engine-only workspaces. */
  editorTargetName: string | null;
}

export interface EngineInfo {
  kind: "workspace" | "installed" | "registered";
  /** Absolute local path to the engine root (the dir containing Engine/). */
  engineDir: string;
  /** EngineAssociation value from the .uproject, if any. */
  association: string | null;
  /** e.g. "5.4" when known. */
  version: string | null;
}

export interface EditorLaunchInfo {
  /** Absolute path to the editor executable. */
  editorExe: string;
  args: string[];
  cwd: string;
}
