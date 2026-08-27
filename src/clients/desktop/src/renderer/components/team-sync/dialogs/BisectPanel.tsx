import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { currentWorkspaceAtom } from "../../../../common/state/workspace";
import {
  teamSyncBisectAtom,
  teamSyncJobAtom,
  teamSyncStatusAtom,
  getWsRecord,
} from "../../../../common/state/team-sync";
import { ipc } from "../../../pages/ipc";
import { Button } from "../../ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons/faMagnifyingGlass";
import { faXmark } from "@fortawesome/free-solid-svg-icons/faXmark";

export interface BisectPanelProps {
  /** Show the banner even before any verdicts exist, so a bisect can start. */
  forceShow?: boolean;
  /** Dismiss the forced banner (only meaningful when no bisect is active). */
  onClose?: () => void;
}

/**
 * Non-modal banner shown at the top of the Team Sync page while a bisect is in
 * progress. Drives the standard "sync -> test -> mark good/bad" loop that
 * isolates the changelist that introduced a regression.
 */
export default function BisectPanel({
  forceShow = false,
  onClose,
}: BisectPanelProps): React.ReactElement | null {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const bisectRecord = useAtomValue(teamSyncBisectAtom);
  const statusRecord = useAtomValue(teamSyncStatusAtom);
  const jobRecord = useAtomValue(teamSyncJobAtom);
  const workspaceId = currentWorkspace?.id ?? null;

  // Pull the current bisect state on mount so a bisect started elsewhere (or in
  // a previous session) is reflected without needing a user action.
  useEffect(() => {
    if (!workspaceId) return;
    ipc.sendMessage("team-sync:bisect:refresh", null);
  }, [workspaceId]);

  const bisect = getWsRecord(bisectRecord, workspaceId);
  const status = getWsRecord(statusRecord, workspaceId);
  const job = getWsRecord(jobRecord, workspaceId);

  // A bisect is "active" once any verdict has been recorded.
  const hasVerdicts = bisect != null && Object.keys(bisect.bisect).length > 0;
  if (!hasVerdicts && !forceShow) return null;

  const next = bisect?.next ?? {
    nextCl: null,
    remaining: 0,
    low: null,
    high: null,
  };
  const busy = job != null;
  const syncedCl = status?.syncedCl ?? null;

  const bounded = next.low != null && next.high != null;

  const handleSyncNext = (): void => {
    if (next.nextCl == null) return;
    ipc.sendMessage("team-sync:sync", { changelistNumber: next.nextCl });
  };

  const handleMark = (verdict: "pass" | "fail"): void => {
    if (syncedCl == null) return;
    ipc.sendMessage("team-sync:bisect:mark", {
      changelistNumber: syncedCl,
      verdict,
    });
  };

  const handleReset = (): void => {
    ipc.sendMessage("team-sync:bisect:reset", null);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-warning-bg,rgba(217,119,6,0.12))] px-4 py-2.5">
      <span className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-primary)]">
        <FontAwesomeIcon
          icon={faMagnifyingGlass}
          className="text-[var(--color-warning-fg,#d97706)]"
        />
        Bisecting
      </span>

      <span className="text-xs text-[var(--color-text-secondary)]">
        {bounded ? (
          <>
            good CL <span className="font-mono">{next.low}</span> … bad CL{" "}
            <span className="font-mono">{next.high}</span>
            {next.nextCl != null ? (
              <>
                , next: CL <span className="font-mono">{next.nextCl}</span> (~
                {next.remaining} left)
              </>
            ) : (
              <> (range narrowed to the first bad changelist)</>
            )}
          </>
        ) : (
          <>Mark a good and a bad changelist to bound the search.</>
        )}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSyncNext}
          disabled={busy || next.nextCl == null}
          title="Sync to the next changelist to test"
        >
          Sync to next
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => handleMark("pass")}
          disabled={busy || syncedCl == null}
          title={
            syncedCl == null
              ? "Sync to a changelist first"
              : `Mark CL ${syncedCl} good`
          }
        >
          Mark good
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => handleMark("fail")}
          disabled={busy || syncedCl == null}
          title={
            syncedCl == null
              ? "Sync to a changelist first"
              : `Mark CL ${syncedCl} bad`
          }
        >
          Mark bad
        </Button>
        <Button variant="ghost" size="sm" onClick={handleReset}>
          Reset
        </Button>
        {!hasVerdicts && onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Hide"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        )}
      </div>
    </div>
  );
}
