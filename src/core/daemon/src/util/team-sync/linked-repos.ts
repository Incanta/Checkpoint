import {
  CreateApiClientAuth,
  type TeamSyncConfig,
  type TeamSyncLinkedRepo,
  type TeamSyncLinkMode,
  type TeamSyncPreset,
} from "@checkpointvcs/common";

import path from "path";

import {
  getWorkspaceConfig,
  getWorkspaceState,
  saveWorkspaceConfig,
  updateWorkspaceState,
  syncTargetBranch,
  type AppliedLinkPin,
  type LinkHolder,
  type Workspace as UtilWorkspace,
  type WorkspaceLinkedWorkspace,
  type WorkspaceTeamSyncSettings,
} from "../util.js";
import { isWorkspaceRoot } from "../../file-status.js";
import type { Workspace as ManagerWorkspace } from "../../types/workspace.js";
import { DaemonConfig } from "../../daemon-config.js";
import { Logger } from "../../logging.js";

// Linked repos: a repo's teamsync.yaml pins other repos at a changelist, and
// a workspace of it keeps a local workspace of each linked repo synced to the
// pin before syncing itself. See docs/linked-repos-plan.md.
//
// Linking only syncs. It never looks inside the linked repo, so the same
// mechanism serves an engine, an SDK, or a tools repo.

/** Where a link's effective mode came from. */
export type LinkChoiceSource = "workspace" | "preset" | "default";

export interface ResolvedLinkChoice {
  mode: TeamSyncLinkMode;
  /** The chosen local workspace; only a workspace entry can name one. */
  workspaceId?: string;
  source: LinkChoiceSource;
}

/**
 * The preset a workspace's settings select: the named one, or the repo's
 * default preset when the workspace never chose (undefined). An explicit null
 * means "Custom", which applies no preset.
 */
export function selectedPreset(
  presets: TeamSyncPreset[],
  settings: WorkspaceTeamSyncSettings | undefined,
): TeamSyncPreset | undefined {
  const name = settings?.preset;
  if (name === null) return undefined;
  if (name === undefined) return presets.find((p) => p.default);
  return presets.find((p) => p.name === name);
}

/** Case-insensitive lookup, since repo names are matched that way. */
function lookup<T>(
  record: Record<string, T> | undefined,
  repo: string,
): T | undefined {
  if (!record) return undefined;
  if (repo in record) return record[repo];
  const lower = repo.toLowerCase();
  const key = Object.keys(record).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : record[key];
}

/**
 * A workspace's effective choice for one link: its own workspace.json entry,
 * else the selected preset's mode, else the default. The default for a link
 * with no entry is `follow-pin` with no workspace, which reports as "not set
 * up"; a nested link instead follows its `enabledByDefault`.
 */
export function resolveLinkChoice(
  link: TeamSyncLinkedRepo,
  settings: WorkspaceTeamSyncSettings | undefined,
  presets: TeamSyncPreset[],
): ResolvedLinkChoice {
  const entry = lookup(settings?.linkedWorkspaces, link.repo);
  if (entry) {
    return {
      mode: entry.mode,
      ...(entry.workspaceId && { workspaceId: entry.workspaceId }),
      source: "workspace",
    };
  }

  const presetMode = lookup(
    selectedPreset(presets, settings)?.linkedRepos,
    link.repo,
  );
  if (presetMode) return { mode: presetMode, source: "preset" };

  if (link.path !== undefined && !link.enabledByDefault) {
    return { mode: "ignore", source: "default" };
  }
  return { mode: "follow-pin", source: "default" };
}

/** What a link looks like from this machine. */
export type LinkStatus =
  | "ignored"
  /**
   * A nested link (`path`) with no workspace at its folder yet. A sync
   * creates one in follow-pin mode; manual mode leaves it to the user.
   */
  | "not-created"
  /** Creating a nested link's workspace failed; see the result's `error`. */
  | "create-failed"
  /** No local workspace chosen for the link. */
  | "not-set-up"
  /** The chosen workspace is not registered with this daemon. */
  | "missing-workspace"
  /** The chosen workspace belongs to a different repo or org. */
  | "wrong-repo"
  /** The chosen workspace is on a different branch than the link. */
  | "wrong-branch"
  /** The chosen workspace has feature branches overlaid; never moved. */
  | "overlay-active"
  /**
   * Another operation is running in the chosen workspace and it needs to
   * move. Stops the parent's sync (try again), like a confirmation would.
   */
  | "busy"
  | "up-to-date"
  /** The chosen workspace is at a different changelist than the pin. */
  | "out-of-date";

/** Why moving a linked workspace needs the user's go-ahead. */
export type LinkConfirmReason =
  /** It has pending local changes. */
  | "local-changes"
  /** It is at a later changelist than the pin; syncing would downgrade it. */
  | "ahead-of-pin"
  /** Another parent workspace moved it to a different changelist. */
  | "held-by-other";

/** What the chosen workspace looks like, for {@link decideLinkSync}. */
export interface LinkedWorkspaceFacts {
  repoName: string;
  orgId: string;
  domainBranchName: string;
  activeBranches: string[];
  changelistNumber: number;
  hasLocalChanges: boolean;
  busy: boolean;
  /** The parent that last moved it, when that parent is still registered. */
  otherHolder: LinkHolder | null;
}

export type LinkDecision =
  | { action: "report"; status: LinkStatus }
  | { action: "sync" }
  /** Create the nested link's workspace at its folder, then sync it. */
  | { action: "create" }
  | { action: "confirm"; reasons: LinkConfirmReason[] };

/**
 * Decides what a sync of the parent does with one link. Pure, so the rules
 * are testable without workspaces.
 *
 * Situations the user can consent to (`confirm`) and a busy linked workspace
 * block the parent's sync. Configuration problems (no workspace chosen, the
 * wrong repo) are reported and leave the parent free to sync, as the plan
 * requires: a link that is not set up is never an error.
 *
 * `linked` is the chosen workspace for a link that can live anywhere, and the
 * workspace at the link's folder for a nested one: null when there is none,
 * "missing" when one is chosen (or a folder holds one) that this daemon
 * doesn't have registered.
 */
export function decideLinkSync(
  link: TeamSyncLinkedRepo,
  choice: ResolvedLinkChoice,
  parentOrgId: string,
  linked: LinkedWorkspaceFacts | null | "missing",
  confirmed: boolean,
): LinkDecision {
  if (choice.mode === "ignore") return { action: "report", status: "ignored" };
  if (link.path !== undefined) {
    // A nested link's workspace is wherever its folder is; nothing to pick.
    if (linked === null) {
      return choice.mode === "follow-pin"
        ? { action: "create" }
        : { action: "report", status: "not-created" };
    }
  } else if (!choice.workspaceId) {
    return { action: "report", status: "not-set-up" };
  }
  if (linked === null || linked === "missing") {
    return { action: "report", status: "missing-workspace" };
  }
  if (
    linked.repoName.toLowerCase() !== link.repo.toLowerCase() ||
    linked.orgId !== parentOrgId
  ) {
    return { action: "report", status: "wrong-repo" };
  }
  if (linked.domainBranchName !== link.branch) {
    return { action: "report", status: "wrong-branch" };
  }
  if (linked.activeBranches.length > 0) {
    return { action: "report", status: "overlay-active" };
  }

  const atPin = linked.changelistNumber === link.changelist;
  if (atPin) return { action: "report", status: "up-to-date" };
  if (choice.mode === "manual")
    return { action: "report", status: "out-of-date" };
  if (linked.busy) return { action: "report", status: "busy" };

  const reasons: LinkConfirmReason[] = [];
  if (linked.hasLocalChanges) reasons.push("local-changes");
  if (linked.changelistNumber > link.changelist) reasons.push("ahead-of-pin");
  if (linked.otherHolder) reasons.push("held-by-other");
  if (reasons.length > 0 && !confirmed) return { action: "confirm", reasons };
  return { action: "sync" };
}

/** One link's outcome from a parent sync. */
export interface LinkSyncResult {
  repo: string;
  branch: string;
  pin: number;
  mode: TeamSyncLinkMode;
  source: LinkChoiceSource;
  status: LinkStatus | "synced" | "needs-confirmation";
  workspaceId?: string;
  workspaceName?: string;
  localPath?: string;
  /** The linked workspace's changelist before this sync. */
  fromChangelist?: number;
  /** Set when status is "needs-confirmation". */
  reasons?: LinkConfirmReason[];
  /** Set with "held-by-other": the parent that last moved it. */
  holder?: LinkHolder;
  /** A nested link's folder, relative to the parent workspace. */
  path?: string;
  /** Set with "create-failed": why. */
  error?: string;
  /** Set when this sync created the nested link's workspace. */
  created?: boolean;
}

/** Thrown when a link needs the user's go-ahead; the parent was not synced. */
export class LinkConfirmationRequiredError extends Error {
  constructor(public readonly links: LinkSyncResult[]) {
    super(describeConfirmations(links));
    this.name = "LinkConfirmationRequiredError";
  }
}

const REASON_TEXT: Record<LinkConfirmReason, string> = {
  "local-changes": "it has local changes",
  "ahead-of-pin": "it is ahead of the pin, so this would move it back",
  "held-by-other": "another workspace moved it to a different changelist",
};

function describeConfirmations(links: LinkSyncResult[]): string {
  const lines = links.map((l) => {
    const where = l.workspaceName ? ` (${l.workspaceName})` : "";
    const holder =
      l.holder && l.reasons?.includes("held-by-other")
        ? `; ${l.holder.workspaceName} is on changelist ${l.holder.changelist}`
        : "";
    const why = (l.reasons ?? []).map((r) => REASON_TEXT[r]).join(", ");
    return `${l.repo}${where}: moving it from changelist ${l.fromChangelist} to ${l.pin} needs confirmation because ${why}${holder}`;
  });
  return `Did not sync: linked repos need confirmation first.\n${lines.join("\n")}`;
}

/** What the orchestration needs from the daemon manager. */
export interface LinkedSyncDeps {
  /**
   * The workspace with this id. These lookups register a workspace found on
   * disk when the daemon is an ephemeral one (a daemonless CLI), which
   * starts out knowing only the workspace it runs for.
   */
  findWorkspace(workspaceId: string): Promise<ManagerWorkspace | undefined>;
  isBusy(workspaceId: string): boolean;
  hasLocalChanges(workspace: ManagerWorkspace): Promise<boolean>;
  /** Syncs a linked workspace to a changelist through the sync pipeline. */
  syncWorkspace(workspace: ManagerWorkspace, changelist: number): Promise<void>;
  /** The registered workspace whose folder is `localPath`, if any. */
  findWorkspaceAt(localPath: string): Promise<ManagerWorkspace | undefined>;
  /**
   * Creates and registers a workspace of `repo` (by name, in the org) on
   * `branch` at `localPath`, for a nested link.
   */
  createWorkspace(input: {
    daemonId: string;
    orgId: string;
    repo: string;
    branch: string;
    localPath: string;
    name: string;
  }): Promise<ManagerWorkspace>;
  /** Re-reads which folders of the parent belong to nested workspaces. */
  refreshOwnership(parent: UtilWorkspace): Promise<void>;
}

/** Where a nested link's folder is on disk. */
export function mountFolder(parent: UtilWorkspace, link: TeamSyncLinkedRepo) {
  return path
    .join(parent.localPath, link.path ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

/**
 * The workspace a link points at: the chosen one for a link that can live
 * anywhere, and the one in its folder for a nested link. "missing" when one
 * is chosen but not registered, or a nested link's folder holds a workspace
 * this daemon doesn't know; null when there is none.
 */
async function locateLinked(
  deps: LinkedSyncDeps,
  parent: UtilWorkspace,
  link: TeamSyncLinkedRepo,
  choice: ResolvedLinkChoice,
  checkLocalChanges: boolean,
): Promise<
  | { facts: LinkedWorkspaceFacts; workspace: ManagerWorkspace }
  | "missing"
  | null
> {
  if (choice.mode === "ignore") return null;
  if (link.path !== undefined) {
    const folder = mountFolder(parent, link);
    const workspace = await deps.findWorkspaceAt(folder);
    if (workspace) {
      return linkedFacts(deps, parent, workspace.id, checkLocalChanges);
    }
    return (await isWorkspaceRoot(folder)) ? "missing" : null;
  }
  if (!choice.workspaceId) return null;
  return linkedFacts(deps, parent, choice.workspaceId, checkLocalChanges);
}

/**
 * Writes a workspace's choice for one link to its workspace.json, replacing
 * any entry spelled with different case.
 */
export async function saveLinkEntry(
  localPath: string,
  repo: string,
  entry: WorkspaceLinkedWorkspace,
): Promise<WorkspaceTeamSyncSettings> {
  const persisted = await getWorkspaceConfig(localPath);
  if (!persisted) {
    throw new Error(`Workspace config missing on disk at ${localPath}`);
  }
  const teamSync: WorkspaceTeamSyncSettings = persisted.teamSync ?? {};
  const entries = Object.fromEntries(
    Object.entries(teamSync.linkedWorkspaces ?? {}).filter(
      ([name]) => name.toLowerCase() !== repo.toLowerCase(),
    ),
  );
  entries[repo] = entry;
  persisted.teamSync = { ...teamSync, linkedWorkspaces: entries };
  await saveWorkspaceConfig(persisted);
  return persisted.teamSync;
}

export interface SyncLinkedReposOptions {
  /** The changelist the parent is about to sync to; null for branch head. */
  targetChangelist: number | null;
  /** Repo names the user confirmed moving despite a confirm reason. */
  confirm?: string[];
  onStep?: (step: string) => void;
}

export interface SyncLinkedReposResult {
  /** The parent changelist whose config was read; null when none resolved. */
  configChangelist: number | null;
  links: LinkSyncResult[];
}

/**
 * The repo config at `changelist` (or the sync target branch's head), or
 * null when it cannot be read. A missing config is not an error.
 */
async function configAt(
  parent: UtilWorkspace,
  changelist: number | null,
): Promise<{ config: TeamSyncConfig | null; changelist: number } | null> {
  const client = await CreateApiClientAuth(parent.daemonId);
  let target = changelist;
  if (target === null) {
    const branch = await client.branch.getBranch.query({
      repoId: parent.repoId,
      name: syncTargetBranch(parent),
    });
    if (!branch) return null;
    target = branch.headNumber;
  }
  const result = await client.teamSync.getConfig.query({
    repoId: parent.repoId,
    changelistNumber: target,
  });
  return { config: result.config, changelist: target };
}

/** A link's result before any decision, filled in from where it points. */
function baseResult(
  link: TeamSyncLinkedRepo,
  choice: ResolvedLinkChoice,
  found: Awaited<ReturnType<typeof locateLinked>>,
): LinkSyncResult {
  const located = found && found !== "missing" ? found : null;
  // A nested link's workspace is the one in its folder, whatever the
  // workspace.json entry last recorded.
  const workspaceId =
    link.path !== undefined ? located?.workspace.id : choice.workspaceId;
  const result: LinkSyncResult = {
    repo: link.repo,
    branch: link.branch,
    pin: link.changelist,
    mode: choice.mode,
    source: choice.source,
    status: "not-set-up",
    ...(workspaceId && { workspaceId }),
    ...(link.path !== undefined && { path: link.path }),
  };
  if (located) {
    result.workspaceName = located.workspace.name;
    result.localPath = located.workspace.localPath;
    result.fromChangelist = located.facts.changelistNumber;
    if (located.facts.otherHolder) result.holder = located.facts.otherHolder;
  }
  return result;
}

/**
 * Facts about a chosen linked workspace, or "missing" when unregistered.
 * Checking for local changes scans the linked workspace, which is slow for an
 * engine, so status reports (which never sync) skip it.
 */
async function linkedFacts(
  deps: LinkedSyncDeps,
  parent: UtilWorkspace,
  workspaceId: string,
  checkLocalChanges = true,
): Promise<
  { facts: LinkedWorkspaceFacts; workspace: ManagerWorkspace } | "missing"
> {
  const workspace = await deps.findWorkspace(workspaceId);
  if (!workspace) return "missing";

  const client = await CreateApiClientAuth(workspace.daemonId);
  const repo = await client.repo.getRepo.query({ id: workspace.repoId });
  const backend = (await DaemonConfig.Get()).stateBackend;
  const state = await getWorkspaceState(workspace.localPath, backend);

  const holder = state.teamSync?.linkHolder;
  const otherHolder =
    holder &&
    holder.workspaceId !== parent.id &&
    (await deps.findWorkspace(holder.workspaceId)) &&
    holder.changelist === state.changelistNumber
      ? holder
      : null;

  return {
    workspace,
    facts: {
      repoName: repo?.name ?? "",
      orgId: repo?.orgId ?? "",
      domainBranchName: workspace.domainBranchName,
      activeBranches: workspace.activeBranches ?? [],
      changelistNumber: state.changelistNumber,
      hasLocalChanges: checkLocalChanges
        ? await deps.hasLocalChanges(workspace)
        : false,
      busy: deps.isBusy(workspace.id),
      otherHolder,
    },
  };
}

/**
 * Brings each followed linked workspace to the pin the parent's config sets at
 * the changelist the parent is about to sync to. Runs before the parent's own
 * sync, so a failure leaves the parent on its old changelist with its old
 * dependencies, which still builds.
 *
 * Every link is checked before any is moved. If one needs confirmation, this
 * throws {@link LinkConfirmationRequiredError} without touching anything; if a
 * linked sync fails, it throws and the caller must not sync the parent.
 * Links are not followed transitively: a linked repo's own links are left
 * alone.
 */
export async function syncLinkedRepos(
  parent: UtilWorkspace,
  parentOrgId: string,
  deps: LinkedSyncDeps,
  options: SyncLinkedReposOptions,
): Promise<SyncLinkedReposResult> {
  let resolved: Awaited<ReturnType<typeof configAt>>;
  try {
    resolved = await configAt(parent, options.targetChangelist);
  } catch (err) {
    // Unknown links are not the same as no links, but refusing to sync the
    // parent over an unreachable config would block every sync while the
    // API is down. Say so and carry on.
    Logger.warn(`Linked repos: could not read the repo config: ${err}`);
    return { configChangelist: null, links: [] };
  }
  const links = resolved?.config?.linkedRepos ?? [];
  if (!resolved || links.length === 0) {
    return { configChangelist: resolved?.changelist ?? null, links: [] };
  }

  const settings = (await getWorkspaceConfig(parent.localPath))?.teamSync;
  const presets = resolved.config?.presets ?? [];
  const confirmed = new Set(
    (options.confirm ?? []).map((r) => r.toLowerCase()),
  );

  type Planned = {
    result: LinkSyncResult;
    link: TeamSyncLinkedRepo;
    workspace?: ManagerWorkspace;
    create?: boolean;
  };
  const planned: Planned[] = [];

  for (const link of links) {
    const choice = resolveLinkChoice(link, settings, presets);
    const found = await locateLinked(deps, parent, link, choice, true);
    const result = baseResult(link, choice, found);

    const decision = decideLinkSync(
      link,
      choice,
      parentOrgId,
      found === "missing" ? "missing" : (found?.facts ?? null),
      confirmed.has(link.repo.toLowerCase()),
    );
    if (decision.action === "report") {
      result.status = decision.status;
    } else if (decision.action === "confirm") {
      result.status = "needs-confirmation";
      result.reasons = decision.reasons;
    } else {
      // Settled by the sync below.
      result.status =
        decision.action === "create" ? "not-created" : "out-of-date";
    }
    planned.push({
      result,
      link,
      ...(decision.action === "sync" &&
        found &&
        found !== "missing" && { workspace: found.workspace }),
      ...(decision.action === "create" && { create: true }),
    });
  }

  // A linked workspace in the middle of another operation can't be moved
  // now, and syncing the parent without it would leave the parent ahead of
  // its dependency. The operation ends on its own, so this asks for a retry.
  const busy = planned.map((p) => p.result).filter((r) => r.status === "busy");
  if (busy.length > 0) {
    throw new Error(
      `Did not sync: ${busy
        .map((r) => `linked repo ${r.repo} (${r.workspaceName})`)
        .join(
          ", ",
        )} is busy with another operation. Try again when it finishes.`,
    );
  }

  const blocked = planned
    .map((p) => p.result)
    .filter((r) => r.status === "needs-confirmation");
  if (blocked.length > 0) throw new LinkConfirmationRequiredError(blocked);

  const backend = (await DaemonConfig.Get()).stateBackend;
  const now = () => new Date().toISOString();
  const pins: Record<string, AppliedLinkPin> = {};

  for (const entry of planned) {
    const { result } = entry;
    let workspace = entry.workspace;

    if (entry.create) {
      // A nested link with no workspace yet: make one at its folder, record
      // it, and sync it like any other. A failure here (no access to the
      // repo, a file where the folder goes) is reported rather than stopping
      // the parent, like a link that is not set up.
      const folder = mountFolder(parent, entry.link);
      options.onStep?.(
        `Creating linked workspace ${result.repo} at ${entry.link.path}`,
      );
      try {
        workspace = await deps.createWorkspace({
          daemonId: parent.daemonId,
          orgId: parentOrgId,
          repo: entry.link.repo,
          branch: entry.link.branch,
          localPath: folder,
          name: `${parent.workspaceName} ${entry.link.repo}`.slice(0, 100),
        });
      } catch (err) {
        result.status = "create-failed";
        result.error = err instanceof Error ? err.message : String(err);
        Logger.warn(
          `Linked repo ${result.repo}: could not create its workspace at ${folder}: ${result.error}`,
        );
        continue;
      }
      result.created = true;
      result.workspaceId = workspace.id;
      result.workspaceName = workspace.name;
      result.localPath = workspace.localPath;
      result.fromChangelist = 0;
      await saveLinkEntry(parent.localPath, entry.link.repo, {
        mode: "follow-pin",
        workspaceId: workspace.id,
      });
      // The parent must treat the folder as the child's before the child's
      // files arrive in it.
      await deps.refreshOwnership(parent);
    }

    if (workspace) {
      options.onStep?.(
        `Syncing linked repo ${result.repo} to changelist ${result.pin}`,
      );
      try {
        await deps.syncWorkspace(workspace, result.pin);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Did not sync: linked repo ${result.repo} (${workspace.name}) failed to sync to changelist ${result.pin}: ${message}`,
        );
      }
      result.status = "synced";
      await updateWorkspaceState(
        workspace,
        {
          meta: {
            linkHolder: {
              workspaceId: parent.id,
              workspaceName: parent.workspaceName,
              localPath: parent.localPath,
              changelist: result.pin,
              at: now(),
            },
          },
        },
        backend,
      );
    } else if (result.status === "up-to-date" && result.mode === "follow-pin") {
      // Claim it when nobody else holds it, so a second parent asks first.
      const linked = await deps.findWorkspace(result.workspaceId!);
      if (linked && !result.holder) {
        const state = await getWorkspaceState(linked.localPath, backend);
        if (state.teamSync?.linkHolder?.workspaceId !== parent.id) {
          await updateWorkspaceState(
            linked,
            {
              meta: {
                linkHolder: {
                  workspaceId: parent.id,
                  workspaceName: parent.workspaceName,
                  localPath: parent.localPath,
                  changelist: result.pin,
                  at: now(),
                },
              },
            },
            backend,
          );
        }
      }
    }

    if (
      (result.status === "synced" || result.status === "up-to-date") &&
      result.workspaceId
    ) {
      pins[result.repo] = {
        changelist: result.pin,
        workspaceId: result.workspaceId,
        appliedAt: now(),
      };
    }
  }

  for (const result of planned.map((p) => p.result)) {
    if (result.status !== "synced" && result.status !== "up-to-date") {
      Logger.info(`Linked repo ${result.repo}: ${result.status}`);
    }
  }

  if (Object.keys(pins).length > 0) {
    const state = await getWorkspaceState(parent.localPath, backend);
    await updateWorkspaceState(
      parent,
      {
        meta: {
          linkedPins: { ...(state.teamSync?.linkedPins ?? {}), ...pins },
        },
      },
      backend,
    );
  }

  return {
    configChangelist: resolved.changelist,
    links: planned.map((p) => p.result),
  };
}

/**
 * Links whose pin at the changelist the parent actually landed on differs
 * from the pin applied before the sync: a changelist that moved a pin landed
 * between resolving the target and pulling. Syncing again fixes it.
 */
export async function stalePinsAfterSync(
  parent: UtilWorkspace,
  syncedChangelist: number,
  before: SyncLinkedReposResult,
): Promise<string[]> {
  if (
    before.configChangelist === null ||
    before.configChangelist === syncedChangelist
  ) {
    return [];
  }
  try {
    const after = await configAt(parent, syncedChangelist);
    const pinAfter = new Map(
      (after?.config?.linkedRepos ?? []).map((l) => [
        l.repo.toLowerCase(),
        l.changelist,
      ]),
    );
    return before.links
      .filter(
        (l) =>
          (l.status === "synced" || l.status === "up-to-date") &&
          pinAfter.get(l.repo.toLowerCase()) !== l.pin,
      )
      .map((l) => l.repo);
  } catch {
    return [];
  }
}

/** A link as the settings UI shows it, without syncing anything. */
export interface LinkStatusReport extends LinkSyncResult {
  path?: string;
  /** The pin this workspace last applied for the link. */
  appliedPin?: AppliedLinkPin;
}

/**
 * Reports every link in the parent's config at `changelist` (default: the
 * parent's current changelist) as it stands on this machine.
 */
export async function getLinkStatuses(
  parent: UtilWorkspace,
  parentOrgId: string,
  deps: LinkedSyncDeps,
  changelist?: number,
): Promise<{ configChangelist: number | null; links: LinkStatusReport[] }> {
  const backend = (await DaemonConfig.Get()).stateBackend;
  const parentState = await getWorkspaceState(parent.localPath, backend);
  const resolved = await configAt(
    parent,
    changelist ?? parentState.changelistNumber,
  );
  const links = resolved?.config?.linkedRepos ?? [];
  const settings = (await getWorkspaceConfig(parent.localPath))?.teamSync;
  const presets = resolved?.config?.presets ?? [];

  const reports: LinkStatusReport[] = [];
  for (const link of links) {
    const choice = resolveLinkChoice(link, settings, presets);
    const found = await locateLinked(deps, parent, link, choice, false);
    // Reporting never syncs, so treat everything as confirmed and map a
    // would-sync decision to "out-of-date" (or "not-created" for a nested
    // link the next sync creates).
    const decision = decideLinkSync(
      link,
      choice,
      parentOrgId,
      found === "missing" ? "missing" : (found?.facts ?? null),
      true,
    );
    const report: LinkStatusReport = baseResult(link, choice, found);
    report.status =
      decision.action === "report"
        ? decision.status
        : decision.action === "create"
          ? "not-created"
          : "out-of-date";
    const applied = lookup(parentState.teamSync?.linkedPins, link.repo);
    if (applied) report.appliedPin = applied;
    reports.push(report);
  }
  return { configChangelist: resolved?.changelist ?? null, links: reports };
}
