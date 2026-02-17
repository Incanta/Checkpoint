import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  TreeTable,
  TreeTableExpandedKeysType,
  TreeTableSelectionKeysType,
} from "primereact/treetable";
import { Column, ColumnPassThroughOptions } from "primereact/column";
import { TreeNode } from "primereact/treenode";
import { Dialog } from "primereact/dialog";
import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceDiffAtom,
  workspacePendingChangesAtom,
} from "../../common/state/workspace";
import { ipc } from "../pages/ipc";
import { Splitter, SplitterPanel } from "primereact/splitter";
import Button from "./Button";
import styles from "./Editor.module.css";
// @ts-ignore
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  FileStatus,
  FileType,
  type Modification,
} from "@checkpointvcs/daemon/types";
import FileContextMenu, {
  useFileContextMenu,
  FileContextInfo,
} from "./FileContextMenu";

export default function WorkspacePendingChanges() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspacePendingChanges = useAtomValue(workspacePendingChangesAtom);
  const workspaceDiff = useAtomValue(workspaceDiffAtom);

  const treeTableRef = useRef<TreeTable>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selectedNodeKeys, setSelectedNodeKeys] =
    useState<TreeTableSelectionKeysType | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<TreeTableExpandedKeysType>({
    changed: true,
    moved: true,
    deleted: true,
    added: true,
  });

  const [commitMessage, setCommitMessage] = useState<string>("");
  const [highlightedRowKey, setHighlightedRowKey] = useState<string | null>(
    null,
  );

  const [editor, setEditor] =
    useState<monaco.editor.IStandaloneDiffEditor | null>(null);
  const monacoEl = useRef<HTMLDivElement | null>(null);

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorModalVisible, setErrorModalVisible] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>("");

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

      // Skip category nodes (changed, moved, deleted, added)
      const key = node.key as string;
      if (["changed", "moved", "deleted", "added"].includes(key)) return;

      // Strip the category prefix from the key to get the relative path
      const relativePath = key
        .replace(/^(changed|moved|deleted|added)\//, "")
        .replace(/^\//, "");

      const workspaceLocalPath = currentWorkspace.localPath
        .split(/[/\\]/)
        .join("/");
      const absolutePath = workspaceLocalPath + "/" + relativePath;

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
      setTimeout(() => {
        setMenuItems(buildMenuItems());
      }, 0);
    },
    [currentWorkspace, showContextMenu, buildMenuItems],
  );

  // Check if any files are selected (not just category nodes)
  const hasSelectedFiles =
    selectedNodeKeys &&
    Object.entries(selectedNodeKeys).some(([key, value]) => {
      const selection = value as {
        checked?: boolean;
        partialChecked?: boolean;
      };
      // Must be fully checked (not just partial) and not a category node
      return (
        selection.checked &&
        !selection.partialChecked &&
        !["changed", "moved", "deleted", "added"].includes(key)
      );
    });

  // Listen for submit success/error responses
  useEffect(() => {
    const unsubscribeSuccess = ipc.on("workspace:submit:success", () => {
      setIsSubmitting(false);
      setCommitMessage("");
      setSelectedNodeKeys(null);
      // Clear the diff editor
      if (editor) {
        editor.setModel({
          original: monaco.editor.createModel("", "text/plain"),
          modified: monaco.editor.createModel("", "text/plain"),
        });
      }
      setHighlightedRowKey(null);
      // Refresh the pending changes from scratch
      ipc.sendMessage("workspace:refresh", null);
    });

    const unsubscribeError = ipc.on("workspace:submit:error", (data) => {
      setIsSubmitting(false);
      setErrorMessage(data.message);
      setErrorModalVisible(true);
    });

    return () => {
      unsubscribeSuccess();
      unsubscribeError();
    };
  }, [editor]);

  useEffect(() => {
    if (monacoEl?.current && workspaceDiff) {
      setEditor((editor) => {
        if (editor) {
          editor.dispose();
          monacoEl.current!.innerHTML = "";
        }
        const newEditor = monaco.editor.createDiffEditor(monacoEl.current!, {
          theme: "vs-dark",
          automaticLayout: true,
        });

        newEditor.setModel({
          original: monaco.editor.createModel(
            workspaceDiff ? workspaceDiff.left : "",
            "text/plain",
          ),
          modified: monaco.editor.createModel(
            workspaceDiff ? workspaceDiff.right : "",
            "text/plain",
          ),
        });

        newEditor.getOriginalEditor().updateOptions({ readOnly: true });
        newEditor.getModifiedEditor().updateOptions({ readOnly: true });

        return newEditor;
      });
    }

    return () => editor?.dispose();
  }, [monacoEl.current, workspaceDiff]);

  useEffect(() => {
    if (!currentWorkspace) {
      setNodes([]);
      return;
    }

    const changedNode: TreeNode = {
      id: "changed",
      key: "changed",
      data: {
        name: "Changed Files",
        status: "",
        size: "",
        modified: "",
        type: "",
        changelist: "",
      },
      leaf: false,
      children: [],
    };

    const movedNode: TreeNode = {
      id: "moved",
      key: "moved",
      data: {
        name: "Moved Files",
        status: "",
        size: "",
        modified: "",
        type: "",
        changelist: "",
      },
      leaf: false,
      children: [],
    };

    const deletedNode: TreeNode = {
      id: "deleted",
      key: "deleted",
      data: {
        name: "Deleted Files",
        status: "",
        size: "",
        modified: "",
        type: "",
        changelist: "",
      },
      leaf: false,
      children: [],
    };

    const addedNode: TreeNode = {
      id: "added",
      key: "added",
      data: {
        name: "Added Files",
        status: "",
        size: "",
        modified: "",
        type: "",
        changelist: "",
      },
      leaf: false,
      children: [],
    };

    const newNodes: TreeNode[] = [
      changedNode,
      movedNode,
      deletedNode,
      addedNode,
    ];

    if (workspacePendingChanges) {
      for (const filePath in workspacePendingChanges.files) {
        const file = workspacePendingChanges.files[filePath];
        const relativePath = file.path
          .replace(currentWorkspace.localPath, "")
          .replace(/^[\/\\]/, "");
        const pathParts = relativePath
          .split(/[\/\\]/)
          .filter((part) => part.length > 0);

        const filename = pathParts.pop();
        if (!filename) continue;

        // TODO MIKE HERE: how to handle conflicted status?

        let parentNode: TreeNode | null = null;
        switch (file.status) {
          case FileStatus.ChangedCheckedOut:
          case FileStatus.ChangedNotCheckedOut:
            parentNode = changedNode;
            break;
          case FileStatus.Renamed:
            parentNode = movedNode;
            break;
          case FileStatus.Deleted:
            parentNode = deletedNode;
            break;
          case FileStatus.Added:
          case FileStatus.Local:
            parentNode = addedNode;
            break;
          default:
            continue;
        }

        let currentNode: TreeNode = parentNode;
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

        if (!currentNode.children) {
          currentNode.children = [];
        }
        currentNode.children.push({
          id: currentNode.id + "/" + filename,
          key: currentNode.key + "/" + filename,
          data: {
            path: file.path,
            name: filename,
            status: FileStatus[file.status],
            size: file.size.toString() + " B",
            modified: new Date(file.modifiedAt).toLocaleDateString(),
            type: FileType[file.type],
            changelist: file.changelist ? file.changelist.toString() : "",
            onclick: () => {
              console.log("Clicked file:", file.path);
            },
          },
          leaf: file.type !== FileType.Directory,
        });
      }
    }

    setNodes(newNodes);
  }, [currentWorkspace, workspacePendingChanges]);

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
          disabled={isSubmitting}
          onClick={() => {
            ipc.sendMessage("workspace:refresh", null);
          }}
        />
        <Button
          className="p-[0.3rem] text-[0.8em]"
          label={isSubmitting ? "Submitting..." : "Submit"}
          disabled={isSubmitting || !hasSelectedFiles}
          onClick={() => {
            const keys: TreeTableSelectionKeysType = selectedNodeKeys || {};

            const modifications: Modification[] = [];
            for (const key in keys) {
              const selection = keys[key] as {
                checked?: boolean;
                partialChecked?: boolean;
              };
              if (selection.partialChecked || !selection.checked) {
                continue;
              }

              // Strip category prefix and leading slash to get relative path
              const relativePath = key
                .replace(/^(changed|moved|deleted|added)\//, "")
                .replace(/^\//, "");

              const pendingChange =
                workspacePendingChanges!.files[relativePath];

              if (relativePath && pendingChange) {
                // todo implement renamed/moved
                modifications.push({
                  path: relativePath,
                  delete: pendingChange.status === FileStatus.Deleted,
                });
              }
            }

            console.log(modifications);

            setIsSubmitting(true);
            ipc.sendMessage("workspace:submit", {
              message: commitMessage,
              modifications,
              shelved: false,
            });
          }}
        />
        <Button
          className="p-[0.3rem] text-[0.8em]"
          label="Undo"
          disabled={isSubmitting}
        />
      </div>
      <div
        className="row-span-1"
        style={{ textAlign: "left", overflow: "hidden" }}
      >
        <Splitter
          layout="vertical"
          className="w-full h-full"
          pt={{
            gutter: {
              className: "pending-changes-splitter-gutter",
            },
          }}
        >
          <SplitterPanel
            className="flex"
            size={10}
            style={{
              backgroundColor: "var(--color-panel)",
            }}
          >
            <textarea
              className="w-full m-[0.5rem] p-[0.5rem]"
              placeholder="Add a message to submit..."
              disabled={isSubmitting}
              style={{
                textAlign: "start",
                resize: "none",
                backgroundColor: "var(--color-app-bg)",
                borderRadius: "0.3rem",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
                marginBottom: "0",
                outlineColor: "#646cff",
                zIndex: 1,
                opacity: isSubmitting ? 0.5 : 1,
              }}
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
            />
          </SplitterPanel>
          <SplitterPanel
            className="flex"
            size={60}
            style={{ overflow: "hidden" }}
          >
            <TreeTable
              ref={treeTableRef}
              className="pending-changes-tree"
              value={nodes}
              columnResizeMode="expand"
              resizableColumns
              showGridlines
              selectionMode="checkbox"
              selectionKeys={selectedNodeKeys}
              onSelectionChange={(e) =>
                setSelectedNodeKeys(e.value as TreeTableSelectionKeysType)
              }
              expandedKeys={expandedKeys}
              onToggle={(e) => setExpandedKeys(e.value)}
              rowClassName={(node) => {
                const classes: Record<string, boolean> = {};
                if (node.key === highlightedRowKey) {
                  classes["row-highlighted"] = true;
                }
                if (
                  ["changed", "moved", "deleted", "added"].includes(
                    node.key as string,
                  )
                ) {
                  classes["category-row"] = true;
                  classes[`category-${node.key}`] = true;
                }
                return classes;
              }}
              onRowClick={(event) => {
                if (isSubmitting) return;
                const target = event.originalEvent.target as HTMLElement;
                if (target && target.tagName === "INPUT") {
                  return;
                }
                if (event.node.data?.path) {
                  setHighlightedRowKey(event.node.key as string);
                  ipc.sendMessage("workspace:diff:file", {
                    path: event.node.data.path,
                  });
                }
              }}
              onContextMenu={(event) => {
                handleRowContextMenu(
                  event.originalEvent as React.MouseEvent,
                  event.node,
                );
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
                    width: "100%",
                  },
                },
                table: {
                  style: {
                    maxHeight: "100%",
                    width: "100%",
                    borderCollapse: "separate",
                    borderSpacing: 0,
                    minWidth: "50rem",
                    opacity: isSubmitting ? 0.5 : 1,
                    pointerEvents: isSubmitting ? "none" : "auto",
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
          </SplitterPanel>
          <SplitterPanel
            className="flex"
            size={30}
            style={{ opacity: isSubmitting ? 0.5 : 1 }}
          >
            {workspaceDiff && (
              <div className={styles.Editor} ref={monacoEl}></div>
            )}
            {!workspaceDiff && (
              <div
                className="h-full w-full"
                style={{ backgroundColor: "var(--color-panel)" }}
              >
                <div
                  className="m-auto text-gray-500"
                  style={{ textAlign: "center" }}
                >
                  Select a file to view the diff
                </div>
              </div>
            )}
          </SplitterPanel>
        </Splitter>
      </div>

      <Dialog
        header="Submit Error"
        visible={errorModalVisible}
        style={{ width: "30rem" }}
        onHide={() => setErrorModalVisible(false)}
        footer={
          <Button
            label="OK"
            onClick={() => setErrorModalVisible(false)}
            className="p-[0.5rem] text-[0.9em]"
          />
        }
        pt={{
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
        }}
      >
        <p>{errorMessage}</p>
      </Dialog>

      <FileContextMenu
        contextMenuRef={contextMenuRef}
        menuItems={menuItems}
        lockedWarningVisible={lockedWarningVisible}
        setLockedWarningVisible={setLockedWarningVisible}
        lockedWarningUser={lockedWarningUser}
        lockedWarningPath={lockedWarningPath}
        confirmLockedCheckout={confirmLockedCheckout}
      />
    </div>
  );
}
