/**
 * Build variable expansion. Build step arguments, commands, and working
 * directories can reference `$(Token)` names, which are expanded against a
 * per-build context before the command runs. The syntax follows
 * UnrealGameSync's so a UGS build-step config ports over unchanged.
 *
 * Two tiers of token exist. The workspace tokens always resolve, whatever the
 * repo holds. The Unreal tokens resolve only when the repo opted into Unreal
 * support and its project/engine were found; otherwise they are left in the
 * string untouched and reported via `onUnresolved`, so the build log can say
 * why rather than silently running a command containing a literal
 * "$(EditorExe)".
 */

/** Values available to every build, whatever the repo contains. */
export interface WorkspaceVariables {
  /** Workspace root on disk. */
  workspaceDir: string;
  /** Changelist the workspace is currently synced to. */
  change: number;
  /** Branch the workspace is on. */
  branch: string;
  /** Workspace name (UGS "ClientName" analogue). */
  workspaceName: string;
  /** Host platform name ("Win64" | "Mac" | "Linux"). */
  platformName: string;
}

/** Values that exist only for a workspace with Unreal support configured. */
export interface UnrealVariables {
  /** Directory containing the selected .uproject. */
  projectDir: string;
  /** Absolute path to the selected .uproject. */
  projectFile: string;
  /** Engine root (the directory containing Engine/). */
  engineDir: string;
  /** Absolute path to the editor executable. */
  editorExe: string;
  /** UBT editor target name (e.g. "MyGameEditor"). */
  editorTarget: string;
}

export interface BuildVariableContext extends WorkspaceVariables {
  /** Absent unless the repo configured Unreal and its project resolved. */
  unreal?: UnrealVariables;
}

/**
 * Token names that only resolve with Unreal support configured. Exported so
 * callers can explain an unresolved token instead of just reporting a command
 * that failed to start.
 */
export const UNREAL_VARIABLE_NAMES = [
  "projectdir",
  "projectfile",
  "enginedir",
  "editorexe",
  "editortarget",
] as const;

/**
 * Expand `$(Token)` references in `input` using `ctx`. Token names are matched
 * case-insensitively. Unknown tokens are left intact so unrelated shell
 * constructs are not mangled; `onUnresolved` is called once per occurrence with
 * the token as written.
 */
export function expandVariables(
  input: string,
  ctx: BuildVariableContext,
  onUnresolved?: (token: string) => void,
): string {
  const values: Record<string, string> = {
    workspacedir: ctx.workspaceDir,
    change: String(ctx.change),
    branch: ctx.branch,
    workspacename: ctx.workspaceName,
    platformname: ctx.platformName,

    // UGS-parity aliases, so a ported build-step config keeps working.
    branchdir: ctx.workspaceDir,
    clientname: ctx.workspaceName,

    ...(ctx.unreal && {
      projectdir: ctx.unreal.projectDir,
      projectfile: ctx.unreal.projectFile,
      enginedir: ctx.unreal.engineDir,
      editorexe: ctx.unreal.editorExe,
      editortarget: ctx.unreal.editorTarget,
    }),
  };

  return input.replace(/\$\(([A-Za-z]+)\)/g, (match, name: string) => {
    const key = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return values[key]!;
    }
    onUnresolved?.(match);
    return match;
  });
}

/** True when `token` (as written, e.g. "$(EditorExe)") is an Unreal-only one. */
export function isUnrealVariable(token: string): boolean {
  const name = token.replace(/^\$\(/, "").replace(/\)$/, "").toLowerCase();
  return (UNREAL_VARIABLE_NAMES as readonly string[]).includes(name);
}

/** Return the UBT host platform name for the current process. */
export function hostPlatformName(): "Win64" | "Mac" | "Linux" {
  switch (process.platform) {
    case "darwin":
      return "Mac";
    case "linux":
      return "Linux";
    case "win32":
    default:
      return "Win64";
  }
}
