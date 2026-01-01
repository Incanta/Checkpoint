import React, { useEffect, useRef, useState } from "react";
import {
  TreeTable,
  TreeTableSelectionKeysType,
  TreeTableTogglerTemplateOptions,
} from "primereact/treetable";
import { Column, ColumnPassThroughOptions } from "primereact/column";
import { ScrollPanel } from "primereact/scrollpanel";
import { TreeNode } from "primereact/treenode";
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
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  FileStatus,
  FileType,
  Modification,
} from "@checkpointvcs/daemon/dist/types";

export default function WorkspacePendingChanges() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspacePendingChanges = useAtomValue(workspacePendingChangesAtom);
  const workspaceDiff = useAtomValue(workspaceDiffAtom);

  const treeTableRef = useRef<TreeTable>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selectedNodeKeys, setSelectedNodeKeys] =
    useState<TreeTableSelectionKeysType | null>(null);

  const [commitMessage, setCommitMessage] = useState<string>("");

  const [editor, setEditor] =
    useState<monaco.editor.IStandaloneDiffEditor | null>(null);
  const monacoEl = useRef<HTMLDivElement | null>(null);

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
            ipc.sendMessage("workspace:refresh", null);
          }}
        />
        <Button
          className="p-[0.3rem] text-[0.8em]"
          label="Submit"
          onClick={() => {
            const keys: TreeTableSelectionKeysType =
              (treeTableRef.current?.props.selectionKeys as
                | TreeTableSelectionKeysType
                | undefined) || {};

            const modifications: Modification[] = [];
            for (const key in keys) {
              if ((keys[key] as any).partialChecked) {
                continue;
              }

              const adjustedKey = key
                .replace("changed", "")
                .replace("moved", "")
                .replace("deleted", "")
                .replace("added", "")
                .trim();

              const absolutePath = currentWorkspace!.localPath + adjustedKey;

              const pendingChange =
                workspacePendingChanges!.files[absolutePath];

              if (adjustedKey && pendingChange) {
                // todo implement renamed/moved
                modifications.push({
                  path: adjustedKey,
                  delete: pendingChange.status === FileStatus.Deleted,
                });
              }
            }

            ipc.sendMessage("workspace:submit", {
              message: commitMessage,
              modifications,
              shelved: false,
            });
          }}
        />
        <Button className="p-[0.3rem] text-[0.8em]" label="Undo" />
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
              backgroundColor: "#2C2C2C",
            }}
          >
            <textarea
              className="w-full m-[0.5rem] p-[0.5rem]"
              placeholder="Add a message to submit..."
              style={{
                textAlign: "start",
                resize: "none",
                backgroundColor: "#272727",
                borderRadius: "0.3rem",
                border: "1px solid #1A1A1A",
                color: "#DDDDDD",
                marginBottom: "0",
                outlineColor: "#646cff",
                zIndex: 1,
              }}
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
            />
          </SplitterPanel>
          <SplitterPanel className="flex" size={60}>
            {/* <ScrollPanel
          style={{
            width: "100%",
            height: "100%",
            textAlign: "left",
          }}
        > */}
            <TreeTable
              ref={treeTableRef}
              value={nodes}
              tableStyle={{ minWidth: "50rem" }}
              columnResizeMode="expand"
              resizableColumns
              showGridlines
              scrollable
              selectionMode="checkbox"
              selectionKeys={selectedNodeKeys}
              onSelectionChange={(e) =>
                setSelectedNodeKeys(e.value as TreeTableSelectionKeysType)
              }
              onRowClick={(event) => {
                const target = event.originalEvent.target as HTMLElement;
                if (target && target.tagName === "INPUT") {
                  return;
                }
                if (event.node.data?.path) {
                  ipc.sendMessage("workspace:diff:file", {
                    path: event.node.data.path,
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
          </SplitterPanel>
          <SplitterPanel className="flex" size={30}>
            {workspaceDiff && (
              <div className={styles.Editor} ref={monacoEl}></div>
            )}
            {!workspaceDiff && (
              <div
                className="h-full w-full"
                style={{ backgroundColor: "#2c2c2c" }}
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
    </div>
  );
}
