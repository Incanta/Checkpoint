import { useAtomValue } from "jotai";
import { currentWorkspaceAtom } from "../../../common/state/workspace";
import {
  gameSyncJobAtom,
  gameSyncModeAtom,
  gameSyncStatusAtom,
  getWsRecord,
} from "../../../common/state/game-sync";
import { ipc } from "../../pages/ipc";
import { Badge, Button } from "../ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCodeBranch } from "@fortawesome/free-solid-svg-icons/faCodeBranch";
import { faGear } from "@fortawesome/free-solid-svg-icons/faGear";
import { faBroom } from "@fortawesome/free-solid-svg-icons/faBroom";
import { faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons/faMagnifyingGlass";

export interface StatusPanelProps {
  onOpenSettings?: () => void;
  onOpenClean?: () => void;
  onToggleBisect?: () => void;
}

export default function StatusPanel({
  onOpenSettings,
  onOpenClean,
  onToggleBisect,
}: StatusPanelProps): React.ReactElement | null {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const modeRecord = useAtomValue(gameSyncModeAtom);
  const statusRecord = useAtomValue(gameSyncStatusAtom);
  const jobRecord = useAtomValue(gameSyncJobAtom);

  if (!currentWorkspace) return null;

  const mode = getWsRecord(modeRecord, currentWorkspace.id);
  const status = getWsRecord(statusRecord, currentWorkspace.id);
  const job = getWsRecord(jobRecord, currentWorkspace.id);

  const projectName = mode?.projectName || currentWorkspace.name || "Game Sync";
  const busy = job != null;

  const handleSyncLatest = (): void => {
    ipc.sendMessage("game-sync:sync", { changelistNumber: null });
  };

  const handleSyncLatestGood = (): void => {
    ipc.sendMessage("game-sync:sync-latest-good", null);
  };

  const handleBuild = (): void => {
    ipc.sendMessage("game-sync:build", {});
  };

  const handleLaunchEditor = (): void => {
    ipc.sendMessage("game-sync:launch-editor", {});
  };

  const handleCancel = (): void => {
    if (job) {
      ipc.sendMessage("game-sync:cancel-job", { jobId: job.jobId });
    }
  };

  const progressPercent =
    job?.progress && job.progress.total > 0
      ? Math.round(
          (Math.min(job.progress.done, job.progress.total) /
            job.progress.total) *
            100,
        )
      : 0;

  return (
    <div className="border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-base font-semibold text-[var(--color-text-primary)]">
          {projectName}
        </span>

        <Badge variant="default" className="gap-1.5">
          <FontAwesomeIcon
            icon={faCodeBranch}
            style={{ color: "var(--color-branches)" }}
          />
          {currentWorkspace.branchName}
        </Badge>

        {status?.syncedCl != null && (
          <Badge variant="info">Synced CL {status.syncedCl}</Badge>
        )}

        {status && status.appliedBinaries.length > 0 && (
          <Badge variant="accent">
            {status.appliedBinaries.length} binary set
            {status.appliedBinaries.length === 1 ? "" : "s"}
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSyncLatest}
            disabled={busy}
          >
            Sync Latest
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSyncLatestGood}
            disabled={busy}
            title="Sync to the newest changelist whose required badges are green"
          >
            Sync Latest Good
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleBuild}
            disabled={busy}
            title="Run configured build steps (compile)"
          >
            Build
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleLaunchEditor}
            disabled={busy || mode?.detected === false}
          >
            Launch Editor
          </Button>

          <div className="ml-1 flex items-center gap-1 border-l border-[var(--color-border-default)] pl-2">
            {onToggleBisect && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggleBisect}
                title="Bisect to find a bad changelist"
              >
                <FontAwesomeIcon icon={faMagnifyingGlass} />
              </Button>
            )}
            {onOpenClean && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenClean}
                title="Clean workspace"
              >
                <FontAwesomeIcon icon={faBroom} />
              </Button>
            )}
            {onOpenSettings && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenSettings}
                title="Game Sync settings"
              >
                <FontAwesomeIcon icon={faGear} />
              </Button>
            )}
          </div>
        </div>
      </div>

      {status && status.appliedBinaries.length > 0 && (
        <div className="mt-2 text-xs text-[var(--color-text-muted)]">
          Applied binaries:{" "}
          {status.appliedBinaries
            .map((b) => `${b.type} @ CL ${b.changelistNumber}`)
            .join(", ")}
        </div>
      )}

      {busy && job && (
        <div className="mt-3 flex items-center gap-3">
          <span className="whitespace-nowrap text-xs text-[var(--color-info)]">
            {job.currentStep || "Starting..."}
          </span>
          <div className="h-1.5 min-w-[80px] flex-1 overflow-hidden rounded-full bg-[var(--color-bg-surface)]">
            <div
              className="h-full rounded-full bg-[var(--color-info)] transition-[width] duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="whitespace-nowrap text-xs text-[var(--color-text-muted)]">
            {progressPercent}%
          </span>
          <Button variant="danger" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
