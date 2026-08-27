import { Notification, type BrowserWindow, type IpcMain } from "electron";
import { CreateDaemonClient } from "@checkpointvcs/daemon";
import type { Workspace } from "@checkpointvcs/daemon";
import { spawn } from "child_process";
import path from "path";
import { store } from "../common/state/store";
import { currentWorkspaceAtom } from "../common/state/workspace";
import {
  gameSyncBisectAtom,
  gameSyncChangelistsAtom,
  gameSyncCleanAtom,
  gameSyncConfigAtom,
  gameSyncFilterPreviewAtom,
  gameSyncJobAtom,
  gameSyncMetadataAtom,
  gameSyncModeAtom,
  gameSyncSettingsAtom,
  gameSyncStatusAtom,
  getWsRecord,
  setWsRecord,
  type GameSyncBisectState,
  type GameSyncSettings,
} from "../common/state/game-sync";
import { Channels, ipcOn, ipcSend } from "./channels";

type DaemonClient = Awaited<ReturnType<typeof CreateDaemonClient>>;

const JOB_POLL_INTERVAL_MS = 500;
const HEAD_POLL_INTERVAL_MS = 30_000;
const HISTORY_COUNT = 100;

/**
 * Owns the main-process side of the Phase 1 Game Sync UI: it fetches project
 * info, config, settings, and history into the shared atoms, drives the sync
 * pipeline job (mirroring progress and streaming logs to the renderer), and
 * launches the Unreal editor. Construction mirrors DaemonHandler: register the
 * IPC handlers in `init`, once the window's webContents is available.
 */
export default class GameSyncHandler {
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

    ipcOn(this.ipcMain, "game-sync:enter", async (_event, data) => {
      await this.enter(data);
    });

    ipcOn(this.ipcMain, "game-sync:exit", async () => {
      this.exit();
    });

    ipcOn(this.ipcMain, "game-sync:refresh", async () => {
      await this.refresh();
    });

    ipcOn(this.ipcMain, "game-sync:sync", async (_event, data) => {
      await this.sync(data);
    });

    ipcOn(this.ipcMain, "game-sync:launch-editor", async () => {
      await this.launchEditor();
    });

    ipcOn(this.ipcMain, "game-sync:cancel-job", async (_event, data) => {
      await this.cancelJob(data);
    });

    ipcOn(this.ipcMain, "game-sync:update-settings", async (_event, data) => {
      await this.updateSettings(data);
    });

    ipcOn(this.ipcMain, "game-sync:sync-latest-good", async () => {
      await this.syncLatestGood();
    });

    ipcOn(this.ipcMain, "game-sync:vote", async (_event, data) => {
      await this.setVote(data);
    });

    ipcOn(this.ipcMain, "game-sync:star", async (_event, data) => {
      await this.setStar(data);
    });

    ipcOn(this.ipcMain, "game-sync:investigate", async (_event, data) => {
      await this.setInvestigating(data);
    });

    ipcOn(this.ipcMain, "game-sync:comment", async (_event, data) => {
      await this.addComment(data);
    });

    ipcOn(this.ipcMain, "game-sync:build", async (_event, data) => {
      await this.build(data);
    });

    ipcOn(this.ipcMain, "game-sync:generate-project-files", async () => {
      await this.generateProjectFiles();
    });

    ipcOn(this.ipcMain, "game-sync:clean:preview", async () => {
      await this.cleanPreview();
    });

    ipcOn(this.ipcMain, "game-sync:clean:execute", async (_event, data) => {
      await this.cleanExecute(data);
    });

    ipcOn(this.ipcMain, "game-sync:bisect:refresh", async () => {
      await this.refreshBisect();
    });

    ipcOn(this.ipcMain, "game-sync:bisect:mark", async (_event, data) => {
      await this.bisectMark(data);
    });

    ipcOn(this.ipcMain, "game-sync:bisect:reset", async () => {
      await this.bisectReset();
    });

    ipcOn(this.ipcMain, "game-sync:filter:preview", async (_event, data) => {
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
      const files = await client.workspaces.gameSync.cleanPreview.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });
      setWsRecord(gameSyncCleanAtom, workspace.id, files);
      if (this.webContents) {
        ipcSend(this.webContents, "game-sync:clean:preview:data", { files });
      }
    } catch (error) {
      console.error("Failed to preview Game Sync clean:", error);
    }
  }

  private async cleanExecute(
    data: Channels["game-sync:clean:execute"],
  ): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.gameSync.cleanExecute.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        paths: data.paths,
      });
      setWsRecord(gameSyncCleanAtom, workspace.id, []);
      await this.refreshStatus(client, workspace);
      await this.refreshHistory(client, workspace);
    } catch (error) {
      const message =
        (error as Error)?.message ?? "Failed to clean the workspace";
      if (this.webContents) {
        ipcSend(this.webContents, "game-sync:sync:error", { message });
      }
    }
  }

  // ─── Bisect (Phase 2/3) ──────────────────────────────────────────

  /** Fetch the bisect state, set the atom, and mirror it to the renderer. */
  private async emitBisect(
    client: DaemonClient,
    workspace: Workspace,
  ): Promise<void> {
    const state = await client.workspaces.gameSync.bisectGetState.query({
      daemonId: workspace.daemonId,
      workspaceId: workspace.id,
    });

    const bisect: Record<string, string> = {};
    for (const [cl, verdict] of Object.entries(state.bisect)) {
      bisect[cl] = verdict;
    }

    const value: GameSyncBisectState = { bisect, next: state.next };
    setWsRecord(gameSyncBisectAtom, workspace.id, value);
    if (this.webContents) {
      ipcSend(this.webContents, "game-sync:bisect:data", value);
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
      console.error("Failed to refresh Game Sync bisect:", error);
    }
  }

  private async bisectMark(
    data: Channels["game-sync:bisect:mark"],
  ): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.gameSync.bisectMark.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumber: data.changelistNumber,
        verdict: data.verdict,
      });
      await this.emitBisect(client, workspace);
      const changelists = getWsRecord(
        store.get(gameSyncChangelistsAtom),
        workspace.id,
      );
      await this.refreshMetadata(
        client,
        workspace,
        (changelists?.entries ?? []).map((entry) => entry.number),
      );
    } catch (error) {
      console.error("Failed to mark Game Sync bisect:", error);
    }
  }

  private async bisectReset(): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.gameSync.bisectReset.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });
      await this.emitBisect(client, workspace);
      const changelists = getWsRecord(
        store.get(gameSyncChangelistsAtom),
        workspace.id,
      );
      await this.refreshMetadata(
        client,
        workspace,
        (changelists?.entries ?? []).map((entry) => entry.number),
      );
    } catch (error) {
      console.error("Failed to reset Game Sync bisect:", error);
    }
  }

  // ─── Filter preview (Phase 2/3) ──────────────────────────────────

  private async filterPreview(
    data: Channels["game-sync:filter:preview"],
  ): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const result = await client.workspaces.gameSync.previewFilterChange.query(
        {
          daemonId: workspace.daemonId,
          workspaceId: workspace.id,
          settings: data.settings,
        },
      );
      setWsRecord(gameSyncFilterPreviewAtom, workspace.id, result);
      if (this.webContents) {
        ipcSend(this.webContents, "game-sync:filter:preview:data", result);
      }
    } catch (error) {
      console.error("Failed to preview Game Sync filter change:", error);
    }
  }

  // ─── Review actions ──────────────────────────────────────────────

  private async syncLatestGood(): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const result = await client.workspaces.gameSync.findLatestGood.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });

      if (!result) {
        if (this.webContents) {
          ipcSend(this.webContents, "game-sync:sync-latest-good:none", null);
        }
        return;
      }

      await this.sync({ changelistNumber: result.changelistNumber });
    } catch (error) {
      const message =
        (error as Error)?.message ?? "Failed to find the latest good CL";
      if (this.webContents) {
        ipcSend(this.webContents, "game-sync:sync:error", { message });
      }
    }
  }

  private async setVote(data: Channels["game-sync:vote"]): Promise<void> {
    await this.runReviewMutation((client, workspace) =>
      client.workspaces.gameSync.setVote.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumber: data.changelistNumber,
        vote: data.vote,
      }),
    );
  }

  private async setStar(data: Channels["game-sync:star"]): Promise<void> {
    await this.runReviewMutation((client, workspace) =>
      client.workspaces.gameSync.setStarred.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumber: data.changelistNumber,
        starred: data.starred,
      }),
    );
  }

  private async setInvestigating(
    data: Channels["game-sync:investigate"],
  ): Promise<void> {
    await this.runReviewMutation((client, workspace) =>
      client.workspaces.gameSync.setInvestigating.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumber: data.changelistNumber,
        investigating: data.investigating,
      }),
    );
  }

  private async addComment(data: Channels["game-sync:comment"]): Promise<void> {
    await this.runReviewMutation((client, workspace) =>
      client.workspaces.gameSync.addComment.mutate({
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
        store.get(gameSyncChangelistsAtom),
        workspace.id,
      );
      await this.refreshMetadata(
        client,
        workspace,
        (changelists?.entries ?? []).map((entry) => entry.number),
      );
    } catch (error) {
      console.error("Game Sync review mutation failed:", error);
    }
  }

  // ─── Entry / lifecycle ───────────────────────────────────────────

  private async enter(data: Channels["game-sync:enter"]): Promise<void> {
    if (this.isMocked) return;

    const workspace = this.getWorkspace(data.workspaceId);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();

      await this.refreshMode(client, workspace);
      await this.refreshConfig(client, workspace);
      await this.refreshSettings(client, workspace);
      await this.refreshStatus(client, workspace);
      await this.refreshHistory(client, workspace);

      this.startHeadPoll();
    } catch (error) {
      console.error("Failed to enter Game Sync:", error);
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
      await this.refreshSettings(client, workspace);
      await this.refreshStatus(client, workspace);
      await this.refreshHistory(client, workspace);
    } catch (error) {
      console.error("Failed to refresh Game Sync:", error);
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
      console.error("Game Sync head poll failed:", error);
    }
  }

  // ─── Atom refreshers ─────────────────────────────────────────────

  private async refreshMode(
    client: DaemonClient,
    workspace: Workspace,
  ): Promise<void> {
    try {
      const projectInfo = await client.workspaces.gameSync.getProjectInfo.query(
        {
          daemonId: workspace.daemonId,
          workspaceId: workspace.id,
        },
      );

      setWsRecord(gameSyncModeAtom, workspace.id, {
        detected: projectInfo != null,
        uprojectPath: projectInfo?.uprojectPath ?? null,
        projectName: projectInfo?.projectName ?? null,
      });
    } catch (error) {
      console.error("Failed to fetch Game Sync project info:", error);
      setWsRecord(gameSyncModeAtom, workspace.id, {
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
      const result = await client.workspaces.gameSync.getConfig.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });
      setWsRecord(gameSyncConfigAtom, workspace.id, result.config);
    } catch (error) {
      console.error("Failed to fetch Game Sync config:", error);
      setWsRecord(gameSyncConfigAtom, workspace.id, null);
    }
  }

  private async refreshSettings(
    client: DaemonClient,
    workspace: Workspace,
  ): Promise<void> {
    try {
      const settings = await client.workspaces.gameSync.getSettings.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
      });
      setWsRecord(
        gameSyncSettingsAtom,
        workspace.id,
        settings as GameSyncSettings,
      );
    } catch (error) {
      console.error("Failed to fetch Game Sync settings:", error);
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

      const previous = getWsRecord(store.get(gameSyncStatusAtom), workspace.id);

      setWsRecord(gameSyncStatusAtom, workspace.id, {
        syncedCl: syncStatus.localChangelistNumber,
        // TODO(phase2): populate applied precompiled-binary sets from the
        // daemon's artifact-apply state once that is exposed.
        appliedBinaries: previous?.appliedBinaries ?? [],
        lastSync: previous?.lastSync ?? null,
      });
    } catch (error) {
      console.error("Failed to fetch Game Sync status:", error);
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

      setWsRecord(gameSyncChangelistsAtom, workspace.id, {
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
      console.error("Failed to fetch Game Sync history:", error);
    }
  }

  /**
   * Fetch per-changelist metadata (badges, presence, artifact types) for the
   * loaded page. Degrades to empty when the org is not licensed for Game Sync.
   */
  private async refreshMetadata(
    client: DaemonClient,
    workspace: Workspace,
    changelistNumbers: number[],
  ): Promise<void> {
    if (changelistNumbers.length === 0) {
      setWsRecord(gameSyncMetadataAtom, workspace.id, {});
      return;
    }

    try {
      const meta = await client.workspaces.gameSync.getChangelistMeta.query({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        changelistNumbers,
      });
      setWsRecord(gameSyncMetadataAtom, workspace.id, meta);
    } catch (error) {
      console.error("Failed to fetch Game Sync metadata:", error);
      setWsRecord(gameSyncMetadataAtom, workspace.id, {});
    }
  }

  // ─── Sync pipeline ───────────────────────────────────────────────

  private async sync(data: Channels["game-sync:sync"]): Promise<void> {
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
      setWsRecord(gameSyncJobAtom, workspace.id, {
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
        ipcSend(this.webContents, "game-sync:sync:error", { message });
      }
    }
  }

  // ─── Build ───────────────────────────────────────────────────────

  private async build(data: Channels["game-sync:build"]): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const { jobId } = await client.workspaces.gameSync.build.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        forceClean: data.forceClean ?? false,
      });

      const startedAt = new Date().toISOString();
      setWsRecord(gameSyncJobAtom, workspace.id, {
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
        ipcSend(this.webContents, "game-sync:sync:error", { message });
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
        await client.workspaces.gameSync.generateProjectFiles.mutate({
          daemonId: workspace.daemonId,
          workspaceId: workspace.id,
        });

      const startedAt = new Date().toISOString();
      setWsRecord(gameSyncJobAtom, workspace.id, {
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
        ipcSend(this.webContents, "game-sync:sync:error", { message });
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

      setWsRecord(gameSyncJobAtom, workspace.id, {
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
        setWsRecord(gameSyncJobAtom, workspace.id, null);
        this.window?.setProgressBar(-1);

        const label = kind === "build" ? "Build" : "Sync";
        if (job.status === "failed") {
          if (this.webContents) {
            ipcSend(this.webContents, "game-sync:sync:error", {
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
        ipcSend(this.webContents, "game-sync:log:append", {
          jobId,
          startLine: logs.lines[0].seq,
          lines: logs.lines.map((entry) => entry.line),
        });
      }
      return logs.nextSeq;
    } catch (error) {
      console.error("Failed to read Game Sync job logs:", error);
      return afterSeq;
    }
  }

  private async cancelJob(
    data: Channels["game-sync:cancel-job"],
  ): Promise<void> {
    if (this.isMocked) return;

    try {
      const client = await CreateDaemonClient();
      await client.jobs.cancel.mutate({ jobId: data.jobId });
    } catch (error) {
      console.error("Failed to cancel Game Sync job:", error);
    }
  }

  private async updateSettings(
    data: Channels["game-sync:update-settings"],
  ): Promise<void> {
    if (this.isMocked) return;

    const workspace = store.get(currentWorkspaceAtom);
    if (!workspace) return;

    try {
      const client = await CreateDaemonClient();
      const merged = await client.workspaces.gameSync.updateSettings.mutate({
        daemonId: workspace.daemonId,
        workspaceId: workspace.id,
        settings: data.settings,
      });
      setWsRecord(
        gameSyncSettingsAtom,
        workspace.id,
        merged as GameSyncSettings,
      );
    } catch (error) {
      console.error("Failed to update Game Sync settings:", error);
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
      const projectInfo = await client.workspaces.gameSync.getProjectInfo.query(
        {
          daemonId: workspace.daemonId,
          workspaceId: workspace.id,
        },
      );

      // Settings are fetched so future phases can honor editorConfiguration /
      // afterSync; the exe name is currently derived from engineDir only.
      await client.workspaces.gameSync.getSettings.query({
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
      ipcSend(this.webContents, "game-sync:launch-editor:error", { message });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private getWorkspace(workspaceId: string): Workspace | null {
    const current = store.get(currentWorkspaceAtom);
    if (current && current.id === workspaceId) return current;
    console.warn(
      `Game Sync enter for ${workspaceId} but current workspace is ${
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
