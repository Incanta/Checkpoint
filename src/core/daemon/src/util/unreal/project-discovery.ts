import path from "path";
import { promises as fs } from "fs";
import type { Workspace, WorkspaceState } from "../util.js";

/**
 * Count the number of path segments in a repo-relative forward-slash path.
 * Used to sort discovered projects shallowest-first.
 */
function pathDepth(relPath: string): number {
  return relPath.split("/").filter((p) => p.length > 0).length;
}

/**
 * Discover all .uproject files known to the workspace state (both tracked
 * files and files marked for add). Returns repo-relative forward-slash paths,
 * deduped and sorted by depth (shallowest first) then alphabetically.
 */
export async function discoverProjects(
  workspace: Workspace,
  state: WorkspaceState,
): Promise<string[]> {
  const candidates = [
    ...Object.keys(state.files),
    ...(state.markedForAdd ?? []),
  ];

  const uprojects = new Set<string>();
  for (const rel of candidates) {
    if (rel.toLowerCase().endsWith(".uproject")) {
      uprojects.add(rel);
    }
  }

  return Array.from(uprojects).sort((a, b) => {
    const depthDiff = pathDepth(a) - pathDepth(b);
    if (depthDiff !== 0) {
      return depthDiff;
    }
    return a.localeCompare(b);
  });
}

/**
 * Choose which project to use out of the discovered list. Honors an explicit
 * selection when present in the list; otherwise picks the single entry or the
 * first (shallowest) one. Returns null when the list is empty.
 */
export function selectProject(
  projects: string[],
  selectedProject: string | undefined,
): string | null {
  if (projects.length === 0) {
    return null;
  }

  if (selectedProject && projects.includes(selectedProject)) {
    return selectedProject;
  }

  return projects[0];
}

/**
 * Read the EngineAssociation string out of a .uproject on disk. The file may
 * not be present locally if it has not been synced; any error yields null.
 * The value may be "", a version like "5.4", or a "{GUID}".
 */
export async function readEngineAssociation(
  workspace: Workspace,
  uprojectRelPath: string,
): Promise<string | null> {
  try {
    const abs = path.join(workspace.localPath, uprojectRelPath);
    const raw = await fs.readFile(abs, "utf-8");
    const parsed = JSON.parse(raw) as { EngineAssociation?: unknown };
    if (typeof parsed.EngineAssociation === "string") {
      return parsed.EngineAssociation;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Determine the editor target name for a project.
 *
 * Preference order:
 *  1. A `<Name>Editor.Target.cs` under the project's Source dir -> `<Name>Editor`.
 *  2. If Source/ exists with some `.Target.cs` but no `*Editor.Target.cs`,
 *     read each on-disk `.Target.cs` and match `Type = TargetType.Editor` to
 *     find the editor target class (class name = filename without `.Target.cs`).
 *  3. Content-only project (no Source dir) -> null.
 *  4. Engine-in-workspace (Engine/Build/Build.version present) with no project
 *     target found -> "UnrealEditor".
 */
export async function findEditorTargetName(
  workspace: Workspace,
  state: WorkspaceState,
  uprojectRelPath: string,
): Promise<string | null> {
  const projectDir = path.posix.dirname(uprojectRelPath);
  const sourcePrefix = projectDir === "." ? "Source/" : `${projectDir}/Source/`;

  const stateKeys = [
    ...Object.keys(state.files),
    ...(state.markedForAdd ?? []),
  ];

  const targetFiles: string[] = [];
  let hasSourceDir = false;
  for (const key of stateKeys) {
    if (key.startsWith(sourcePrefix)) {
      hasSourceDir = true;
      if (key.endsWith(".Target.cs")) {
        targetFiles.push(key);
      }
    }
  }

  // Preference 1: filename convention <Name>Editor.Target.cs.
  for (const rel of targetFiles) {
    const base = path.posix.basename(rel);
    const name = base.slice(0, base.length - ".Target.cs".length);
    if (name.endsWith("Editor")) {
      return name;
    }
  }

  // Preference 2: Source dir with .Target.cs files but no *Editor convention;
  // read each on-disk target and match the editor TargetType.
  if (hasSourceDir && targetFiles.length > 0) {
    const editorTypeRe = /Type\s*=\s*TargetType\.Editor/;
    for (const rel of targetFiles) {
      try {
        const abs = path.join(workspace.localPath, rel);
        const contents = await fs.readFile(abs, "utf-8");
        if (editorTypeRe.test(contents)) {
          const base = path.posix.basename(rel);
          return base.slice(0, base.length - ".Target.cs".length);
        }
      } catch {
        // File not synced or unreadable; keep looking.
      }
    }
  }

  // Preference 4: engine in workspace and no project target found. Applies
  // whether or not the project itself has a Source dir (content-only projects
  // still open with the engine's UnrealEditor).
  const hasEngineInWorkspace = stateKeys.some(
    (key) => key === "Engine/Build/Build.version",
  );
  if (hasEngineInWorkspace) {
    return "UnrealEditor";
  }

  return null;
}
