import React, { useEffect, useState } from "react";
import {
  TreeTable,
  TreeTableTogglerTemplateOptions,
} from "primereact/treetable";
import { Column, ColumnPassThroughOptions } from "primereact/column";
import { ScrollPanel } from "primereact/scrollpanel";
import { TreeNode } from "primereact/treenode";
import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  FileStatus,
  FileType,
  workspaceDirectoriesAtom,
} from "../../common/state/workspace";
import { ipc } from "../pages/ipc";
import Button from "./Button";
import prettyBytes from "pretty-bytes";

export default function WorkspaceExplorer() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspaceDirectories = useAtomValue(workspaceDirectoriesAtom);

  const [nodes, setNodes] = useState<TreeNode[]>([]);

  useEffect(() => {
    if (!currentWorkspace) {
      setNodes([]);
      return;
    }

    const newNodes: TreeNode[] = [];

    for (const absolutePath in workspaceDirectories) {
      const dir = workspaceDirectories[absolutePath];
      const relativePath = absolutePath.replace(currentWorkspace.rootPath, "");
      const pathParts = relativePath
        .split("/")
        .filter((part) => part.length > 0);

      if (pathParts.length === 0) {
        if (newNodes.length === 0) {
          const node: TreeNode = {
            id: "/",
            key: "/",
            data: {
              name: currentWorkspace.rootPath,
              status: "",
              size: "",
              modified: "",
              type: "Directory",
              changelist: "",
            },
            leaf: false,
            children: [],
          };
          newNodes.push(node);
        }
      } else {
        let currentNode: TreeNode = newNodes[0];
        for (const part of pathParts) {
          const childNode = currentNode.children?.find(
            (child) => (child.key as string).split("/").pop() === part,
          );

          if (childNode) {
            currentNode = childNode;
          } else {
            const newChildNode: TreeNode = {
              id: currentNode.id + "/" + part,
              key: currentNode.key + "/" + part,
              data: {
                name: part,
                status: "",
                size: "",
                modified: "",
                type: "Directory",
                changelist: "",
              },
              leaf: false,
              children: [],
            };

            if (!currentNode.children) {
              currentNode.children = [];
            }
            currentNode.children.push(newChildNode);
            currentNode = newChildNode;
          }
        }

        currentNode.children = dir.children.map((file) => ({
          id: currentNode.id + "/" + file.path.split("/").pop(),
          key: currentNode.key + "/" + file.path.split("/").pop(),
          data: {
            name: file.path.split("/").pop() || "",
            status:
              file.status === FileStatus.Unknown ? "" : FileStatus[file.status],
            size: file.size.toString() + " B",
            modified: new Date(file.modifiedAt).toLocaleDateString(),
            type: FileType[file.type],
            changelist: file.changelist ? file.changelist.toString() : "",
          },
          leaf: file.type !== FileType.Directory,
        }));
      }
    }

    setNodes(newNodes);
  }, [currentWorkspace, workspaceDirectories]);

  const nodeLookup: { [key: string]: TreeNode } = {};

  useEffect(() => {
    nodeLookup["/"] = nodes[0];
  }, []);

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
        <Button className="p-[0.3rem] text-[0.8em]" label="Refresh" />
        <Button className="p-[0.3rem] text-[0.8em]" label="Pull" />
      </div>
      <div
        className="row-span-1"
        style={{ textAlign: "left", overflow: "hidden" }}
      >
        {/* <ScrollPanel
          style={{
            width: "100%",
            height: "100%",
            textAlign: "left",
          }}
        > */}
        <TreeTable
          value={nodes}
          tableStyle={{ minWidth: "50rem" }}
          columnResizeMode="expand"
          resizableColumns
          showGridlines
          scrollable
          onExpand={(event) => {
            const node = event.node;
            if (node && (!node.children || node.children.length === 0)) {
              ipc.once("workspace:directory-contents", (data) => {
                const directory = data.directory;
                node.children = directory.children.map((file) => ({
                  id: node.id + "/" + file.path.split("/").pop(),
                  key: node.key + "/" + file.path.split("/").pop(),
                  data: {
                    name: file.path.split("/").pop() || "",
                    status: FileStatus[file.status],
                    size: prettyBytes(file.size),
                    modified: new Date(file.modifiedAt).toLocaleDateString(),
                    type: FileType[file.type],
                    changelist: file.changelist
                      ? file.changelist.toString()
                      : "",
                  },
                  leaf: file.type !== FileType.Directory,
                }));
                if (node.id === "/" && directory.children.length > 0) {
                  node.expanded = true;
                }
                setNodes([...nodes]);
              });

              ipc.sendMessage("workspace:get-directory", {
                path: node.id!,
              });
            }
          }}
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
            field="name"
            header="Name"
            expander
            resizeable
            sortable
            pt={columnPt}
          ></Column>
          <Column
            field="status"
            header="Status"
            resizeable
            sortable
            pt={columnPt}
          ></Column>
          <Column
            field="size"
            header="Size"
            resizeable
            sortable
            pt={columnPt}
          ></Column>
          <Column
            field="modified"
            header="Date Modified"
            resizeable
            sortable
            pt={columnPt}
          ></Column>
          <Column
            field="type"
            header="Type"
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
        </TreeTable>
        {/* </ScrollPanel> */}
      </div>
    </div>
  );
}
