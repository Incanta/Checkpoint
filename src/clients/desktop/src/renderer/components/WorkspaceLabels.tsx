import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceLabelsAtom,
} from "../../common/state/workspace";
import {
  Button,
  ContextMenu,
  DataTable,
  Dialog,
  EmptyState,
  dialogFieldClass,
  dialogInputClass,
  type ContextMenuHandle,
  type MenuItem,
} from "./ui";
import { ipc } from "../pages/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import CreateLabelDialog from "./CreateLabelDialog";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTag } from "@fortawesome/free-solid-svg-icons";

interface LabelRow {
  id: string;
  label: string;
  changelist: number;
  message: string;
  /** Epoch ms, so sorting is chronological. */
  date: number;
  dateLabel: string;
  user: string;
}

const column = createColumnHelper<LabelRow>();

const columns = [
  column.accessor("label", {
    id: "label",
    header: "Label",
    meta: { measure: (row) => row.label },
  }),
  column.accessor("changelist", {
    id: "changelist",
    header: "Changelist",
    meta: { measure: (row) => String(row.changelist) },
  }),
  column.accessor("message", {
    id: "message",
    header: "Message",
    minSize: 200,
    cell: (info) => <span title={info.getValue()}>{info.getValue()}</span>,
    meta: { fill: true },
  }),
  column.accessor("date", {
    id: "date",
    header: "Date",
    cell: (info) => info.row.original.dateLabel,
    meta: { measure: (row) => row.dateLabel },
  }),
  column.accessor("user", {
    id: "user",
    header: "User",
    meta: { measure: (row) => row.user },
  }),
];

export default function WorkspaceLabels() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspaceLabels = useAtomValue(workspaceLabelsAtom);

  const contextMenuRef = useRef<ContextMenuHandle>(null);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const contextLabelRef = useRef<{
    id: string;
    name: string;
    changelist: number;
  } | null>(null);

  // Create label dialog state
  const [createLabelVisible, setCreateLabelVisible] = useState(false);

  // Delete confirmation dialog state
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  // Rename dialog state
  const [renameDialogVisible, setRenameDialogVisible] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Change changelist dialog state
  const [changeClDialogVisible, setChangeClDialogVisible] = useState(false);
  const [changeClNumber, setChangeClNumber] = useState("");
  const [changeClPending, setChangeClPending] = useState(false);
  const [changeClError, setChangeClError] = useState<string | null>(null);

  useEffect(() => {
    if (currentWorkspace && !workspaceLabels) {
      ipc.sendMessage("workspace:labels", null);
    }
  }, [currentWorkspace, workspaceLabels]);

  const rows = useMemo<LabelRow[]>(() => {
    if (!currentWorkspace || !workspaceLabels) return [];
    return workspaceLabels.map((label) => {
      const date = new Date(label.changelist.createdAt).getTime();
      return {
        id: label.id,
        label: label.name,
        changelist: label.changelist.number,
        message: label.changelist.message || "",
        date,
        dateLabel: isNaN(date) ? "" : new Date(date).toLocaleDateString(),
        user:
          label.changelist.user?.email ||
          label.changelist.user?.name ||
          "Unknown",
      };
    });
  }, [currentWorkspace, workspaceLabels]);

  // IPC listeners for label operations
  useEffect(() => {
    const unsubDeleteSuccess = ipc.on("workspace:delete-label:success", () => {
      setDeletePending(false);
      setDeleteDialogVisible(false);
      ipc.sendMessage("workspace:labels", null);
    });

    const unsubDeleteError = ipc.on("workspace:delete-label:error", () => {
      setDeletePending(false);
    });

    const unsubRenameSuccess = ipc.on("workspace:rename-label:success", () => {
      setRenamePending(false);
      setRenameDialogVisible(false);
      ipc.sendMessage("workspace:labels", null);
    });

    const unsubRenameError = ipc.on("workspace:rename-label:error", (data) => {
      setRenamePending(false);
      setRenameError(data.message);
    });

    const unsubChangeClSuccess = ipc.on(
      "workspace:change-label-changelist:success",
      () => {
        setChangeClPending(false);
        setChangeClDialogVisible(false);
        ipc.sendMessage("workspace:labels", null);
      },
    );

    const unsubChangeClError = ipc.on(
      "workspace:change-label-changelist:error",
      (data) => {
        setChangeClPending(false);
        setChangeClError(data.message);
      },
    );

    const unsubCreateSuccess = ipc.on("workspace:create-label:success", () => {
      ipc.sendMessage("workspace:labels", null);
    });

    return () => {
      unsubDeleteSuccess();
      unsubDeleteError();
      unsubRenameSuccess();
      unsubRenameError();
      unsubChangeClSuccess();
      unsubChangeClError();
      unsubCreateSuccess();
    };
  }, []);

  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, row: LabelRow) => {
      event.preventDefault();
      contextLabelRef.current = {
        id: row.id,
        name: row.label,
        changelist: row.changelist,
      };

      setMenuItems([
        {
          label: "Rename...",
          command: () => {
            if (contextLabelRef.current) {
              setRenameName(contextLabelRef.current.name);
              setRenameError(null);
              setRenameDialogVisible(true);
            }
          },
        },
        {
          label: "Change changelist...",
          command: () => {
            if (contextLabelRef.current) {
              setChangeClNumber(String(contextLabelRef.current.changelist));
              setChangeClError(null);
              setChangeClDialogVisible(true);
            }
          },
        },
        { separator: true },
        {
          label: "Delete",
          danger: true,
          command: () => {
            if (contextLabelRef.current) {
              setDeleteDialogVisible(true);
            }
          },
        },
      ]);
      contextMenuRef.current?.show(event);
    },
    [],
  );

  const handleDelete = useCallback(() => {
    if (!contextLabelRef.current) return;
    setDeletePending(true);
    ipc.sendMessage("workspace:delete-label", {
      labelId: contextLabelRef.current.id,
    });
  }, []);

  const handleRename = useCallback(() => {
    const trimmed = renameName.trim();
    if (!trimmed || !contextLabelRef.current) return;
    setRenamePending(true);
    setRenameError(null);
    ipc.sendMessage("workspace:rename-label", {
      labelId: contextLabelRef.current.id,
      newName: trimmed,
    });
  }, [renameName]);

  const handleChangeCl = useCallback(() => {
    const num = parseInt(changeClNumber, 10);
    if (isNaN(num) || num < 0 || !contextLabelRef.current) return;
    setChangeClPending(true);
    setChangeClError(null);
    ipc.sendMessage("workspace:change-label-changelist", {
      labelId: contextLabelRef.current.id,
      newNumber: num,
    });
  }, [changeClNumber]);

  const changeClValid =
    !!changeClNumber.trim() && !isNaN(parseInt(changeClNumber, 10));

  return (
    <>
      <ContextMenu ref={contextMenuRef} model={menuItems} />
      <div className="grid h-full grid-rows-[2.5rem_minmax(0,1fr)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              ipc.sendMessage("workspace:labels", null);
            }}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreateLabelVisible(true)}
          >
            Create Label
          </Button>
        </div>
        <div className="min-h-0 min-w-0 overflow-hidden">
          <DataTable
            data={rows}
            columns={columns}
            getRowId={(row) => row.id}
            storageKey="workspace-labels"
            onRowContextMenu={handleRowContextMenu}
            emptyState={
              workspaceLabels ? (
                <div className="flex justify-center py-12">
                  <EmptyState
                    icon={<FontAwesomeIcon icon={faTag} size="2x" />}
                    title="No Labels"
                    description="Labels name a changelist so it is easy to find again. Create one here, or from a changelist in the History tab."
                  />
                </div>
              ) : null
            }
          />
        </div>
      </div>

      {/* Create Label Dialog */}
      <CreateLabelDialog
        visible={createLabelVisible}
        changelistNumber={null}
        onHide={() => setCreateLabelVisible(false)}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog
        header="Delete Label"
        visible={deleteDialogVisible}
        style={{ width: "24rem" }}
        closable={!deletePending}
        onHide={() => {
          if (!deletePending) setDeleteDialogVisible(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setDeleteDialogVisible(false)}
              disabled={deletePending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={deletePending}
            >
              {deletePending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        }
      >
        <p className="m-0">
          Are you sure you want to delete the label{" "}
          <strong>&quot;{contextLabelRef.current?.name}&quot;</strong>?
        </p>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog
        header="Rename Label"
        visible={renameDialogVisible}
        style={{ width: "26rem" }}
        closable={!renamePending}
        onHide={() => {
          if (!renamePending) setRenameDialogVisible(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setRenameDialogVisible(false)}
              disabled={renamePending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleRename}
              disabled={renamePending || !renameName.trim()}
            >
              {renamePending ? "Renaming..." : "Rename"}
            </Button>
          </div>
        }
      >
        <label className={dialogFieldClass}>
          <span>New name</span>
          <input
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameName.trim()) handleRename();
            }}
            autoFocus
            disabled={renamePending}
            className={dialogInputClass}
          />
          {renameError && (
            <span className="text-[var(--color-danger)]">{renameError}</span>
          )}
        </label>
      </Dialog>

      {/* Change Changelist Dialog */}
      <Dialog
        header="Change Changelist"
        visible={changeClDialogVisible}
        style={{ width: "26rem" }}
        closable={!changeClPending}
        onHide={() => {
          if (!changeClPending) setChangeClDialogVisible(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setChangeClDialogVisible(false)}
              disabled={changeClPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleChangeCl}
              disabled={changeClPending || !changeClValid}
            >
              {changeClPending ? "Saving..." : "Save"}
            </Button>
          </div>
        }
      >
        <label className={dialogFieldClass}>
          <span>Changelist number</span>
          <input
            value={changeClNumber}
            onChange={(e) =>
              setChangeClNumber(e.target.value.replace(/\D/g, ""))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && changeClValid) handleChangeCl();
            }}
            inputMode="numeric"
            autoFocus
            disabled={changeClPending}
            className={dialogInputClass}
          />
          {changeClError && (
            <span className="text-[var(--color-danger)]">{changeClError}</span>
          )}
        </label>
      </Dialog>
    </>
  );
}
