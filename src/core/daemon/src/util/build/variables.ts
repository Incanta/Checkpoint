/**
 * UnrealGameSync-style build variable expansion. Build step arguments and
 * commands can reference tokens like `$(EditorExe)` or `$(Change)`; these are
 * expanded against a per-build context before the command is run.
 */

export interface BuildVariableContext {
  /** Workspace root (the branch root on disk). */
  branchDir: string;
  /** Directory containing the selected .uproject. */
  projectDir: string;
  /** Absolute path to the selected .uproject. */
  projectFile: string;
  /** Engine root (the directory containing Engine/). */
  engineDir: string;
  /** Absolute path to the editor executable. */
  editorExe: string;
  /** Changelist the workspace is currently synced to. */
  change: number;
  /** Workspace name (UGS "ClientName" analogue). */
  clientName: string;
  /** Host platform name ("Win64" | "Mac" | "Linux"). */
  platformName: string;
  /** UBT editor target name (e.g. "MyGameEditor"). */
  editorTarget: string;
}

/**
 * Expand `$(Token)` references in `input` using `ctx`. Token names are matched
 * case-insensitively. Unknown tokens are left intact so that unrelated shell
 * constructs are not mangled.
 */
export function expandVariables(input: string, ctx: BuildVariableContext): string {
  const values: Record<string, string> = {
    branchdir: ctx.branchDir,
    projectdir: ctx.projectDir,
    projectfile: ctx.projectFile,
    enginedir: ctx.engineDir,
    editorexe: ctx.editorExe,
    change: String(ctx.change),
    clientname: ctx.clientName,
    platformname: ctx.platformName,
    editortarget: ctx.editorTarget,
  };

  return input.replace(/\$\(([A-Za-z]+)\)/g, (match, name: string) => {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, key)
      ? values[key]!
      : match;
  });
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
