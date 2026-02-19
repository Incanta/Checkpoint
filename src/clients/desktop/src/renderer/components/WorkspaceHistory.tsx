import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceHistoryAtom,
  changelistChangesAtom,
  workspaceBranchesAtom,
} from "../../common/state/workspace";
import Button from "./Button";
import { ipc } from "../pages/ipc";
import { TreeTable } from "primereact/treetable";
import { useCallback, useEffect, useRef, useState } from "react";
import { TreeNode } from "primereact/treenode";
import { Column, ColumnPassThroughOptions } from "primereact/column";
import { ContextMenu } from "primereact/contextmenu";
import { MenuItem } from "primereact/menuitem";
import ChangelistChanges from "./ChangelistChanges";
import CreateLabelDialog from "./CreateLabelDialog";
import CreateBranchDialog from "./CreateBranchDialog";

export default function WorkspaceHistory() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspaceHistory = useAtomValue(workspaceHistoryAtom);
  const branchesState = useAtomValue(workspaceBranchesAtom);
  const changelistChanges = useAtomValue(changelistChangesAtom);

  const treeTableRef = useRef<TreeTable>(null);
  const contextMenuRef = useRef<ContextMenu>(null);
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const contextChangelistRef = useRef<number | null>(null);
  const [createLabelVisible, setCreateLabelVisible] = useState(false);
  const [createLabelCl, setCreateLabelCl] = useState<number>(0);
  const [createBranchVisible, setCreateBranchVisible] = useState(false);
  const [createBranchCl, setCreateBranchCl] = useState<number>(0);

  useEffect(() => {
    if (!currentWorkspace) {
      setNodes([]);
      return;
    }

    if (!workspaceHistory) {
      setNodes([]);
      ipc.sendMessage("workspace:history", null);
      return;
    }

    const newNodes: TreeNode[] = [];

    for (const changelist of workspaceHistory) {
      const node: TreeNode = {
        id: changelist.id,
        key: changelist.id,
        data: {
          changelist: changelist.number,
          message: changelist.message,
          date: new Date(changelist.createdAt).toLocaleDateString(),
          user: changelist.user?.email || "Unknown",
        },
      };

      newNodes.push(node);
    }

    setNodes(newNodes);
  }, [currentWorkspace, workspaceHistory]);

  const handleViewChanges = useCallback((changelistNumber: number) => {
    ipc.sendMessage("workspace:history:view-changes", { changelistNumber });
  }, []);

  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, node: TreeNode) => {
      event.preventDefault();
      const changelistNumber = node.data?.changelist as number;
      contextChangelistRef.current = changelistNumber;

      const items: MenuItem[] = [
        {
          label: "View changes",
          command: () => {
            if (contextChangelistRef.current !== null) {
              handleViewChanges(contextChangelistRef.current);
            }
          },
        },
        { separator: true },
        {
          label: "Create branch here...",
          command: () => {
            if (contextChangelistRef.current !== null) {
              setCreateBranchCl(contextChangelistRef.current);
              setCreateBranchVisible(true);
            }
          },
        },
        {
          label: "Create label...",
          command: () => {
            if (contextChangelistRef.current !== null) {
              setCreateLabelCl(contextChangelistRef.current);
              setCreateLabelVisible(true);
            }
          },
        },
      ];

      setMenuItems(items);
      contextMenuRef.current?.show(event);
    },
    [handleViewChanges],
  );

  const handleRowDoubleClick = useCallback(
    (node: TreeNode) => {
      const changelistNumber = node.data?.changelist as number;
      if (changelistNumber !== undefined) {
        handleViewChanges(changelistNumber);
      }
    },
    [handleViewChanges],
  );

  // Event delegation for double-click on table rows
  useEffect(() => {
    const wrapper = tableWrapperRef.current;
    if (!wrapper) return;

    const handleDblClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const row = target.closest("tr");
      if (!row) return;

      // Make sure it's a body row (not a header row)
      const tbody = row.closest("tbody");
      if (!tbody) return;

      const cells = row.querySelectorAll("td");
      if (cells.length > 0) {
        const changelistText = cells[0]?.textContent?.trim();
        const changelistNumber = changelistText
          ? parseInt(changelistText, 10)
          : NaN;
        if (!isNaN(changelistNumber)) {
          handleViewChanges(changelistNumber);
        }
      }
    };

    wrapper.addEventListener("dblclick", handleDblClick);
    return () => wrapper.removeEventListener("dblclick", handleDblClick);
  }, [handleViewChanges]);

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

  // Show changelist changes view when active
  if (changelistChanges) {
    return <ChangelistChanges />;
  }

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
              ipc.sendMessage("workspace:history", null);
            }}
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
              field="changelist"
              header="Changelist"
              expander
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

      <CreateLabelDialog
        visible={createLabelVisible}
        changelistNumber={createLabelCl}
        onHide={() => setCreateLabelVisible(false)}
      />

      <CreateBranchDialog
        visible={createBranchVisible}
        onHide={() => setCreateBranchVisible(false)}
        defaultParentBranchName={
          branchesState?.currentBranchName &&
          branchesState.branches.find((b) => b.name === branchesState.currentBranchName)?.type === "FEATURE"
            ? branchesState.branches.find((b) => b.name === branchesState.currentBranchName)?.parentBranchName ?? branchesState.currentBranchName
            : branchesState?.currentBranchName ?? null
        }
        defaultHeadNumber={createBranchCl}
        defaultType="FEATURE"
      />
    </>
  );
}
