// Types for the repo-committed Game Sync config file (`.checkpoint/gamesync.yaml`).
//
// These are the RESOLVED shapes: the app server validates the YAML with the
// canonical zod schema in `src/app/src/server/game-sync/config-schema.ts`
// (which applies defaults) and serves the result via `gameSync.getConfig`.
// The daemon and desktop only ever see validated, default-applied config, so
// this file is type-only and keeps @checkpointvcs/common dependency-free.
// If you change these types, update the zod schema in the app to match.

export type GameSyncBuildStepType = "compile" | "cook" | "other";

export interface GameSyncProjectConfig {
  name?: string;
  /** Repo-relative path to the .uproject file. */
  uproject?: string;
  /** UBT editor target name, e.g. "MyGameEditor". */
  editorTarget?: string;
  /** Build configurations offered by the Launch Editor dropdown. */
  editorConfigurations: string[];
}

export interface GameSyncCategory {
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

export interface GameSyncPreset {
  name: string;
  /** Applied to new workspaces when no preset was chosen. */
  default: boolean;
  /** Locked presets cannot be modified per-workspace. */
  locked: boolean;
  /** Category id -> enabled override. */
  categories: Record<string, boolean>;
  /** Build step id -> enabled override. */
  buildSteps: Record<string, boolean>;
}

export interface GameSyncBuildStepLink {
  label: string;
  url: string;
}

export interface GameSyncBuildStep {
  /** Stable id; default steps reuse UGS's fixed GUIDs for config portability. */
  id: string;
  name: string;
  type: GameSyncBuildStepType;
  /** compile: UBT target name. */
  target?: string;
  platform?: string;
  configuration?: string;
  /** Supports $(EditorExe), $(BranchDir), $(ProjectDir), $(Change), ... */
  arguments?: string;
  /** other: executable to run. */
  command?: string;
  workingDir?: string;
  /** Step ids that must run before this one. */
  requires: string[];
  normalSync: boolean;
  scheduledSync: boolean;
  estimatedDurationSec?: number;
  link?: GameSyncBuildStepLink;
}

export interface GameSyncArtifactChannel {
  /** ArtifactSet type, e.g. "editor", "game-win64". */
  type: string;
  name?: string;
  /** Badge names that must all be SUCCESS at a CL before its artifacts are used. */
  requiredBadges: string[];
}

export interface GameSyncBadgeColumn {
  /** Matches BuildBadge.name. */
  name: string;
  group?: string;
  /** URL template; supports $(Change) expansion. */
  link?: string;
}

export interface GameSyncContentBadge {
  name: string;
  paths: string[];
}

export interface GameSyncTool {
  id: string;
  name: string;
  description?: string;
  /** Repo path or URL the tool is fetched from. */
  path?: string;
  installCommand?: string;
  uninstallCommand?: string;
}

export type GameSyncNotificationEvent =
  | "badge-failure"
  | "badge-recovered"
  | "investigation-started"
  | "investigation-resolved";

export interface GameSyncNotificationChannel {
  type: "slack-webhook" | "generic-webhook";
  url: string;
  events: GameSyncNotificationEvent[];
}

export interface GameSyncConfig {
  version: 1;
  project?: GameSyncProjectConfig;
  /** Overrides the default code-CL classification extension set. */
  codeExtensions?: string[];
  syncCategories: GameSyncCategory[];
  presets: GameSyncPreset[];
  buildSteps: GameSyncBuildStep[];
  artifacts: GameSyncArtifactChannel[];
  badges?: { columns: GameSyncBadgeColumn[] };
  contentBadges: GameSyncContentBadge[];
  tools: GameSyncTool[];
  forceClean: { changelists: number[] };
  notifications?: { channels: GameSyncNotificationChannel[] };
}

export type BuildBadgeStateName =
  | "STARTING"
  | "FAILURE"
  | "WARNING"
  | "SUCCESS"
  | "SKIPPED";

export type ChangelistVerdict = "good" | "bad" | "mixed" | null;

export interface GameSyncChangelistReviewSummary {
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

export interface GameSyncChangelistMeta {
  badges: {
    name: string;
    group: string | null;
    state: BuildBadgeStateName;
    url: string | null;
    updatedAt: Date;
  }[];
  reviews: GameSyncChangelistReviewSummary;
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

/** Result of the app server's `gameSync.getChangelistMeta` (keyed by CL number). */
export type GameSyncChangelistMetaResult = Record<
  string,
  GameSyncChangelistMeta
>;

/** Result shape of the app server's `gameSync.getConfig`. */
export interface GameSyncConfigResult {
  /** Parsed and validated config, or null if the file is absent or invalid. */
  config: GameSyncConfig | null;
  /** Changelist that last touched the config file, or null if absent. */
  sourceChangelistNumber: number | null;
  /** Validation issues when the file exists but is invalid. */
  errors: string[] | null;
}

/** Repo path of the Game Sync config file. */
export const GAME_SYNC_CONFIG_PATH = ".checkpoint/gamesync.yaml";
