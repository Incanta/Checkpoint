import type { TeamSyncBuildStep } from "@checkpointvcs/common";

/**
 * Fixed step ids for the default build steps. These mirror UnrealGameSync's
 * built-in GUIDs so that a repo config or workspace override can target a
 * default step by id and remain portable across tools.
 */
export const DEFAULT_BUILD_STEP_IDS = {
  compileUHT: "4A0B4F5A-4A9E-4D9A-8C2B-1E7B2A9C1D01",
  compileEditor: "0FA1B2C3-D4E5-6789-ABCD-EF0123456701",
  shaderCompileWorker: "0FA1B2C3-D4E5-6789-ABCD-EF0123456702",
  unrealLightmass: "0FA1B2C3-D4E5-6789-ABCD-EF0123456703",
  crashReportClient: "0FA1B2C3-D4E5-6789-ABCD-EF0123456704",
} as const;

/**
 * The default UGS-parity build steps for an Unreal workspace. Compiles
 * UnrealHeaderTool first, then the editor target, then the editor-support
 * tools. `requires` orders the editor after UHT and the tools after the editor.
 *
 * These are Unreal-only and opt-in: they are used solely when the repo config
 * declares an `unreal` block with `defaultBuildSteps` left on. A repo that says
 * nothing about Unreal starts from an empty step list and builds exactly what
 * its own config asks for.
 */
export function getUnrealDefaultBuildSteps(
  editorTarget: string,
): TeamSyncBuildStep[] {
  return [
    {
      id: DEFAULT_BUILD_STEP_IDS.compileUHT,
      name: "Compile UnrealHeaderTool",
      type: "unreal-compile",
      target: "UnrealHeaderTool",
      requires: [],
      normalSync: true,
      scheduledSync: true,
    },
    {
      id: DEFAULT_BUILD_STEP_IDS.compileEditor,
      name: `Compile ${editorTarget}`,
      type: "unreal-compile",
      target: editorTarget,
      requires: [DEFAULT_BUILD_STEP_IDS.compileUHT],
      normalSync: true,
      scheduledSync: true,
    },
    {
      id: DEFAULT_BUILD_STEP_IDS.shaderCompileWorker,
      name: "Compile ShaderCompileWorker",
      type: "unreal-compile",
      target: "ShaderCompileWorker",
      requires: [DEFAULT_BUILD_STEP_IDS.compileEditor],
      normalSync: true,
      scheduledSync: true,
    },
    {
      id: DEFAULT_BUILD_STEP_IDS.unrealLightmass,
      name: "Compile UnrealLightmass",
      type: "unreal-compile",
      target: "UnrealLightmass",
      requires: [DEFAULT_BUILD_STEP_IDS.compileEditor],
      normalSync: true,
      scheduledSync: true,
    },
    {
      id: DEFAULT_BUILD_STEP_IDS.crashReportClient,
      name: "Compile CrashReportClient",
      type: "unreal-compile",
      target: "CrashReportClient",
      requires: [DEFAULT_BUILD_STEP_IDS.compileEditor],
      normalSync: true,
      scheduledSync: true,
    },
  ];
}

/**
 * Merge the default, repo-config, and workspace-custom build steps into a
 * single ordered list, carrying each step's enabled state.
 *
 * Merge rules: repo-config steps override defaults by id; custom steps are
 * appended (overriding by id if they reuse one). A step is enabled unless a
 * workspace override says otherwise; the default is enabled.
 */
export function mergeBuildSteps(
  defaults: TeamSyncBuildStep[],
  configSteps: TeamSyncBuildStep[],
  custom: TeamSyncBuildStep[],
  overrides: Record<string, { enabled?: boolean }> | undefined,
): { step: TeamSyncBuildStep; enabled: boolean }[] {
  const byId = new Map<string, TeamSyncBuildStep>();
  const order: string[] = [];

  const upsert = (step: TeamSyncBuildStep): void => {
    if (!byId.has(step.id)) {
      order.push(step.id);
    }
    byId.set(step.id, step);
  };

  for (const step of defaults) upsert(step);
  for (const step of configSteps) upsert(step);
  for (const step of custom) upsert(step);

  return order.map((id) => {
    const step = byId.get(id)!;
    const enabled = overrides?.[step.id]?.enabled ?? true;
    return { step, enabled };
  });
}

/**
 * Topologically sort steps so that every step's `requires` dependencies come
 * first. Requirements referencing ids not present in `steps` are ignored (they
 * were filtered out or belong to another list). Throws on a dependency cycle.
 */
export function topoSortSteps(steps: TeamSyncBuildStep[]): TeamSyncBuildStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const result: TeamSyncBuildStep[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (step: TeamSyncBuildStep): void => {
    const current = state.get(step.id);
    if (current === "done") return;
    if (current === "visiting") {
      throw new Error(
        `Build step dependency cycle detected at "${step.name}" (${step.id})`,
      );
    }

    state.set(step.id, "visiting");
    for (const requiredId of step.requires) {
      const dependency = byId.get(requiredId);
      if (dependency) {
        visit(dependency);
      }
    }
    state.set(step.id, "done");
    result.push(step);
  };

  for (const step of steps) {
    visit(step);
  }

  return result;
}
