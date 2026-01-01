import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceHistoryAtom,
} from "../../common/state/workspace";
import Button from "./Button";
import { ipc } from "../pages/ipc";
import { TreeTable } from "primereact/treetable";
import { useEffect, useRef, useState } from "react";
import { TreeNode } from "primereact/treenode";
import { Column, ColumnPassThroughOptions } from "primereact/column";

export default function WorkspaceHistory() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspaceHistory = useAtomValue(workspaceHistoryAtom);

  const treeTableRef = useRef<TreeTable>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);

  useEffect(() => {
    if (!currentWorkspace || !workspaceHistory) {
      setNodes([]);
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
          user: changelist.userId,
        },
      };

      newNodes.push(node);
    }

    setNodes(newNodes);
  }, [currentWorkspace, workspaceHistory]);

  const columnPt: ColumnPassThroughOptions = {
    headerCell: {
      style: {
        borderColor: "#1A1A1A",
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

  return (
    <div className="grid grid-rows-[2.5rem_calc(100vh-8.5rem)] gap-4">
      <div
        className="row-span-1 space-x-[0.3rem]"
        style={{
          backgroundColor: "#2C2C2C",
          borderColor: "#1A1A1A",
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
      >
        <TreeTable
          ref={treeTableRef}
          value={nodes}
          tableStyle={{ minWidth: "50rem" }}
          columnResizeMode="expand"
          resizableColumns
          showGridlines
          scrollable
          pt={{
            thead: {
              style: {
                borderColor: "#1A1A1A",
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
                backgroundColor: "#888888",
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
  );
}
