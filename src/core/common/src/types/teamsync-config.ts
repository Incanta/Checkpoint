// Types for the repo-committed Team Sync config file (`.checkpoint/teamsync.yaml`).
//
// These are the RESOLVED shapes: the app server validates the YAML with the
// canonical zod schema in `src/app/src/server/team-sync/config-schema.ts`
// (which applies defaults) and serves the result via `teamSync.getConfig`.
// The daemon and desktop only ever see validated, default-applied config, so
// this file is type-only and keeps @checkpointvcs/common dependency-free.
// If you change these types, update the zod schema in the app to match.

/**
 * How a build step is run.
 *
 * `command` is the default and the engine-agnostic one: it runs whatever
 * executable the step names. The `unreal-*` types are conveniences that build
 * the invocation for you, and require the repo to have opted into Unreal
 * support via `TeamSyncConfig.unreal`.
 */
export type TeamSyncBuildStepType =
  | "command"
  | "unreal-compile"
  | "unreal-cook";

export interface TeamSyncProjectConfig {
  /** Display name for the project, shown in the client. */
  name?: string;
}

/**
 * Opt-in Unreal Engine support. Its presence is what enables the `unreal-*`
 * build step types, the Launch Editor action, version-file rewriting, and the
 * Unreal additions to the code-changelist extension set.
 *
 * Omit this block entirely for a non-Unreal repo; nothing in Team Sync requires
 * it, and no Unreal discovery runs without it.
 */
export interface TeamSyncUnrealConfig {
  /** Repo-relative path to the .uproject file. Auto-discovered when omitted. */
  uproject?: string;
  /** UBT editor target name, e.g. "MyGameEditor". Auto-discovered when omitted. */
  editorTarget?: string;
  /** Build configurations offered by the Launch Editor dropdown. */
  editorConfigurations: string[];
  /**
   * Prepend the standard UBT compile steps (UnrealHeaderTool, the editor
   * target, ShaderCompileWorker, Lightmass, CrashReportClient) to `buildSteps`.
   * Set false to keep the Unreal integration but define every step yourself.
   */
  defaultBuildSteps: boolean;
}

export interface TeamSyncCategory {
  /** Stable slug id, referenced by `requires` and workspace overrides. */
  id: string;
  name: string;
  /** Repo-relative gitignore-style globs this category covers. */
  paths: string[];
  enabledByDefault: boolean;
  /** Category ids that are transitively enabled with this one. */
  requires: string[];
  hidden: boolean;
}

export interface TeamSyncPreset {
  name: string;
  /** Applied to new workspaces when no preset was chosen. */
  default: boolean;
  /** Locked presets cannot be modified per-workspace. */
  locked: boolean;
  /** Category id -> enabled override. */
  categories: Record<string, boolean>;
  /** Build step id -> enabled override. */
  buildSteps: Record<string, boolean>;
  /**
   * Linked repo name -> mode for workspaces that have not chosen one. Absent
   * on configs served by older app servers.
   */
  linkedRepos?: Record<string, TeamSyncLinkMode>;
}

/**
 * How a workspace treats one of its repo's linked repos.
 * - `follow-pin`: Team Sync syncs the linked workspace to the pinned changelist.
 * - `manual`: Team Sync only reports when the linked workspace differs from the pin.
 * - `ignore`: Team Sync leaves the link alone entirely.
 */
export type TeamSyncLinkMode = "follow-pin" | "manual" | "ignore";

/**
 * Another repo in the same org, pinned at a changelist. A workspace of this
 * repo keeps a workspace of the linked repo synced to the pin. Linking is
 * engine-agnostic: it only syncs. See docs/linked-repos-plan.md.
 */
export interface TeamSyncLinkedRepo {
  /** Repo name in the same org; also the key workspaces and presets use. */
  repo: string;
  branch: string;
  /** Exact pinned changelist. */
  changelist: number;
  /**
   * Repo-relative mount path for a nested link. Nested links are not synced
   * yet; a link with a path is reported as unsupported.
   */
  path?: string;
  /** Nested links only: create the child for workspaces with no entry. */
  enabledByDefault: boolean;
}

export interface TeamSyncBuildStepLink {
  label: string;
  url: string;
}

/** A host OS a build step can be limited to with `ifOs`. */
export type TeamSyncHostOs = "windows" | "macos" | "linux";

export interface TeamSyncBuildStep {
  /** Stable id; default steps reuse UGS's fixed GUIDs for config portability. */
  id: string;
  name: string;
  /**
   * Host OSes the step runs on; absent means every OS. Elsewhere it is
   * skipped and hidden, and steps that require it treat it as satisfied.
   * The YAML accepts one OS or a list; the resolved config always holds a list.
   */
  ifOs?: TeamSyncHostOs[];
  type: TeamSyncBuildStepType;
  /** unreal-compile: UBT target name. */
  target?: string;
  platform?: string;
  configuration?: string;
  /** Supports $(WorkspaceDir), $(Change), $(Branch), and the Unreal tokens. */
  arguments?: string;
  /** command: the executable to run. Required for `command` steps. */
  command?: string;
  workingDir?: string;
  /** Step ids that must run before this one. */
  requires: string[];
  normalSync: boolean;
  scheduledSync: boolean;
  estimatedDurationSec?: number;
  link?: TeamSyncBuildStepLink;
}

export interface TeamSyncArtifactChannel {
  /** ArtifactSet type, e.g. "editor", "game-win64". */
  type: string;
  name?: string;
  /** Badge names that must all be SUCCESS at a CL before its artifacts are used. */
  requiredBadges: string[];
}

export interface TeamSyncBadgeColumn {
  /** Matches BuildBadge.name. */
  name: string;
  group?: string;
  /** URL template; supports $(Change) expansion. */
  link?: string;
}

export interface TeamSyncContentBadge {
  name: string;
  paths: string[];
}

export interface TeamSyncTool {
  id: string;
  name: string;
  description?: string;
  /** Repo path or URL the tool is fetched from. */
  path?: string;
  installCommand?: string;
  uninstallCommand?: string;
}

export type TeamSyncNotificationEvent =
  | "badge-failure"
  | "badge-recovered"
  | "investigation-started"
  | "investigation-resolved";

export interface TeamSyncNotificationChannel {
  type: "slack-webhook" | "generic-webhook";
  url: string;
  events: TeamSyncNotificationEvent[];
}

export interface TeamSyncConfig {
  version: 1;
  project?: TeamSyncProjectConfig;
  /** Opt in to built-in Unreal Engine support. Absent means engine-agnostic. */
  unreal?: TeamSyncUnrealConfig;
  /**
   * Replaces the default code-CL classification extension set. When omitted,
   * the default is a general-purpose source-file list, plus the Unreal-specific
   * extensions when `unreal` is configured.
   */
  codeExtensions?: string[];
  syncCategories: TeamSyncCategory[];
  presets: TeamSyncPreset[];
  /** Repos this repo pins; absent on configs served by older app servers. */
  linkedRepos?: TeamSyncLinkedRepo[];
  buildSteps: TeamSyncBuildStep[];
  artifacts: TeamSyncArtifactChannel[];
  badges?: { columns: TeamSyncBadgeColumn[] };
  contentBadges: TeamSyncContentBadge[];
  tools: TeamSyncTool[];
  forceClean: { changelists: number[] };
  notifications?: { channels: TeamSyncNotificationChannel[] };
}

export type BuildBadgeStateName =
  | "STARTING"
  | "FAILURE"
  | "WARNING"
  | "SUCCESS"
  | "SKIPPED";

export type ChangelistVerdict = "good" | "bad" | "mixed" | null;

export interface TeamSyncChangelistReviewSummary {
  verdict: ChangelistVerdict;
  goodVotes: number;
  badVotes: number;
  compileSuccesses: number;
  compileFailures: number;
  myReview: {
    vote: string | null;
    starred: boolean;
    investigating: boolean;
  } | null;
  starCount: number;
  investigators: {
    userId: string;
    name: string | null;
    username: string | null;
  }[];
  commentCount: number;
  lastComment: {
    authorName: string | null;
    body: string;
    createdAt: Date;
  } | null;
}

export interface TeamSyncChangelistMeta {
  badges: {
    name: string;
    group: string | null;
    state: BuildBadgeStateName;
    url: string | null;
    updatedAt: Date;
  }[];
  reviews: TeamSyncChangelistReviewSummary;
  syncedUsers: {
    userId: string;
    name: string | null;
    username: string | null;
    workspaceName: string;
  }[];
  artifactTypes: string[];
  hasCodeChanges: boolean;
  hasContentChanges: boolean;
}

/** Result of the app server's `teamSync.getChangelistMeta` (keyed by CL number). */
export type TeamSyncChangelistMetaResult = Record<
  string,
  TeamSyncChangelistMeta
>;

/** Result shape of the app server's `teamSync.getConfig`. */
export interface TeamSyncConfigResult {
  /** Parsed and validated config, or null if the file is absent or invalid. */
  config: TeamSyncConfig | null;
  /** Changelist that last touched the config file, or null if absent. */
  sourceChangelistNumber: number | null;
  /** Validation issues when the file exists but is invalid. */
  errors: string[] | null;
}

/** Repo path of the Team Sync config file. */
export const TEAM_SYNC_CONFIG_PATH = ".checkpoint/teamsync.yaml";
