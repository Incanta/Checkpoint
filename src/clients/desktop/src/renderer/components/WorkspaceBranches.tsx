import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceBranchesAtom,
  type BranchEntry,
} from "../../common/state/workspace";
import { currentUserAtom } from "../../common/state/auth";
import Button from "./Button";
import { Button as UiButton, Badge } from "./ui";
import { ipc } from "../pages/ipc";
import { TreeTable } from "primereact/treetable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TreeNode } from "primereact/treenode";
import { Column, ColumnPassThroughOptions } from "primereact/column";
import { ContextMenu } from "primereact/contextmenu";
import { MenuItem } from "primereact/menuitem";
import { Checkbox } from "primereact/checkbox";
import { Dialog } from "primereact/dialog";
import CreateBranchDialog from "./CreateBranchDialog";

function buildBranchTree(
  branches: BranchEntry[],
  currentBranchName: string,
): TreeNode[] {
  // Group branches by parent
  const byParent = new Map<string | null, BranchEntry[]>();
  for (const b of branches) {
    const parent = b.parentBranchName;
    if (!byParent.has(parent)) {
      byParent.set(parent, []);
    }
    byParent.get(parent)!.push(b);
  }

  function buildChildren(parentName: string | null): TreeNode[] {
    const children = byParent.get(parentName) || [];
    return children.map((b) => {
      const isCurrent = b.name === currentBranchName;
      const node: TreeNode = {
        id: b.id,
        key: b.id,
        data: {
          name: b.name,
          type: b.type.charAt(0) + b.type.slice(1).toLowerCase(),
          headNumber: b.headNumber,
          archived: b.archivedAt ? "Yes" : "",
          creator: b.createdBy?.email || b.createdBy?.name || "",
          isCurrent,
          branch: b,
        },
        children: buildChildren(b.name),
      };
      return node;
    });
  }

  // Root branches have no parent
  return buildChildren(null);
}

export default function WorkspaceBranches() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const branchesState = useAtomValue(workspaceBranchesAtom);
  const currentUser = useAtomValue(currentUserAtom);

  const treeTableRef = useRef<TreeTable>(null);
  const contextMenuRef = useRef<ContextMenu>(null);
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
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
    if (!currentWorkspace) {
      setNodes([]);
      return;
    }

    if (!branchesState) {
      setNodes([]);
      refreshBranches();
      return;
    }

    const filtered = showArchived
      ? branchesState.branches
      : branchesState.branches.filter((b) => !b.archivedAt);

    const tree = buildBranchTree(filtered, branchesState.currentBranchName);
    setNodes(tree);

    // Auto-expand all nodes
    const keys: Record<string, boolean> = {};
    const collectKeys = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.children && n.children.length > 0) {
          keys[n.key as string] = true;
          collectKeys(n.children);
        }
      }
    };
    collectKeys(tree);
    setExpandedKeys(keys);
  }, [currentWorkspace, branchesState, showArchived, refreshBranches]);

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
    (event: React.MouseEvent, node: TreeNode) => {
      event.preventDefault();
      const branch = node.data?.branch as BranchEntry;
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
          style: { color: "var(--color-danger)" },
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

  const nameTemplate = useCallback((node: TreeNode) => {
    const isCurrent = node.data?.isCurrent;
    return (
      <span style={{ fontWeight: isCurrent ? "bold" : "normal" }}>
        {node.data?.name}
      </span>
    );
  }, []);

  const typeTemplate = useCallback((node: TreeNode) => {
    const type = node.data?.type as string;
    const variants: Record<string, "info" | "success" | "warning"> = {
      Mainline: "info",
      Release: "success",
      Feature: "warning",
    };
    return <Badge variant={variants[type] ?? "default"}>{type}</Badge>;
  }, []);

  const columnPt = useMemo<ColumnPassThroughOptions>(
    () => ({
      headerCell: {
        style: {
          borderColor: "var(--color-border-default)",
          borderWidth: "0 1px 0 0",
          borderStyle: "solid",
          paddingLeft: "0.5rem",
        },
      },
      bodyCell: {
        style: {
          paddingLeft: "0.5rem",
        },
      },
      rowToggler: {
        className: "treetable-toggler",
        style: {
          backgroundColor: "transparent",
          padding: "0.4rem",
        },
      },
    }),
    [],
  );

  const contextMenuPt = useMemo(
    () => ({
      root: {
        style: {
          marginTop: "2rem",
          backgroundColor: "var(--color-bg-overlay)",
          border: "1px solid var(--color-border-default)",
          borderRadius: "0.5rem",
          minWidth: "200px",
        },
      },
      menu: {
        style: {
          backgroundColor: "var(--color-bg-overlay)",
        },
      },
      menuitem: {
        style: {
          margin: 0,
        },
      },
      action: {
        style: {
          color: "var(--color-text-secondary)",
          padding: "0.5rem 1rem",
          fontSize: "0.875rem",
        },
      },
      separator: {
        style: {
          borderColor: "var(--color-border-muted)",
        },
      },
      submenuIcon: {
        style: {
          color: "var(--color-text-secondary)",
        },
      },
    }),
    [],
  );

  const dialogPt = useMemo(
    () => ({
      root: {
        style: {
          backgroundColor: "var(--color-bg-secondary)",
          border: "1px solid var(--color-border-default)",
        },
      },
      header: {
        style: {
          backgroundColor: "var(--color-bg-secondary)",
          color: "var(--color-text-primary)",
          fontWeight: 600,
          borderBottom: "1px solid var(--color-border-default)",
        },
      },
      content: {
        style: {
          backgroundColor: "var(--color-bg-secondary)",
          color: "var(--color-text-secondary)",
          padding: "1.5rem",
        },
      },
      footer: {
        style: {
          backgroundColor: "var(--color-bg-secondary)",
          borderTop: "1px solid var(--color-border-default)",
          padding: "0.75rem",
        },
      },
    }),
    [],
  );

  const treeTablePt = useMemo(
    () => ({
      thead: {
        style: {
          borderColor: "var(--color-border-default)",
          borderWidth: "0 0 1px 0",
          borderStyle: "solid",
          paddingLeft: "0.5rem",
        },
      },
      scrollableWrapper: {
        style: {
          height: "100%",
        },
      },
      scrollable: {
        style: {
          height: "100%",
        },
      },
      scrollableBody: {
        style: {
          maxHeight: "initial",
        },
      },
      resizeHelper: {
        style: {
          width: "0.1rem",
          backgroundColor: "var(--color-text-muted)",
        },
      },
      tbody: {
        style: {
          cursor: "pointer",
        },
      },
    }),
    [],
  );

  return (
    <>
      <ContextMenu
        ref={contextMenuRef}
        model={menuItems}
        breakpoint="767px"
        pt={contextMenuPt}
      />
      <div className="grid h-full grid-rows-[2.5rem_1fr]">
        <div className="row-span-1 flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3">
          <UiButton variant="secondary" size="sm" onClick={refreshBranches}>
            Refresh
          </UiButton>
          <UiButton variant="primary" size="sm" onClick={handleNewBranch}>
            New Branch
          </UiButton>
          <div className="ml-4 flex items-center gap-2">
            <Checkbox
              inputId="show-archived"
              checked={showArchived}
              onChange={(e) => setShowArchived(!!e.checked)}
              pt={{
                box: {
                  style: {
                    backgroundColor: "var(--color-bg-surface)",
                    borderColor: "var(--color-border-default)",
                  },
                },
              }}
            />
            <label
              htmlFor="show-archived"
              style={{
                color: "var(--color-text-secondary)",
                fontSize: "0.8em",
                cursor: "pointer",
              }}
            >
              Show archived
            </label>
          </div>
        </div>
        <div
          className="row-span-1"
          style={{ textAlign: "left", overflow: "hidden" }}
          ref={tableWrapperRef}
        >
          <TreeTable
            ref={treeTableRef}
            value={nodes}
            expandedKeys={expandedKeys}
            onToggle={(e) => setExpandedKeys(e.value)}
            tableStyle={{ minWidth: "50rem" }}
            columnResizeMode="expand"
            resizableColumns
            showGridlines
            scrollable
            onContextMenu={(e) => {
              handleRowContextMenu(e.originalEvent as React.MouseEvent, e.node);
            }}
            pt={treeTablePt}
            style={{ height: "100%" }}
          >
            <Column
              field="name"
              header="Branch"
              expander
              resizeable
              sortable
              body={nameTemplate}
              pt={columnPt}
            />
            <Column
              field="type"
              header="Type"
              resizeable
              sortable
              body={typeTemplate}
              pt={columnPt}
            />
            <Column
              field="headNumber"
              header="Head CL"
              resizeable
              sortable
              pt={columnPt}
            />
            <Column
              field="archived"
              header="Archived"
              resizeable
              sortable
              pt={columnPt}
            />
            <Column
              field="creator"
              header="Creator"
              resizeable
              sortable
              pt={columnPt}
            />
          </TreeTable>
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
        onHide={() => {
          if (!deletePending) setDeleteDialogVisible(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              label="Cancel"
              onClick={() => setDeleteDialogVisible(false)}
              disabled={deletePending}
              className="p-[0.5rem] text-[0.9em]"
            />
            <Button
              label={deletePending ? "Deleting..." : "Delete"}
              onClick={handleDelete}
              disabled={deletePending}
              className="p-[0.5rem] text-[0.9em]"
            />
          </div>
        }
        pt={dialogPt}
      >
        <p>
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
        onHide={() => {
          if (!mergePending) setMergeDialogVisible(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              label="Cancel"
              onClick={() => setMergeDialogVisible(false)}
              disabled={mergePending}
              className="p-[0.5rem] text-[0.9em]"
            />
            <Button
              label={mergePending ? "Merging..." : "Merge"}
              onClick={handleMerge}
              disabled={mergePending}
              className="p-[0.5rem] text-[0.9em]"
            />
          </div>
        }
        pt={dialogPt}
      >
        <p>
          Merge <strong>&quot;{contextBranchRef.current?.name}&quot;</strong>{" "}
          into <strong>&quot;{branchesState?.currentBranchName}&quot;</strong>?
        </p>
        <p
          style={{
            color: "var(--color-text-muted)",
            fontSize: "0.85em",
            marginTop: "0.5rem",
          }}
        >
          This will create a squash merge changelist and delete the incoming
          branch.
        </p>
      </Dialog>
    </>
  );
}
