import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceLabelsAtom,
} from "../../common/state/workspace";
import Button from "./Button";
import { ipc } from "../pages/ipc";
import { TreeTable } from "primereact/treetable";
import { useCallback, useEffect, useRef, useState } from "react";
import { TreeNode } from "primereact/treenode";
import { Column, ColumnPassThroughOptions } from "primereact/column";
import { ContextMenu } from "primereact/contextmenu";
import { MenuItem } from "primereact/menuitem";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import CreateLabelDialog from "./CreateLabelDialog";

export default function WorkspaceLabels() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspaceLabels = useAtomValue(workspaceLabelsAtom);

  const treeTableRef = useRef<TreeTable>(null);
  const contextMenuRef = useRef<ContextMenu>(null);
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
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

  // Build tree nodes from labels
  useEffect(() => {
    if (!currentWorkspace) {
      setNodes([]);
      return;
    }

    if (!workspaceLabels) {
      setNodes([]);
      ipc.sendMessage("workspace:labels", null);
      return;
    }

    const newNodes: TreeNode[] = workspaceLabels.map((label) => ({
      id: label.id,
      key: label.id,
      data: {
        labelId: label.id,
        label: label.name,
        changelist: label.changelist.number,
        message: label.changelist.message || "",
        date: new Date(label.changelist.createdAt).toLocaleDateString(),
        user:
          label.changelist.user?.email ||
          label.changelist.user?.name ||
          "Unknown",
      },
    }));

    setNodes(newNodes);
  }, [currentWorkspace, workspaceLabels]);

  // IPC listeners for label operations
  useEffect(() => {
    const unsubDeleteSuccess = ipc.on("workspace:delete-label:success", () => {
      setDeletePending(false);
      setDeleteDialogVisible(false);
      ipc.sendMessage("workspace:labels", null);
    });

    const unsubDeleteError = ipc.on("workspace:delete-label:error", (data) => {
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
    (event: React.MouseEvent, node: TreeNode) => {
      event.preventDefault();
      const labelId = node.data?.labelId as string;
      const labelName = node.data?.label as string;
      const changelist = node.data?.changelist as number;
      contextLabelRef.current = {
        id: labelId,
        name: labelName,
        changelist,
      };

      const items: MenuItem[] = [
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
          style: { color: "#ff6b6b" },
          command: () => {
            if (contextLabelRef.current) {
              setDeleteDialogVisible(true);
            }
          },
        },
      ];

      setMenuItems(items);
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
        pt={{
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
        }}
      />
      <div className="grid grid-rows-[2.5rem_calc(100vh-8.5rem)] gap-4">
        <div
          className="row-span-1 space-x-[0.3rem]"
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
            onClick={() => {
              ipc.sendMessage("workspace:labels", null);
            }}
          />
          <Button
            className="p-[0.3rem] text-[0.8em]"
            label="Create Label"
            onClick={() => setCreateLabelVisible(true)}
          />
        </div>
        <div
          className="row-span-1"
          style={{ textAlign: "left", overflow: "hidden" }}
          ref={tableWrapperRef}
        >
          <TreeTable
            ref={treeTableRef}
            value={nodes}
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
              field="label"
              header="Label"
              expander
              resizeable
              sortable
              pt={columnPt}
            ></Column>
            <Column
              field="changelist"
              header="Changelist"
              resizeable
              sortable
              pt={columnPt}
            ></Column>
            <Column
              field="message"
              header="Message"
              resizeable
              sortable
              pt={columnPt}
            ></Column>
            <Column
              field="date"
              header="Date"
              resizeable
              sortable
              pt={columnPt}
            ></Column>
            <Column
              field="user"
              header="User"
              resizeable
              sortable
              pt={columnPt}
            ></Column>
          </TreeTable>
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
          Are you sure you want to delete the label{" "}
          <strong>&quot;{contextLabelRef.current?.name}&quot;</strong>?
        </p>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog
        header="Rename Label"
        visible={renameDialogVisible}
        style={{ width: "26rem" }}
        onHide={() => {
          if (!renamePending) setRenameDialogVisible(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              label="Cancel"
              onClick={() => setRenameDialogVisible(false)}
              disabled={renamePending}
              className="p-[0.5rem] text-[0.9em]"
            />
            <Button
              label={renamePending ? "Renaming..." : "Rename"}
              onClick={handleRename}
              disabled={renamePending || !renameName.trim()}
              className="p-[0.5rem] text-[0.9em]"
            />
          </div>
        }
        pt={dialogPt}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="rename-input" style={{ color: "#aaa" }}>
            New name
          </label>
          <InputText
            id="rename-input"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameName.trim()) handleRename();
            }}
            autoFocus
            style={{
              backgroundColor: "var(--color-surface)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-light)",
            }}
          />
          {renameError && (
            <small style={{ color: "#ff6b6b" }}>{renameError}</small>
          )}
        </div>
      </Dialog>

      {/* Change Changelist Dialog */}
      <Dialog
        header="Change Changelist"
        visible={changeClDialogVisible}
        style={{ width: "26rem" }}
        onHide={() => {
          if (!changeClPending) setChangeClDialogVisible(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              label="Cancel"
              onClick={() => setChangeClDialogVisible(false)}
              disabled={changeClPending}
              className="p-[0.5rem] text-[0.9em]"
            />
            <Button
              label={changeClPending ? "Saving..." : "Save"}
              onClick={handleChangeCl}
              disabled={
                changeClPending ||
                !changeClNumber.trim() ||
                isNaN(parseInt(changeClNumber, 10))
              }
              className="p-[0.5rem] text-[0.9em]"
            />
          </div>
        }
        pt={dialogPt}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="changecl-input" style={{ color: "#aaa" }}>
            Changelist number
          </label>
          <InputText
            id="changecl-input"
            value={changeClNumber}
            onChange={(e) => setChangeClNumber(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                changeClNumber.trim() &&
                !isNaN(parseInt(changeClNumber, 10))
              ) {
                handleChangeCl();
              }
            }}
            keyfilter="int"
            autoFocus
            style={{
              backgroundColor: "var(--color-surface)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-light)",
            }}
          />
          {changeClError && (
            <small style={{ color: "#ff6b6b" }}>{changeClError}</small>
          )}
        </div>
      </Dialog>
    </>
  );
}
