import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceBranchesAtom,
  type BranchEntry,
} from "../../common/state/workspace";
import { currentUserAtom } from "../../common/state/auth";
import Button from "./Button";
import { ipc } from "../pages/ipc";
import { TreeTable } from "primereact/treetable";
import { useCallback, useEffect, useRef, useState } from "react";
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
    const unsubDeleteError = ipc.on("workspace:delete-branch:error", () => {
      setDeletePending(false);
    });
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

    return () => {
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
      // Assume admin for now — the server will enforce permissions
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

      // Delete (only feature branches)
      if (branch.type === "FEATURE" && (isAdmin || isCreator)) {
        items.push({
          label: "Delete",
          style: { color: "#ff6b6b" },
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
    const colors: Record<string, string> = {
      Mainline: "#6bb5ff",
      Release: "#a0e86b",
      Feature: "#e8c36b",
    };
    return <span style={{ color: colors[type] || "#ccc" }}>{type}</span>;
  }, []);

  const columnPt: ColumnPassThroughOptions = {
    headerCell: {
      style: {
        borderColor: "var(--color-border)",
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
  };

  const contextMenuPt = {
    root: {
      style: {
        marginTop: "2rem",
        backgroundColor: "var(--color-panel)",
        border: "1px solid var(--color-border-light)",
        borderRadius: "4px",
        minWidth: "200px",
      },
    },
    menu: {
      style: {
        backgroundColor: "var(--color-panel)",
      },
    },
    menuitem: {
      style: {
        margin: 0,
      },
    },
    action: {
      style: {
        color: "#e0e0e0",
        padding: "0.5rem 1rem",
        fontSize: "0.875rem",
      },
    },
    separator: {
      style: {
        borderColor: "var(--color-border-light)",
      },
    },
    submenuIcon: {
      style: {
        color: "#e0e0e0",
      },
    },
  };

  const dialogPt = {
    root: {
      style: {
        backgroundColor: "var(--color-panel)",
        border: "1px solid var(--color-border)",
      },
    },
    header: {
      style: {
        backgroundColor: "var(--color-panel)",
        color: "var(--color-text-secondary)",
        borderBottom: "1px solid var(--color-border)",
      },
    },
    content: {
      style: {
        backgroundColor: "var(--color-panel)",
        color: "var(--color-text-secondary)",
        padding: "1.5rem",
      },
    },
    footer: {
      style: {
        backgroundColor: "var(--color-panel)",
        borderTop: "1px solid var(--color-border)",
        padding: "0.75rem",
      },
    },
  };

  return (
    <>
      <ContextMenu
        ref={contextMenuRef}
        model={menuItems}
        breakpoint="767px"
        pt={contextMenuPt}
      />
      <div className="grid grid-rows-[2.5rem_calc(100vh-8.5rem)] gap-4">
        <div
          className="row-span-1 space-x-[0.3rem] flex items-center"
          style={{
            backgroundColor: "var(--color-panel)",
            borderColor: "var(--color-border)",
            borderWidth: "0 0 1px 0",
            borderStyle: "solid",
            padding: "0.3rem",
          }}
        >
          <Button
            className="p-[0.3rem] text-[0.8em]"
            label="Refresh"
            onClick={refreshBranches}
          />
          <Button
            className="p-[0.3rem] text-[0.8em]"
            label="New Branch"
            onClick={handleNewBranch}
          />
          <div className="flex items-center ml-4" style={{ gap: "0.3rem" }}>
            <Checkbox
              inputId="show-archived"
              checked={showArchived}
              onChange={(e) => setShowArchived(!!e.checked)}
              pt={{
                box: {
                  style: {
                    backgroundColor: "var(--color-surface)",
                    borderColor: "var(--color-border-light)",
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
            pt={{
              thead: {
                style: {
                  borderColor: "var(--color-border)",
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
                  backgroundColor: "var(--color-border-lighter)",
                },
              },
              tbody: {
                style: {
                  cursor: "pointer",
                },
              },
            }}
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
        <p style={{ color: "#aaa", fontSize: "0.85em", marginTop: "0.5rem" }}>
          This will create a squash merge changelist and delete the incoming
          branch.
        </p>
      </Dialog>
    </>
  );
}
