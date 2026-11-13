import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceBranchesAtom,
  type BranchEntry,
} from "../../common/state/workspace";
import { currentUserAtom } from "../../common/state/auth";
import {
  Badge,
  Button,
  ContextMenu,
  DataTable,
  Dialog,
  type ContextMenuHandle,
  type MenuItem,
} from "./ui";
import { ipc } from "../pages/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper, type ExpandedState } from "@tanstack/react-table";
import CreateBranchDialog from "./CreateBranchDialog";

interface BranchRow {
  id: string;
  name: string;
  type: string;
  headNumber: number;
  archived: string;
  creator: string;
  isCurrent: boolean;
  branch: BranchEntry;
  children: BranchRow[];
}

const typeVariants: Record<string, "info" | "success" | "warning"> = {
  Mainline: "info",
  Release: "success",
  Feature: "warning",
};

const column = createColumnHelper<BranchRow>();

const columns = [
  column.accessor("name", {
    id: "name",
    header: "Branch",
    minSize: 160,
    cell: (info) => (
      <span
        title={info.getValue()}
        className={info.row.original.isCurrent ? "font-bold" : undefined}
      >
        {info.getValue()}
      </span>
    ),
    meta: { fill: true, expander: true },
  }),
  column.accessor("type", {
    id: "type",
    header: "Type",
    cell: (info) => (
      <Badge variant={typeVariants[info.getValue()] ?? "default"}>
        {info.getValue()}
      </Badge>
    ),
    // The badge's padding needs a little more than the bare text.
    meta: { measure: (row) => `${row.type}xxx` },
  }),
  column.accessor("headNumber", {
    id: "headNumber",
    header: "Head CL",
    meta: { measure: (row) => String(row.headNumber) },
  }),
  column.accessor("archived", {
    id: "archived",
    header: "Archived",
    meta: { measure: (row) => row.archived },
  }),
  column.accessor("creator", {
    id: "creator",
    header: "Creator",
    meta: { measure: (row) => row.creator },
  }),
];

function buildBranchTree(
  branches: BranchEntry[],
  currentBranchName: string,
): BranchRow[] {
  // Group branches by parent
  const byParent = new Map<string | null, BranchEntry[]>();
  for (const b of branches) {
    const parent = b.parentBranchName;
    if (!byParent.has(parent)) {
      byParent.set(parent, []);
    }
    byParent.get(parent)!.push(b);
  }

  function buildChildren(parentName: string | null): BranchRow[] {
    const children = byParent.get(parentName) || [];
    return children.map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type.charAt(0) + b.type.slice(1).toLowerCase(),
      headNumber: b.headNumber,
      archived: b.archivedAt ? "Yes" : "",
      creator: b.createdBy?.email || b.createdBy?.name || "",
      isCurrent: b.name === currentBranchName,
      branch: b,
      children: buildChildren(b.name),
    }));
  }

  // Root branches have no parent
  return buildChildren(null);
}

export default function WorkspaceBranches() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const branchesState = useAtomValue(workspaceBranchesAtom);
  const currentUser = useAtomValue(currentUserAtom);

  const contextMenuRef = useRef<ContextMenuHandle>(null);
  // Everything starts expanded, and again whenever the branches change;
  // the user can still collapse rows in between.
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const contextBranchRef = useRef<BranchEntry | null>(null);
  // The branch a delete was last asked for, to ask again with a discard.
  const deletingBranchRef = useRef<string | null>(null);
  // Branches whose last update from their parent stopped at conflicts, so
  // the menu can offer to update again with the resolutions.
  const updateConflictsRef = useRef<Set<string>>(new Set());
  const updatingBranchRef = useRef<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Create branch dialog
  const [createBranchVisible, setCreateBranchVisible] = useState(false);
  const [createBranchTarget, setCreateBranchTarget] = useState<{
    parentBranchName: string | null;
    headNumber: number;
    defaultType: "MAINLINE" | "RELEASE" | "FEATURE";
  } | null>(null);

  // Delete confirmation
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  // Merge confirmation
  const [mergeDialogVisible, setMergeDialogVisible] = useState(false);
  const [mergePending, setMergePending] = useState(false);

  const refreshBranches = useCallback(() => {
    ipc.sendMessage("workspace:branches", null);
  }, []);

  useEffect(() => {
    if (currentWorkspace && !branchesState) refreshBranches();
  }, [currentWorkspace, branchesState, refreshBranches]);

  const rows = useMemo<BranchRow[]>(() => {
    if (!currentWorkspace || !branchesState) return [];
    const filtered = showArchived
      ? branchesState.branches
      : branchesState.branches.filter((b) => !b.archivedAt);
    return buildBranchTree(filtered, branchesState.currentBranchName);
  }, [currentWorkspace, branchesState, showArchived]);

  useEffect(() => {
    setExpanded(true);
  }, [rows]);

  // IPC listeners
  useEffect(() => {
    const unsubCreateSuccess = ipc.on("workspace:create-branch:success", () => {
      setCreateBranchVisible(false);
      refreshBranches();
    });
    const unsubCreateError = ipc.on("workspace:create-branch:error", () => {
      // Error will be handled inside the dialog
    });
    const unsubSwitchSuccess = ipc.on("workspace:select-branch:success", () => {
      refreshBranches();
    });
    const unsubArchiveSuccess = ipc.on(
      "workspace:archive-branch:success",
      () => {
        refreshBranches();
      },
    );
    const unsubArchiveError = ipc.on(
      "workspace:archive-branch:error",
      () => {},
    );
    const unsubUnarchiveSuccess = ipc.on(
      "workspace:unarchive-branch:success",
      () => {
        refreshBranches();
      },
    );
    const unsubUnarchiveError = ipc.on(
      "workspace:unarchive-branch:error",
      () => {},
    );
    const unsubDeleteSuccess = ipc.on("workspace:delete-branch:success", () => {
      setDeletePending(false);
      setDeleteDialogVisible(false);
      refreshBranches();
    });
    const unsubDeleteError = ipc.on(
      "workspace:delete-branch:error",
      (data: unknown) => {
        setDeletePending(false);
        // A branch with changelists its parent never got is only deleted
        // when asked again, explicitly. Its head is kept either way.
        const message = (data as { message?: string } | null)?.message ?? "";
        const branchName = deletingBranchRef.current;
        if (
          branchName &&
          /never got/.test(message) &&
          window.confirm(
            `${message}\n\nDelete ${branchName} anyway and discard them? It can be restored later.`,
          )
        ) {
          setDeletePending(true);
          ipc.sendMessage("workspace:delete-branch", {
            branchName,
            discardUnmerged: true,
          });
        }
      },
    );
    const unsubMergeSuccess = ipc.on("workspace:merge-branch:success", () => {
      setMergePending(false);
      setMergeDialogVisible(false);
      refreshBranches();
      // Refresh history too since a merge CL was created
      ipc.sendMessage("workspace:history", null);
    });
    const unsubMergeError = ipc.on("workspace:merge-branch:error", () => {
      setMergePending(false);
    });
    const unsubUpdateSuccess = ipc.on(
      "workspace:update-branch:success",
      (data: unknown) => {
        if (updatingBranchRef.current) {
          updateConflictsRef.current.delete(updatingBranchRef.current);
        }
        refreshBranches();
        ipc.sendMessage("workspace:history", null);
        window.alert((data as { message: string }).message);
      },
    );
    const unsubUpdateError = ipc.on(
      "workspace:update-branch:error",
      (data: unknown) => {
        const { message, conflicts } = data as {
          message: string;
          conflicts: boolean;
        };
        if (conflicts && updatingBranchRef.current) {
          updateConflictsRef.current.add(updatingBranchRef.current);
          window.alert(
            `${message}\n\nResolve each of these on ${updatingBranchRef.current} and submit them there, then choose "Update from parent, keeping my resolutions".`,
          );
        } else {
          window.alert(message);
        }
      },
    );

    return () => {
      unsubUpdateSuccess();
      unsubUpdateError();
      unsubCreateSuccess();
      unsubCreateError();
      unsubSwitchSuccess();
      unsubArchiveSuccess();
      unsubArchiveError();
      unsubUnarchiveSuccess();
      unsubUnarchiveError();
      unsubDeleteSuccess();
      unsubDeleteError();
      unsubMergeSuccess();
      unsubMergeError();
    };
  }, [refreshBranches]);

  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, row: BranchRow) => {
      event.preventDefault();
      const branch = row.branch;
      contextBranchRef.current = branch;

      const items: MenuItem[] = [];
      const isCurrentBranch = branchesState?.currentBranchName === branch.name;
      const userId = currentUser?.details?.id;
      const isCreator = branch.createdById === userId;
      // Assume admin for now (the server will enforce permissions)
      const isAdmin = true;
      const isArchived = !!branch.archivedAt;

      // Switch branch
      if (!isCurrentBranch && !isArchived) {
        items.push({
          label: "Switch to this branch",
          command: () => {
            ipc.sendMessage("workspace:select-branch", { name: branch.name });
          },
        });
      }

      // Create child branch
      if (!isArchived && branch.type !== "FEATURE") {
        items.push({
          label: "Create branch",
          command: () => {
            setCreateBranchTarget({
              parentBranchName: branch.name,
              headNumber: branch.headNumber,
              defaultType: "FEATURE",
            });
            setCreateBranchVisible(true);
          },
        });
      }

      // Merge (only available on context of a feature branch whose parent is the current branch)
      if (
        !isArchived &&
        branch.type === "FEATURE" &&
        branch.parentBranchName === branchesState?.currentBranchName
      ) {
        const currentBranch = branchesState?.branches.find(
          (b) => b.name === branchesState.currentBranchName,
        );
        if (
          currentBranch &&
          (currentBranch.type === "MAINLINE" ||
            currentBranch.type === "RELEASE")
        ) {
          items.push({
            label: `Merge into ${branchesState.currentBranchName}`,
            command: () => {
              setMergeDialogVisible(true);
            },
          });
        }
      }

      if (items.length > 0) {
        items.push({ separator: true });
      }

      // Archive / Unarchive
      if (!branch.isDefault) {
        if (isArchived) {
          if (isAdmin || (isCreator && branch.type === "FEATURE")) {
            items.push({
              label: "Unarchive",
              command: () => {
                ipc.sendMessage("workspace:unarchive-branch", {
                  branchName: branch.name,
                });
              },
            });
          }
        } else {
          if (isAdmin || (isCreator && branch.type === "FEATURE")) {
            items.push({
              label: "Archive",
              command: () => {
                ipc.sendMessage("workspace:archive-branch", {
                  branchName: branch.name,
                });
              },
            });
          }
        }
      }

      // Update from parent (feature branches): brings what the parent
      // changed into the branch, so it can merge without meeting it again.
      if (branch.type === "FEATURE" && branch.parentBranchName && !isArchived) {
        items.push({
          label: `Update from ${branch.parentBranchName}`,
          command: () => {
            updatingBranchRef.current = branch.name;
            ipc.sendMessage("workspace:update-branch", {
              branchName: branch.name,
            });
          },
        });
        if (updateConflictsRef.current.has(branch.name)) {
          items.push({
            label: `Update from ${branch.parentBranchName}, keeping my resolutions`,
            command: () => {
              updatingBranchRef.current = branch.name;
              ipc.sendMessage("workspace:update-branch", {
                branchName: branch.name,
                resolvedInLatest: true,
              });
            },
          });
        }
      }

      // Delete (only feature branches)
      if (branch.type === "FEATURE" && (isAdmin || isCreator)) {
        items.push({
          label: "Delete",
          danger: true,
          command: () => {
            setDeleteDialogVisible(true);
          },
        });
      }

      setMenuItems(items);
      if (items.length > 0) {
        contextMenuRef.current?.show(event);
      }
    },
    [branchesState, currentUser],
  );

  const handleNewBranch = useCallback(() => {
    if (!branchesState) return;
    const currentBranch = branchesState.branches.find(
      (b) => b.name === branchesState.currentBranchName,
    );
    if (!currentBranch) return;

    // If current is a feature branch, parent the same mainline/release
    const parentName =
      currentBranch.type === "FEATURE"
        ? currentBranch.parentBranchName
        : currentBranch.name;

    setCreateBranchTarget({
      parentBranchName: parentName,
      headNumber: currentBranch.headNumber,
      defaultType: "FEATURE",
    });
    setCreateBranchVisible(true);
  }, [branchesState]);

  const handleDelete = useCallback(() => {
    if (!contextBranchRef.current) return;
    setDeletePending(true);
    deletingBranchRef.current = contextBranchRef.current.name;
    ipc.sendMessage("workspace:delete-branch", {
      branchName: contextBranchRef.current.name,
    });
  }, []);

  const handleMerge = useCallback(() => {
    if (!contextBranchRef.current) return;
    setMergePending(true);
    ipc.sendMessage("workspace:merge-branch", {
      incomingBranchName: contextBranchRef.current.name,
    });
  }, []);

  return (
    <>
      <ContextMenu ref={contextMenuRef} model={menuItems} />
      <div className="grid h-full grid-rows-[2.5rem_minmax(0,1fr)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3">
          <Button variant="secondary" size="sm" onClick={refreshBranches}>
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={handleNewBranch}>
            New Branch
          </Button>
          <div className="ml-4 flex items-center gap-2">
            <input
              id="show-archived"
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="m-0 cursor-pointer accent-[var(--color-accent)]"
            />
            <label
              htmlFor="show-archived"
              className="cursor-pointer text-[0.8em] text-[var(--color-text-secondary)]"
            >
              Show archived
            </label>
          </div>
        </div>
        <div className="min-h-0 min-w-0 overflow-hidden">
          <DataTable
            data={rows}
            columns={columns}
            getRowId={(row) => row.id}
            storageKey="workspace-branches"
            getSubRows={(row) => row.children}
            expanded={expanded}
            onExpandedChange={setExpanded}
            onRowContextMenu={handleRowContextMenu}
            getRowClassName={(row) =>
              row.isCurrent ? "text-[var(--color-text-primary)]" : ""
            }
          />
        </div>
      </div>

      {/* Create Branch Dialog */}
      <CreateBranchDialog
        visible={createBranchVisible}
        onHide={() => setCreateBranchVisible(false)}
        defaultParentBranchName={createBranchTarget?.parentBranchName ?? null}
        defaultHeadNumber={createBranchTarget?.headNumber ?? 0}
        defaultType={createBranchTarget?.defaultType ?? "FEATURE"}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog
        header="Delete Branch"
        visible={deleteDialogVisible}
        style={{ width: "26rem" }}
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
          Are you sure you want to delete the branch{" "}
          <strong>&quot;{contextBranchRef.current?.name}&quot;</strong>? This
          cannot be undone.
        </p>
      </Dialog>

      {/* Merge Confirmation Dialog */}
      <Dialog
        header="Merge Branch"
        visible={mergeDialogVisible}
        style={{ width: "28rem" }}
        closable={!mergePending}
        onHide={() => {
          if (!mergePending) setMergeDialogVisible(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setMergeDialogVisible(false)}
              disabled={mergePending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleMerge}
              disabled={mergePending}
            >
              {mergePending ? "Merging..." : "Merge"}
            </Button>
          </div>
        }
      >
        <p className="m-0">
          Merge <strong>&quot;{contextBranchRef.current?.name}&quot;</strong>{" "}
          into <strong>&quot;{branchesState?.currentBranchName}&quot;</strong>?
        </p>
        <p className="mb-0 mt-2 text-[0.85em] text-[var(--color-text-muted)]">
          This will create a squash merge changelist and delete the incoming
          branch.
        </p>
      </Dialog>
    </>
  );
}
