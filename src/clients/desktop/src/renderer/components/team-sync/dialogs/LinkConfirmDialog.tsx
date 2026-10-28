import { Dialog } from "primereact/dialog";
import { useAtomValue } from "jotai";
import { currentWorkspaceAtom } from "../../../../common/state/workspace";
import {
  teamSyncLinkConfirmAtom,
  getWsRecord,
} from "../../../../common/state/team-sync";
import { ipc } from "../../../pages/ipc";
import { Button } from "../../ui";
import { confirmReasons } from "../links";
import { teamSyncDialogPt } from "./shared";

/**
 * Shown when a sync stopped before moving linked repos that need the user's
 * go-ahead (local changes, ahead of the pin, or held by another workspace).
 * Nothing was synced; each choice resends the same sync.
 */
export default function LinkConfirmDialog(): React.ReactElement | null {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const confirmRecord = useAtomValue(teamSyncLinkConfirmAtom);
  const pending = getWsRecord(confirmRecord, currentWorkspace?.id);
  if (!pending) return null;

  const target =
    pending.changelistNumber == null
      ? "the latest changelist"
      : `changelist ${pending.changelistNumber}`;

  const dismiss = (): void => {
    ipc.sendMessage("team-sync:link-confirm:dismiss", null);
  };

  const moveAndSync = (): void => {
    ipc.sendMessage("team-sync:sync", {
      changelistNumber: pending.changelistNumber,
      confirmLinks: pending.links.map((l) => l.repo),
    });
  };

  const syncAlone = (): void => {
    ipc.sendMessage("team-sync:sync", {
      changelistNumber: pending.changelistNumber,
      skipLinks: true,
    });
  };

  return (
    <Dialog
      header="Move linked repos?"
      visible
      onHide={dismiss}
      modal
      style={{ width: "36rem" }}
      pt={teamSyncDialogPt}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={dismiss}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={syncAlone}
            title="Sync this workspace and leave its linked repos where they are. It may not build against them."
          >
            Sync without them
          </Button>
          <Button onClick={moveAndSync}>Move and sync</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="text-sm text-[var(--color-text-secondary)]">
          Syncing {currentWorkspace?.name ?? "this workspace"} to {target} moves
          these linked repos first. Nothing has synced yet.
        </div>
        {pending.links.map((link) => (
          <div
            key={link.repo}
            className="flex flex-col gap-1 border-b border-[var(--color-border-muted)] pb-3"
          >
            <div className="text-sm text-[var(--color-text-primary)]">
              <span className="font-medium">{link.repo}</span>
              {link.workspaceName && (
                <span className="text-[var(--color-text-muted)]">
                  {" "}
                  ({link.workspaceName})
                </span>
              )}
              : changelist {link.fromChangelist ?? "?"} to {link.pin}
            </div>
            <ul className="m-0 list-disc pl-5 text-xs text-[var(--color-text-secondary)]">
              {confirmReasons(link).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
