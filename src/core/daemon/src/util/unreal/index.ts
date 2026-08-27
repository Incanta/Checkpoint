import path from "path";
import type { Workspace, WorkspaceState } from "../util.js";
import type { UnrealProjectInfo } from "./types.js";
import {
  discoverProjects,
  findEditorTargetName,
  readEngineAssociation,
  selectProject,
} from "./project-discovery.js";
import { resolveEngine } from "./engine-discovery.js";

export interface ProjectInfoCacheEntry {
  info: UnrealProjectInfo;
  loadedAt: number;
}

/** Soft cache TTL: 5 minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** workspace.id -> cached project info. */
const cache = new Map<string, ProjectInfoCacheEntry>();

/**
 * Invalidate the cached project info for a workspace. Pull flows call this when
 * the set of files (and therefore projects/engine) may have changed.
 */
export function invalidateProjectInfo(workspaceId: string): void {
  cache.delete(workspaceId);
}

/**
 * Resolve the Unreal project/engine info for a workspace, composing project
 * discovery, engine resolution, and editor-target detection.
 *
 * Returns null when the workspace holds neither a .uproject nor an in-workspace
 * engine. Results are cached per workspace with a 5-minute soft TTL.
 */
export async function getProjectInfo(
  workspace: Workspace,
  state: WorkspaceState,
): Promise<UnrealProjectInfo | null> {
  const cached = cache.get(workspace.id);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.info;
  }

  const projects = await discoverProjects(workspace, state);
  const selected = selectProject(projects, workspace.teamSync?.selectedProject);

  const hasEngineInWorkspace =
    Object.prototype.hasOwnProperty.call(
      state.files,
      "Engine/Build/Build.version",
    ) || (state.markedForAdd ?? []).includes("Engine/Build/Build.version");

  // Nothing Unreal here.
  if (!selected && !hasEngineInWorkspace) {
    return null;
  }

  const association = selected
    ? await readEngineAssociation(workspace, selected)
    : null;
  const engine = await resolveEngine(workspace, state, association);
  const editorTargetName = selected
    ? await findEditorTargetName(workspace, state, selected)
    : hasEngineInWorkspace
      ? "UnrealEditor"
      : null;

  const info: UnrealProjectInfo = {
    uprojectPath: selected ?? "",
    projectName: selected
      ? path.posix.basename(selected).replace(/\.uproject$/i, "")
      : "",
    allProjects: projects,
    engine,
    editorTargetName,
  };

  cache.set(workspace.id, { info, loadedAt: Date.now() });
  return info;
}

export type {
  EditorLaunchInfo,
  EngineInfo,
  UnrealProjectInfo,
} from "./types.js";
export {
  discoverProjects,
  findEditorTargetName,
  readEngineAssociation,
  selectProject,
} from "./project-discovery.js";
export {
  getEditorExePath,
  getLaunchInfo,
  resolveEngine,
} from "./engine-discovery.js";
