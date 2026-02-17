import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  TreeTable,
  TreeTableExpandedKeysType,
  TreeTableSelectionKeysType,
  TreeTableSortEvent,
  TreeTableSortMeta,
} from "primereact/treetable";
import { Column, ColumnPassThroughOptions } from "primereact/column";
import { TreeNode } from "primereact/treenode";
import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceDirectoriesAtom,
  workspacePendingChangesAtom,
  fileHistoryAtom,
} from "../../common/state/workspace";
import { ipc } from "../pages/ipc";
import Button from "./Button";
import prettyBytes from "pretty-bytes";
import { FileStatus, FileType } from "@checkpointvcs/daemon/types";
import FileContextMenu, {
  useFileContextMenu,
  FileContextInfo,
} from "./FileContextMenu";
import FileHistory from "./FileHistory";

export default function WorkspaceExplorer() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspaceDirectories = useAtomValue(workspaceDirectoriesAtom);
  const workspacePendingChanges = useAtomValue(workspacePendingChangesAtom);
  const fileHistory = useAtomValue(fileHistoryAtom);

  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<TreeTableExpandedKeysType>(
    {},
  );
  const [selectedKeys, setSelectedKeys] =
    useState<TreeTableSelectionKeysType | null>(null);
  const hasAutoExpandedRoot = useRef(false);

  const [multiSortMeta, setMultiSortMeta] = useState<TreeTableSortMeta[]>([
    { field: "type", order: 1 }, // order 1 for ascending (directories first, then files)
  ]);

  // Context menu hook
  const {
    contextMenuRef,
    showContextMenu,
    buildMenuItems,
    currentFileRef,
    lockedWarningVisible,
    setLockedWarningVisible,
    lockedWarningPath,
    lockedWarningUser,
    confirmLockedCheckout,
  } = useFileContextMenu();
  const [menuItems, setMenuItems] = useState<any[]>([]);

  // Handler for right-click on rows
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, node: TreeNode) => {
      if (!currentWorkspace) return;

      const workspaceLocalPath = currentWorkspace.localPath
        .split(/[/\\]/)
        .join("/");
      const relativePath = node.key as string;
      const absolutePath = workspaceLocalPath + relativePath;

      const fileInfo: FileContextInfo = {
        absolutePath,
        relativePath,
        isDirectory: node.data?.type === "Directory",
        status: node.data?.status || "",
        hasChangelist: !!node.data?.changelist,
        changelistId: node.data?.changelist
          ? parseInt(node.data.changelist, 10)
          : null,
      };

      showContextMenu(event, fileInfo);
      // Rebuild menu items after setting the file
      setTimeout(() => {
        setMenuItems(buildMenuItems());
      }, 0);
    },
    [currentWorkspace, showContextMenu, buildMenuItems],
  );

  useEffect(() => {
    if (!currentWorkspace) {
      setNodes([]);
      return;
    }

    const newNodes: TreeNode[] = [];

    for (const absolutePath in workspaceDirectories) {
      const dir = workspaceDirectories[absolutePath];
      const relativePath = absolutePath.replace(currentWorkspace.localPath, "");
      const pathParts = relativePath
        .split("/")
        .filter((part) => part.length > 0);

      if (pathParts.length === 0) {
        if (newNodes.length === 0) {
          const node: TreeNode = {
            id: "/",
            key: "/",
            data: {
              name: currentWorkspace.localPath,
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

        currentNode.children = dir.children.map((file) => {
          let status =
            file.status === FileStatus.Unknown ? "" : FileStatus[file.status];
          if (workspacePendingChanges?.files[file.path]) {
            status =
              FileStatus[workspacePendingChanges.files[file.path].status];
          }

          return {
            id: currentNode.id + "/" + file.path.split("/").pop(),
            key: currentNode.key + "/" + file.path.split("/").pop(),
            data: {
              name: file.path.split("/").pop() || "",
              status,
              size:
                file.type === FileType.Directory ? "" : prettyBytes(file.size),
              modified: new Date(file.modifiedAt).toLocaleDateString(),
              type: FileType[file.type],
              changelist: file.changelist ? file.changelist.toString() : "",
            },
            leaf: file.type !== FileType.Directory,
          };
        });
      }
    }

    setNodes(newNodes);
  }, [currentWorkspace, workspaceDirectories]);

  // Auto-expand root node on initial load
  useEffect(() => {
    if (
      nodes.length > 0 &&
      nodes[0] &&
      currentWorkspace &&
      !hasAutoExpandedRoot.current
    ) {
      hasAutoExpandedRoot.current = true;
      const rootNode = nodes[0];

      // Set root as expanded in the UI
      setExpandedKeys({ "/": true });

      // Fetch root directory contents after a short delay to ensure state is ready
      setTimeout(() => {
        ipc.once("workspace:directory-contents", (data) => {
          const directory = data.directory;
          rootNode.children = directory.children
            .filter((file) => file.path !== ".checkpoint")
            .map((file) => {
              const relativePath = "/" + file.path.split("/").pop();
              const absolutePath =
                currentWorkspace.localPath.split(/[/\\\/]/).join("/") +
                relativePath;
              let status =
                file.type === FileType.Directory ? "" : FileStatus[file.status];
              if (workspacePendingChanges?.files[absolutePath]) {
                status =
                  FileStatus[
                    workspacePendingChanges.files[absolutePath].status
                  ];
              }

              return {
                id: relativePath,
                key: relativePath,
                data: {
                  name: file.path.split("/").pop() || "",
                  status,
                  size:
                    file.type === FileType.Directory
                      ? ""
                      : prettyBytes(file.size),
                  modified: new Date(file.modifiedAt).toLocaleDateString(),
                  type: FileType[file.type],
                  changelist: file.changelist ? file.changelist.toString() : "",
                },
                leaf: file.type !== FileType.Directory,
              };
            });
          setNodes([...nodes]);
        });

        ipc.sendMessage("workspace:get-directory", {
          path: "/",
        });
      }, 100);
    }
  }, [nodes, currentWorkspace]);

  // Reset auto-expand flag when workspace changes or when workspaceDirectories is reset
  useEffect(() => {
    hasAutoExpandedRoot.current = false;
  }, [currentWorkspace?.id]);

  // Also reset auto-expand flag when workspaceDirectories is reset to initial state
  useEffect(() => {
    if (currentWorkspace) {
      const rootDir = workspaceDirectories[currentWorkspace.localPath];
      if (rootDir && rootDir.children.length === 0) {
        hasAutoExpandedRoot.current = false;
      }
    }
  }, [workspaceDirectories, currentWorkspace]);

  // Handler for when the user clicks a column header
  const onSort = (event: TreeTableSortEvent) => {
    // The user's requested sort is in event.multiSortMeta (if multiple is used) or sortField/sortOrder (if single mode but we use multiple)

    // Find the user's clicked sort configuration
    const userSort = event.multiSortMeta?.find((meta) => meta.field !== "type");

    // Always prepend the mandatory sort criterion
    let newSortMeta: TreeTableSortMeta[] = [{ field: "type", order: 1 }];

    if (userSort) {
      // Add the user's sort field, unless it's already the 'type' field which is handled
      newSortMeta.push(userSort);
    }

    setMultiSortMeta(newSortMeta);
    // Note: If you are using server-side sorting, you would make an API call here
  };

  const columnPt: ColumnPassThroughOptions = {
    headerCell: {
      style: {
        borderColor: "var(--color-border)",
        borderWidth: "0 1px 1px 0",
        borderStyle: "solid",
        paddingLeft: "0.5rem",
        fontSize: "0.75em",
        position: "sticky",
        top: 0,
        backgroundColor: "var(--color-app-bg)",
        zIndex: 1,
      },
    },
    bodyCell: {
      style: {
        fontSize: "0.9em",
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: "0.2rem",
        paddingRight: "0.5rem",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
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
    <>
      {/* File context menu - rendered outside the main layout */}
      <FileContextMenu
        contextMenuRef={contextMenuRef}
        menuItems={menuItems}
        lockedWarningVisible={lockedWarningVisible}
        setLockedWarningVisible={setLockedWarningVisible}
        lockedWarningUser={lockedWarningUser}
        lockedWarningPath={lockedWarningPath}
        confirmLockedCheckout={confirmLockedCheckout}
      />

      {/* Show file history view when active, otherwise show explorer */}
      {fileHistory ? (
        <FileHistory />
      ) : (
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
                ipc.sendMessage("workspace:refresh", null);
              }}
            />
            <Button
              className="p-[0.3rem] text-[0.8em]"
              label="Pull"
              onClick={() => {
                ipc.sendMessage("workspace:pull", {
                  changelistId: null,
                  filePaths: null,
                });
              }}
            />
          </div>
          <div
            className="row-span-1"
            style={{ textAlign: "left", overflow: "hidden" }}
          >
            <TreeTable
              value={nodes}
              expandedKeys={expandedKeys}
              onToggle={(e) => setExpandedKeys(e.value)}
              selectionMode="single"
              selectionKeys={selectedKeys}
              onSelectionChange={(e) =>
                setSelectedKeys(e.value as TreeTableSelectionKeysType)
              }
              tableStyle={{ minWidth: "50rem" }}
              columnResizeMode="expand"
              resizableColumns
              showGridlines
              sortMode="multiple"
              multiSortMeta={multiSortMeta}
              onSort={onSort}
              onContextMenu={(e) => {
                handleRowContextMenu(
                  e.originalEvent as React.MouseEvent,
                  e.node,
                );
              }}
              onExpand={(event) => {
                const node = event.node;
                if (node && (!node.children || node.children.length === 0)) {
                  ipc.once("workspace:directory-contents", (data) => {
                    const directory = data.directory;

                    node.children = directory.children
                      .filter((file) => file.path !== ".checkpoint")
                      .map((file) => {
                        const relativePath =
                          (node.id === "/" ? "" : node.id) +
                          "/" +
                          file.path.split("/").pop();
                        const absolutePath =
                          currentWorkspace!.localPath
                            .split(/[/\\\/]/)
                            .join("/") + relativePath;
                        let status =
                          file.type === FileType.Directory
                            ? ""
                            : FileStatus[file.status];
                        if (workspacePendingChanges?.files[absolutePath]) {
                          status =
                            FileStatus[
                              workspacePendingChanges.files[absolutePath].status
                            ];
                        }

                        return {
                          id: relativePath,
                          key: relativePath,
                          data: {
                            name: file.path.split("/").pop() || "",
                            status,
                            size: prettyBytes(file.size),
                            modified: new Date(
                              file.modifiedAt,
                            ).toLocaleDateString(),
                            type: FileType[file.type],
                            changelist: file.changelist
                              ? file.changelist.toString()
                              : "",
                          },
                          leaf: file.type !== FileType.Directory,
                        };
                      });
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
                resizeHelper: {
                  style: {
                    width: "0.1rem",
                    backgroundColor: "var(--color-border-lighter)",
                  },
                },
                tbody: {
                  style: {
                    maxHeight: "initial",
                    overflowY: "auto",
                  },
                },
                wrapper: {
                  style: {
                    height: "100%",
                  },
                },
                table: {
                  style: {
                    maxHeight: "100%",
                    borderCollapse: "separate",
                    borderSpacing: 0,
                  },
                },
              }}
              style={{ height: "100%" }}
            >
              <Column
                field="name"
                header="Item"
                expander
                resizeable
                sortable
                pt={columnPt}
                style={{ width: "40%" }}
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
                style={{ width: "5rem" }}
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
          </div>
        </div>
      )}
    </>
  );
}
