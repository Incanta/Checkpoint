import { Notification, type BrowserWindow, type IpcMain } from "electron";
import { CreateDaemonClient } from "@checkpointvcs/daemon";
import type { Workspace } from "@checkpointvcs/daemon";
import { spawn } from "child_process";
import path from "path";
import { store } from "../common/state/store";
import { currentWorkspaceAtom } from "../common/state/workspace";
import {
  teamSyncBisectAtom,
  teamSyncChangelistsAtom,
  teamSyncCleanAtom,
  teamSyncConfigAtom,
  teamSyncFilterPreviewAtom,
  teamSyncJobAtom,
  teamSyncMetadataAtom,
  teamSyncModeAtom,
  teamSyncSettingsAtom,
  teamSyncStatusAtom,
  getWsRecord,
  setWsRecord,
  type TeamSyncBisectState,
  type TeamSyncSettings,
} from "../common/state/team-sync";
import { Channels, ipcOn, ipcSend } from "./channels";

type DaemonClient = Awaited<ReturnType<typeof CreateDaemonClient>>;

const JOB_POLL_INTERVAL_MS = 500;
const HEAD_POLL_INTERVAL_MS = 30_000;
const HISTORY_COUNT = 100;

/**
 * Owns the main-process side of the Phase 1 Team Sync UI: it fetches project
 * info, config, settings, and history into the shared atoms, drives the sync
 * pipeline job (mirroring progress and streaming logs to the renderer), and
 * launches the Unreal editor. Construction mirrors DaemonHandler: register the
 * IPC handlers in `init`, once the window's webContents is available.
 */
export default class TeamSyncHandler {
  private readonly isMocked: boolean;
  private readonly ipcMain: IpcMain;
  private webContents: Electron.WebContents | null = null;
  private window: BrowserWindow | null = null;
  private headPollTimer: NodeJS.Timeout | null = null;

  public constructor(ipcMain: IpcMain) {
    this.isMocked = process.env.USE_MOCK_DATA === "true";
    this.ipcMain = ipcMain;
  }

  /** Provide the main window so jobs can drive taskbar progress + restore. */
  public setWindow(window: BrowserWindow): void {
    this.window = window;
  }

  public init(webContents: Electron.WebContents): void {
    this.webContents = webContents;

    ipcOn(this.ipcMain, "team-sync:enter", async (_event, data) => {
      await this.enter(data);
    });

    ipcOn(this.ipcMain, "team-sync:exit", async () => {
      this.exit();
    });

    ipcOn(this.ipcMain, "team-sync:refresh", async () => {
      await this.refresh();
    });

    ipcOn(this.ipcMain, "team-sync:sync", async (_event, data) => {
      await this.sync(data);
    });

    ipcOn(this.ipcMain, "team-sync:launch-editor", async () => {
      await this.launchEditor();
    });

    ipcOn(this.ipcMain, "team-sync:cancel-job", async (_event, data) => {
      await this.cancelJob(data);
    });

    ipcOn(this.ipcMain, "team-sync:update-settings", async (_event, data) => {
      await this.updateSettings(data);
    });

    ipcOn(this.ipcMain, "team-sync:sync-latest-good", async () => {
      await this.syncLatestGood();
    });

    ipcOn(this.ipcMain, "team-sync:vote", async (_event, data) => {
      await this.setVote(data);
    });

    ipcOn(this.ipcMain, "team-sync:star", async (_event, data) => {
      await this.setStar(data);
    });

    ipcOn(this.ipcMain, "team-sync:investigate", async (_event, data) => {
      await this.setInvestigating(data);
    });

    ipcOn(this.ipcMain, "team-sync:comment", async (_event, data) => {
      await this.addComment(data);
    });

    ipcOn(this.ipcMain, "team-sync:build", async (_event, data) => {
      await this.build(data);
    });

    ipcOn(this.ipcMain, "team-sync:generate-project-files", async () => {
      await this.generateProjectFiles();
    });

    ipcOn(this.ipcMain, "team-sync:clean:preview", async () => {
      await this.cleanPreview();
    });

    ipcOn(this.ipcMain, "team-sync:clean:execute", async (_event, data) => {
      await this.cleanExecute(data);
    });

    ipcOn(this.ipcMain, "team-sync:bisect:refresh", async () => {
      await this.refreshBisect();
    });

    ipcOn(this.ipcMain, "team-sync:bisect:mark", async (_event, data) => {
      await this.bisectMark(data);
    });

    ipcOn(this.ipcMain, "team-sync:bisect:reset", async () => {
      await this.bisectReset();
    });

    ipcOn(this.ipcMain, "team-sync:filter:preview", async (_event, data) => {
      await this.filterPreview(data);
    });
  }

  // ─── Clean (Phase 2/3) ───────────────────────────────────────────

  private async cleanPreview(): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const files = await client.workspaces.teamSync.cleanPreview.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });
      setWsRecord(teamSyncCleanAtom, workspace.id, files);
      if (this.webContents) {
        ipcSend(this.webContents, "team-sync:clean:preview:data", { files });
      }
    } catch (error) {
      console.error("Failed to preview Team Sync clean:", error);
    }
  }

  private async cleanExecute(
    data: Channels["team-sync:clean:execute"],
  ): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.teamSync.cleanExecute.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        paths: data.paths,
      });
      setWsRecord(teamSyncCleanAtom, workspace.id, []);
      await this.refreshStatus(client, workspace);
      await this.refreshHistory(client, workspace);
    } catch (error) {
      const message =
        (error as Error)?.message ?? "Failed to clean the workspace";
      if (this.webContents) {
        ipcSend(this.webContents, "team-sync:sync:error", { message });
      }
    }
  }

  // ─── Bisect (Phase 2/3) ──────────────────────────────────────────

  /** Fetch the bisect state, set the atom, and mirror it to the renderer. */
  private async emitBisect(
    client: DaemonClient,
    workspace: Workspace,
  ): Promise<void> {
    const state = await client.workspaces.teamSync.bisectGetState.query({
      daemonId: workspace.daemonId,
      workspaceId: workspace.id,
    });

    const bisect: Record<string, string> = {};
    for (const [cl, verdict] of Object.entries(state.bisect)) {
      bisect[cl] = verdict;
    }

    const value: TeamSyncBisectState = { bisect, next: state.next };
    setWsRecord(teamSyncBisectAtom, workspace.id, value);
    if (this.webContents) {
      ipcSend(this.webContents, "team-sync:bisect:data", value);
    }
  }

  private async refreshBisect(): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await this.emitBisect(client, workspace);
    } catch (error) {
      console.error("Failed to refresh Team Sync bisect:", error);
    }
  }

  private async bisectMark(
    data: Channels["team-sync:bisect:mark"],
  ): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.teamSync.bisectMark.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumber: data.changelistNumber,
        verdict: data.verdict,
      });
      await this.emitBisect(client, workspace);
      const changelists = getWsRecord(
        store.get(teamSyncChangelistsAtom),
        workspace.id,
      );
      await this.refreshMetadata(
        client,
        workspace,
        (changelists?.entries ?? []).map((entry) => entry.number),
      );
    } catch (error) {
      console.error("Failed to mark Team Sync bisect:", error);
    }
  }

  private async bisectReset(): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.teamSync.bisectReset.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });
      await this.emitBisect(client, workspace);
      const changelists = getWsRecord(
        store.get(teamSyncChangelistsAtom),
        workspace.id,
      );
      await this.refreshMetadata(
        client,
        workspace,
        (changelists?.entries ?? []).map((entry) => entry.number),
      );
    } catch (error) {
      console.error("Failed to reset Team Sync bisect:", error);
    }
  }

  // ─── Filter preview (Phase 2/3) ──────────────────────────────────

  private async filterPreview(
    data: Channels["team-sync:filter:preview"],
  ): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const result = await client.workspaces.teamSync.previewFilterChange.query(
        {
          daemonId: workspace.daemonId,
          workspaceId: workspace.id,
          settings: data.settings,
        },
      );
      setWsRecord(teamSyncFilterPreviewAtom, workspace.id, result);
      if (this.webContents) {
        ipcSend(this.webContents, "team-sync:filter:preview:data", result);
      }
    } catch (error) {
      console.error("Failed to preview Team Sync filter change:", error);
    }
  }

  // ─── Review actions ──────────────────────────────────────────────

  private async syncLatestGood(): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const result = await client.workspaces.teamSync.findLatestGood.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });

      if (!result) {
        if (this.webContents) {
          ipcSend(this.webContents, "team-sync:sync-latest-good:none", null);
        }
        return;
      }

      await this.sync({ changelistNumber: result.changelistNumber });
    } catch (error) {
      const message =
        (error as Error)?.message ?? "Failed to find the latest good CL";
      if (this.webContents) {
        ipcSend(this.webContents, "team-sync:sync:error", { message });
      }
    }
  }

  private async setVote(data: Channels["team-sync:vote"]): Promise<void> {
    await this.runReviewMutation((client, workspace) =>
      client.workspaces.teamSync.setVote.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumber: data.changelistNumber,
        vote: data.vote,
      }),
    );
  }

  private async setStar(data: Channels["team-sync:star"]): Promise<void> {
    await this.runReviewMutation((client, workspace) =>
      client.workspaces.teamSync.setStarred.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumber: data.changelistNumber,
        starred: data.starred,
      }),
    );
  }

  private async setInvestigating(
    data: Channels["team-sync:investigate"],
  ): Promise<void> {
    await this.runReviewMutation((client, workspace) =>
      client.workspaces.teamSync.setInvestigating.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumber: data.changelistNumber,
        investigating: data.investigating,
      }),
    );
  }

  private async addComment(data: Channels["team-sync:comment"]): Promise<void> {
    await this.runReviewMutation((client, workspace) =>
      client.workspaces.teamSync.addComment.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumber: data.changelistNumber,
        body: data.body,
      }),
    );
  }

  /**
   * Run a review mutation for the current workspace and refresh the metadata
   * for the loaded page so the browser reflects the change immediately.
   */
  private async runReviewMutation(
    mutate: (client: DaemonClient, workspace: Workspace) => Promise<unknown>,
  ): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await mutate(client, workspace);

      const changelists = getWsRecord(
        store.get(teamSyncChangelistsAtom),
        workspace.id,
      );
      await this.refreshMetadata(
        client,
        workspace,
        (changelists?.entries ?? []).map((entry) => entry.number),
      );
    } catch (error) {
      console.error("Team Sync review mutation failed:", error);
    }
  }

  // ─── Entry / lifecycle ───────────────────────────────────────────

  private async enter(data: Channels["team-sync:enter"]): Promise<void> {
    if (this.isMocked) return;

    const workspace = this.getWorkspace(data.workspaceId);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();

      // Config first: refreshMode reads it to decide whether Unreal is enabled.
      await this.refreshConfig(client, workspace);
      await this.refreshMode(client, workspace);
      await this.refreshSettings(client, workspace);
      await this.refreshStatus(client, workspace);
      await this.refreshHistory(client, workspace);

      this.startHeadPoll();
    } catch (error) {
      console.error("Failed to enter Team Sync:", error);
    }
  }

  private exit(): void {
    this.stopHeadPoll();
  }

  private async refresh(): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await this.refreshConfig(client, workspace);
      // Re-derived from the config, so a repo adding or removing its `unreal`
      // block takes effect on the next refresh rather than the next app start.
      await this.refreshMode(client, workspace);
      await this.refreshSettings(client, workspace);
      await this.refreshStatus(client, workspace);
      await this.refreshHistory(client, workspace);
    } catch (error) {
      console.error("Failed to refresh Team Sync:", error);
    }
  }

  private startHeadPoll(): void {
    this.stopHeadPoll();
    this.headPollTimer = setInterval(() => {
      void this.pollHead();
    }, HEAD_POLL_INTERVAL_MS);
  }

  private stopHeadPoll(): void {
    if (this.headPollTimer) {
      clearInterval(this.headPollTimer);
      this.headPollTimer = null;
    }
  }

  private async pollHead(): Promise<void> {
    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await this.refreshHistory(client, workspace);
    } catch (error) {
      console.error("Team Sync head poll failed:", error);
    }
  }

  // ─── Atom refreshers ─────────────────────────────────────────────

  /**
   * Resolve the workspace's Unreal status. Reads the config atom, so it must
   * run after `refreshConfig`.
   *
   * Unreal discovery is skipped entirely for a repo that did not opt in: there
   * is nothing to offer, and scanning for a .uproject would be wasted work on
   * every non-Unreal workspace.
   */
  private async refreshMode(
    client: DaemonClient,
    workspace: Workspace,
  ): Promise<void> {
    const config = getWsRecord(store.get(teamSyncConfigAtom), workspace.id);
    const enabled = config?.unreal != null;

    if (!enabled) {
      setWsRecord(teamSyncModeAtom, workspace.id, {
        enabled: false,
        detected: false,
        uprojectPath: null,
        projectName: null,
      });
      return;
    }

    try {
      const projectInfo = await client.workspaces.teamSync.getProjectInfo.query(
        {
          daemonId: workspace.daemonId,
          workspaceId: workspace.id,
        },
      );

      setWsRecord(teamSyncModeAtom, workspace.id, {
        enabled: true,
        detected: projectInfo != null,
        uprojectPath: projectInfo?.uprojectPath ?? null,
        projectName: projectInfo?.projectName ?? null,
      });
    } catch (error) {
      console.error("Failed to fetch Team Sync project info:", error);
      setWsRecord(teamSyncModeAtom, workspace.id, {
        enabled: true,
        detected: false,
        uprojectPath: null,
        projectName: null,
      });
    }
  }

  private async refreshConfig(
    client: DaemonClient,
    workspace: Workspace,
  ): Promise<void> {
    try {
      const result = await client.workspaces.teamSync.getConfig.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });
      setWsRecord(teamSyncConfigAtom, workspace.id, result.config);
    } catch (error) {
      console.error("Failed to fetch Team Sync config:", error);
      setWsRecord(teamSyncConfigAtom, workspace.id, null);
    }
  }

  private async refreshSettings(
    client: DaemonClient,
    workspace: Workspace,
  ): Promise<void> {
    try {
      const settings = await client.workspaces.teamSync.getSettings.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });
      setWsRecord(
        teamSyncSettingsAtom,
        workspace.id,
        settings as TeamSyncSettings,
      );
    } catch (error) {
      console.error("Failed to fetch Team Sync settings:", error);
    }
  }

  private async refreshStatus(
    client: DaemonClient,
    workspace: Workspace,
  ): Promise<void> {
    try {
      const syncStatus = await client.workspaces.sync.getSyncStatus.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        forceRefresh: false,
      });

      const previous = getWsRecord(store.get(teamSyncStatusAtom), workspace.id);

      setWsRecord(teamSyncStatusAtom, workspace.id, {
        syncedCl: syncStatus.localChangelistNumber,
        // TODO(phase2): populate applied precompiled-binary sets from the
        // daemon's artifact-apply state once that is exposed.
        appliedBinaries: previous?.appliedBinaries ?? [],
        lastSync: previous?.lastSync ?? null,
      });
    } catch (error) {
      console.error("Failed to fetch Team Sync status:", error);
    }
  }

  private async refreshHistory(
    client: DaemonClient,
    workspace: Workspace,
  ): Promise<void> {
    try {
      const changelists = await client.workspaces.history.get.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        count: HISTORY_COUNT,
      });

      setWsRecord(teamSyncChangelistsAtom, workspace.id, {
        entries: changelists.map((cl) => ({
          number: cl.number,
          message: cl.message ?? "",
          createdAt: new Date(cl.createdAt).toISOString(),
          user: cl.user
            ? {
                email: cl.user.email,
                name: cl.user.name ?? null,
                username: cl.user.username ?? null,
              }
            : null,
        })),
        hasMore: changelists.length >= HISTORY_COUNT,
      });

      await this.refreshMetadata(
        client,
        workspace,
        changelists.map((cl) => cl.number),
      );
    } catch (error) {
      console.error("Failed to fetch Team Sync history:", error);
    }
  }

  /**
   * Fetch per-changelist metadata (badges, presence, artifact types) for the
   * loaded page. Degrades to empty when the org is not licensed for Team Sync.
   */
  private async refreshMetadata(
    client: DaemonClient,
    workspace: Workspace,
    changelistNumbers: number[],
  ): Promise<void> {
    if (changelistNumbers.length === 0) {
      setWsRecord(teamSyncMetadataAtom, workspace.id, {});
      return;
    }

    try {
      const meta = await client.workspaces.teamSync.getChangelistMeta.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumbers,
      });
      setWsRecord(teamSyncMetadataAtom, workspace.id, meta);
    } catch (error) {
      console.error("Failed to fetch Team Sync metadata:", error);
      setWsRecord(teamSyncMetadataAtom, workspace.id, {});
    }
  }

  // ─── Sync pipeline ───────────────────────────────────────────────

  private async sync(data: Channels["team-sync:sync"]): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const { jobId } = await client.workspaces.sync.pull.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistId: data.changelistNumber,
        filePaths: null,
        noProgress: true,
      });

      const startedAt = new Date().toISOString();
      setWsRecord(teamSyncJobAtom, workspace.id, {
        jobId,
        kind: "sync",
        currentStep: null,
        progress: null,
        startedAt,
      });

      await this.pollJob(client, workspace, jobId, startedAt, "sync");
    } catch (error) {
      const message =
        (error as Error)?.message ?? "An unknown error occurred during sync";
      if (this.webContents) {
        ipcSend(this.webContents, "team-sync:sync:error", { message });
      }
    }
  }

  // ─── Build ───────────────────────────────────────────────────────

  private async build(data: Channels["team-sync:build"]): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const { jobId } = await client.workspaces.teamSync.build.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        forceClean: data.forceClean ?? false,
      });

      const startedAt = new Date().toISOString();
      setWsRecord(teamSyncJobAtom, workspace.id, {
        jobId,
        kind: "build",
        currentStep: null,
        progress: null,
        startedAt,
      });

      await this.pollJob(client, workspace, jobId, startedAt, "build");
    } catch (error) {
      const message =
        (error as Error)?.message ?? "An unknown error occurred during build";
      if (this.webContents) {
        ipcSend(this.webContents, "team-sync:sync:error", { message });
      }
    }
  }

  private async generateProjectFiles(): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const { jobId } =
        await client.workspaces.teamSync.generateProjectFiles.mutate({
          daemonId: workspace.daemonId,
          workspaceId: workspace.id,
        });

      const startedAt = new Date().toISOString();
      setWsRecord(teamSyncJobAtom, workspace.id, {
        jobId,
        kind: "build",
        currentStep: null,
        progress: null,
        startedAt,
      });

      await this.pollJob(client, workspace, jobId, startedAt, "build");
    } catch (error) {
      const message =
        (error as Error)?.message ??
        "An unknown error occurred generating project files";
      if (this.webContents) {
        ipcSend(this.webContents, "team-sync:sync:error", { message });
      }
    }
  }

  private async pollJob(
    client: DaemonClient,
    workspace: Workspace,
    jobId: string,
    startedAt: string,
    kind: "sync" | "build",
  ): Promise<void> {
    let nextSeq = -1;

    for (;;) {
      const job = await client.jobs.getStatus.query({ jobId });

      // Build jobs report progress via step states, not a done/total counter;
      // surface the running step's description as the current step.
      const runningStep = job.stepStates?.find(
        (step) => step.status === "running",
      );
      const currentStep = job.currentStep ?? runningStep?.description ?? null;

      setWsRecord(teamSyncJobAtom, workspace.id, {
        jobId,
        kind,
        currentStep,
        progress: job.progress,
        startedAt,
      });

      nextSeq = await this.streamLogs(client, jobId, nextSeq);

      // Taskbar progress: fractional when known, indeterminate while running.
      if (this.window) {
        if (job.progress && job.progress.total > 0) {
          this.window.setProgressBar(job.progress.done / job.progress.total);
        } else {
          this.window.setProgressBar(1, { mode: "indeterminate" });
        }
      }

      if (job.status === "completed" || job.status === "failed") {
        setWsRecord(teamSyncJobAtom, workspace.id, null);
        this.window?.setProgressBar(-1);

        const label = kind === "build" ? "Build" : "Sync";
        if (job.status === "failed") {
          if (this.webContents) {
            ipcSend(this.webContents, "team-sync:sync:error", {
              message: job.error ?? `${label} failed`,
            });
          }
          this.notify(
            `${label} failed`,
            job.error ?? `The ${label.toLowerCase()} did not complete.`,
          );
        } else {
          this.notify(
            `${label} complete`,
            kind === "build"
              ? `${workspace.name} finished building.`
              : `${workspace.name} is now synced.`,
          );
        }

        await this.refreshStatus(client, workspace);
        await this.refreshHistory(client, workspace);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    }
  }

  /**
   * Show a native OS notification for a background job outcome. Clicking it
   * restores and focuses the main window. No-op when the platform cannot show
   * notifications.
   */
  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    notification.on("click", () => {
      const win = this.window;
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    notification.show();
  }

  /**
   * Reads any log lines newer than `afterSeq`, forwards them to the renderer,
   * and returns the new cursor. Errors are swallowed so a transient log read
   * failure never aborts the job poll.
   */
  private async streamLogs(
    client: DaemonClient,
    jobId: string,
    afterSeq: number,
  ): Promise<number> {
    try {
      const logs = await client.jobs.getLogs.query({ jobId, afterSeq });
      if (logs.lines.length > 0 && this.webContents) {
        ipcSend(this.webContents, "team-sync:log:append", {
          jobId,
          startLine: logs.lines[0].seq,
          lines: logs.lines.map((entry) => entry.line),
        });
      }
      return logs.nextSeq;
    } catch (error) {
      console.error("Failed to read Team Sync job logs:", error);
      return afterSeq;
    }
  }

  private async cancelJob(
    data: Channels["team-sync:cancel-job"],
  ): Promise<void> {
    if (this.isMocked) return;

    try {
      const client = await CreateDaemonClient();
      await client.jobs.cancel.mutate({ jobId: data.jobId });
    } catch (error) {
      console.error("Failed to cancel Team Sync job:", error);
    }
  }

  private async updateSettings(
    data: Channels["team-sync:update-settings"],
  ): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const merged = await client.workspaces.teamSync.updateSettings.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        settings: data.settings,
      });
      setWsRecord(
        teamSyncSettingsAtom,
        workspace.id,
        merged as TeamSyncSettings,
      );
    } catch (error) {
      console.error("Failed to update Team Sync settings:", error);
    }
  }

  // ─── Editor launch ───────────────────────────────────────────────

  private async launchEditor(): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) {
      this.emitLaunchError("No workspace is selected");
      return;
    }

    try {
      const client = await CreateDaemonClient();
      const projectInfo = await client.workspaces.teamSync.getProjectInfo.query(
        {
          daemonId: workspace.daemonId,
          workspaceId: workspace.id,
        },
      );

      // Settings are fetched so future phases can honor editorConfiguration /
      // afterSync; the exe name is currently derived from engineDir only.
      await client.workspaces.teamSync.getSettings.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });

      if (!projectInfo || !projectInfo.engine) {
        this.emitLaunchError(
          "Could not locate the Unreal engine for this workspace",
        );
        return;
      }

      if (!projectInfo.uprojectPath) {
        this.emitLaunchError("No .uproject was found in this workspace");
        return;
      }

      // TODO(phase 1/3): honor the requested build configuration by selecting
      // the matching editor executable (e.g. UnrealEditor-Win64-Debug.exe).
      const editorExe = editorExePath(projectInfo.engine.engineDir);
      const uprojectAbs = path.join(
        workspace.localPath,
        projectInfo.uprojectPath,
      );

      spawn(editorExe, [uprojectAbs], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } catch (error) {
      this.emitLaunchError(
        (error as Error)?.message ?? "Failed to launch the editor",
      );
    }
  }

  private emitLaunchError(message: string): void {
    if (this.webContents) {
      ipcSend(this.webContents, "team-sync:launch-editor:error", { message });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private getWorkspace(workspaceId: string): Workspace | null {
    const current = store.get(currentWorkspaceAtom);
    if (current && current.id === workspaceId) return current;
    console.warn(
      `Team Sync enter for ${workspaceId} but current workspace is ${
        current?.id ?? "none"
      }`,
    );
    return current;
  }
}

/** Resolve the platform-specific UnrealEditor executable under an engine dir. */
function editorExePath(engineDir: string): string {
  switch (process.platform) {
    case "win32":
      return path.join(
        engineDir,
        "Engine",
        "Binaries",
        "Win64",
        "UnrealEditor.exe",
      );
    case "darwin":
      return path.join(
        engineDir,
        "Engine",
        "Binaries",
        "Mac",
        "UnrealEditor.app",
        "Contents",
        "MacOS",
        "UnrealEditor",
      );
    default:
      return path.join(
        engineDir,
        "Engine",
        "Binaries",
        "Linux",
        "UnrealEditor",
      );
  }
}
