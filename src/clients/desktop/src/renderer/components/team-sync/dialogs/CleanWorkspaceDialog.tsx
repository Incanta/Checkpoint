import { useEffect, useMemo, useState } from "react";
import { Dialog } from "primereact/dialog";
import { useAtomValue } from "jotai";
import { currentWorkspaceAtom } from "../../../../common/state/workspace";
import {
  teamSyncCleanAtom,
  getWsRecord,
  type TeamSyncCleanFile,
} from "../../../../common/state/team-sync";
import { ipc } from "../../../pages/ipc";
import { Button } from "../../ui";
import { CheckRow, formatBytes, teamSyncDialogPt } from "./shared";

export interface CleanWorkspaceDialogProps {
  visible: boolean;
  onHide: () => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  intermediate: "Intermediate / derived",
  untracked: "Untracked",
};

/**
 * Preview and delete leftover intermediate/untracked files (UGS's "Clean
 * Workspace"). Intermediate files are pre-selected; untracked files are shown
 * but must be opted into since they could be work in progress.
 */
export default function CleanWorkspaceDialog({
  visible,
  onHide,
}: CleanWorkspaceDialogProps): React.ReactElement {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const cleanRecord = useAtomValue(teamSyncCleanAtom);
  const files = getWsRecord(cleanRecord, currentWorkspace?.id);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [requestedAt, setRequestedAt] = useState<number | null>(null);

  // Ask main for a fresh preview each time the dialog opens.
  useEffect(() => {
    if (!visible) return;
    setRequestedAt(Date.now());
    ipc.sendMessage("team-sync:clean:preview", null);
  }, [visible]);

  // Default selection: intermediate files checked, untracked unchecked.
  useEffect(() => {
    if (!visible || !files) return;
    const next: Record<string, boolean> = {};
    for (const file of files) {
      next[file.path] = file.category === "intermediate";
    }
    setSelected(next);
  }, [visible, files]);

  const groups = useMemo(() => {
    const byCategory = new Map<string, TeamSyncCleanFile[]>();
    for (const file of files ?? []) {
      const list = byCategory.get(file.category) ?? [];
      list.push(file);
      byCategory.set(file.category, list);
    }
    return Array.from(byCategory.entries());
  }, [files]);

  const selectedPaths = useMemo(
    () => (files ?? []).filter((f) => selected[f.path]).map((f) => f.path),
    [files, selected],
  );

  const selectedSize = useMemo(
    () =>
      (files ?? [])
        .filter((f) => selected[f.path])
        .reduce((sum, f) => sum + f.size, 0),
    [files, selected],
  );

  const toggle = (path: string): void => {
    setSelected((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleCategory = (category: string, value: boolean): void => {
    setSelected((prev) => {
      const next = { ...prev };
      for (const file of files ?? []) {
        if (file.category === category) next[file.path] = value;
      }
      return next;
    });
  };

  const handleDelete = (): void => {
    if (selectedPaths.length === 0) return;
    ipc.sendMessage("team-sync:clean:execute", { paths: selectedPaths });
    onHide();
  };

  const loading = requestedAt != null && files == null;

  return (
    <Dialog
      header="Clean Workspace"
      visible={visible}
      onHide={onHide}
      modal
      dismissableMask
      style={{ width: "40rem" }}
      pt={teamSyncDialogPt}
      footer={
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs text-[var(--color-text-muted)]">
            {selectedPaths.length} file
            {selectedPaths.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(selectedSize)}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onHide}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={selectedPaths.length === 0}
            >
              Delete selected
            </Button>
          </div>
        </div>
      }
    >
      <div className="max-h-[26rem] overflow-auto p-5">
        {loading ? (
          <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
            Scanning workspace…
          </div>
        ) : (files?.length ?? 0) === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
            Nothing to clean. The workspace has no leftover files.
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map(([category, catFiles]) => (
              <div key={category}>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                    {CATEGORY_LABELS[category] ?? category} ({catFiles.length})
                  </span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => toggleCategory(category, true)}
                      className="cursor-pointer border-0 bg-transparent text-xs text-[var(--color-accent)] hover:underline"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleCategory(category, false)}
                      className="cursor-pointer border-0 bg-transparent text-xs text-[var(--color-text-muted)] hover:underline"
                    >
                      None
                    </button>
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {catFiles.map((file) => (
                    <CheckRow
                      key={file.path}
                      checked={!!selected[file.path]}
                      onChange={() => toggle(file.path)}
                      label={
                        <span className="flex items-center justify-between gap-3">
                          <span className="truncate font-mono text-xs">
                            {file.path}
                          </span>
                          <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                            {formatBytes(file.size)}
                          </span>
                        </span>
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
