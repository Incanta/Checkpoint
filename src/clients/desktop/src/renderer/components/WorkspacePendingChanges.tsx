import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import DropdownButton from "./DropdownButton";
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
import prettyBytes from "pretty-bytes";
import { FileIcon } from "./FileIcon";

// ─── Hoisted constants (never recreated) ────────────────────────────
const itemBodyStyle: React.CSSProperties = {
  display: "inline",
  verticalAlign: "middle",
};

const itemBodyNameStyle: React.CSSProperties = {
  marginLeft: ".5em",
};

const treeTableRootStyle: React.CSSProperties = { height: "100%" };

const columnNameStyle: React.CSSProperties = { width: "40%" };

const columnSizeStyle: React.CSSProperties = { width: "5rem" };

// ─── Memoized TreeTable wrapper ─────────────────────────────────────
interface PendingChangesTreeProps {
  treeTableRef: React.RefObject<TreeTable | null>;
  nodes: TreeNode[];
  selectedNodeKeys: TreeTableSelectionKeysType | null;
  onSelectionChange: (e: any) => void;
  expandedKeys: TreeTableExpandedKeysType;
  onToggle: (e: any) => void;
  onExpand: (e: any) => void;
  highlightedRowKey: string | null;
  onRowClick: (e: any) => void;
  onContextMenu: (e: any) => void;
  treeTablePt: any;
  columnPt: ColumnPassThroughOptions;
  itemBodyTemplate: (rowData: any) => React.ReactNode;
}

const PendingChangesTree = React.memo(function PendingChangesTree({
  treeTableRef,
  nodes,
  selectedNodeKeys,
  onSelectionChange,
  expandedKeys,
  onToggle,
  onExpand,
  highlightedRowKey,
  onRowClick,
  onContextMenu,
  treeTablePt,
  columnPt,
  itemBodyTemplate,
}: PendingChangesTreeProps) {
  const rowClassName = useCallback(
    (node: TreeNode) => {
      const classes: Record<string, boolean> = {};
      if (node.key === highlightedRowKey) {
        classes["row-highlighted"] = true;
      }
      return classes;
    },
    [highlightedRowKey],
  );

  return (
    <TreeTable
      ref={treeTableRef}
      className="pending-changes-tree"
      value={nodes}
      columnResizeMode="expand"
      resizableColumns
      showGridlines
      selectionMode="checkbox"
      selectionKeys={selectedNodeKeys}
      onSelectionChange={onSelectionChange}
      expandedKeys={expandedKeys}
      onToggle={onToggle}
      onExpand={onExpand}
      rowClassName={rowClassName}
      onRowClick={onRowClick}
      onContextMenu={onContextMenu}
      pt={treeTablePt}
      style={treeTableRootStyle}
    >
      <Column
        field="name"
        header="Item"
        expander
        resizeable
        sortable
        body={itemBodyTemplate}
        pt={columnPt}
        style={columnNameStyle}
      />
      <Column
        field="status"
        header="Status"
        resizeable
        sortable
        pt={columnPt}
      />
      <Column
        field="size"
        header="Size"
        resizeable
        sortable
        pt={columnPt}
        style={columnSizeStyle}
      />
      <Column
        field="modified"
        header="Date Modified"
        resizeable
        sortable
        pt={columnPt}
      />
      <Column field="type" header="Type" resizeable sortable pt={columnPt} />
      <Column
        field="changelist"
        header="Changelist"
        resizeable
        sortable
        pt={columnPt}
      />
    </TreeTable>
  );
});

// ─── Main component ─────────────────────────────────────────────────
export default function WorkspacePendingChanges() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspacePendingChanges = useAtomValue(workspacePendingChangesAtom);
  const workspaceDiff = useAtomValue(workspaceDiffAtom);

  const treeTableRef = useRef<TreeTable>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selectedNodeKeys, setSelectedNodeKeys] =
    useState<TreeTableSelectionKeysType | null>(null);
  const selectedNodeKeysRef = useRef(selectedNodeKeys);
  selectedNodeKeysRef.current = selectedNodeKeys;
  const [expandedKeys, setExpandedKeys] = useState<TreeTableExpandedKeysType>(
    {},
  );

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

  /** Tracks which directory node keys have been checked by the user so
   * that lazily-loaded children can be auto-checked. */
  const checkedDirsRef = useRef<Set<string>>(new Set());

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
    resolveDialogVisible,
    setResolveDialogVisible,
    resolveDialogPath,
    resolveDontAsk,
    setResolveDontAsk,
    resolveDontAskDuration,
    setResolveDontAskDuration,
    confirmResolve,
  } = useFileContextMenu();
  const [menuItems, setMenuItems] = useState<any[]>([]);

  // Handler for right-click on rows
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, node: TreeNode) => {
      if (!currentWorkspace) return;

      const key = node.key as string;
      const relativePath = key.replace(/^\//, "");

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

  // Check if any files/directories are selected
  const hasSelectedFiles = useMemo(
    () =>
      selectedNodeKeys &&
      Object.entries(selectedNodeKeys).some(([, value]) => {
        const selection = value as {
          checked?: boolean;
          partialChecked?: boolean;
        };
        return selection.checked && !selection.partialChecked;
      }),
    [selectedNodeKeys],
  );

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
    if (!currentWorkspace || !workspacePendingChanges) {
      setNodes([]);
      return;
    }

    // Build a nested directory tree from the flat pending changes record.
    // Keys in files are relative paths; FileType.Directory entries are
    // lazy-loadable (children fetched via getDirectoryPending on expand).
    const rootChildren: TreeNode[] = [];

    // Helper: find-or-create intermediate directory nodes along a path.
    const ensureDirNode = (
      parts: string[],
      siblings: TreeNode[],
      parentKey: string,
    ): TreeNode => {
      const name = parts[0];
      const key = parentKey ? `${parentKey}/${name}` : name;

      let node = siblings.find((n) => n.key === key);
      if (!node) {
        node = {
          id: key,
          key,
          data: {
            name,
            ext: " ",
            status: "",
            size: "",
            modified: "",
            type: " ",
            changelist: "",
          },
          leaf: false,
          children: [],
        };
        siblings.push(node);
      }

      if (parts.length > 1) {
        if (!node.children) node.children = [];
        return ensureDirNode(parts.slice(1), node.children, key);
      }

      return node;
    };

    for (const [filePath, file] of Object.entries(
      workspacePendingChanges.files,
    )) {
      const parts = filePath.split("/").filter((p) => p.length > 0);
      if (parts.length === 0) continue;

      const filename = parts[parts.length - 1];

      if (file.type === FileType.Directory) {
        // Explicit directory entry – create / update the node.
        const node = ensureDirNode(parts, rootChildren, "");
        node.data = {
          name: filename,
          ext: " ",
          status: "",
          size: "",
          modified: "",
          type: "Directory",
          changelist: file.changelist ? file.changelist.toString() : "",
        };
        node.leaf = false;
        // Mark as lazy-loadable: empty children array means we'll fetch
        // contents from the daemon when the user expands this node.
        if (!node.children || node.children.length === 0) {
          node.children = [];
        }
      } else {
        // File entry
        const fileNode: TreeNode = {
          id: filePath,
          key: filePath,
          data: {
            path: file.path,
            name: filename,
            ext: filename.split(".").pop() || "",
            status: FileStatus[file.status],
            size: prettyBytes(file.size),
            modified: new Date(file.modifiedAt).toLocaleDateString(),
            type: FileType[file.type],
            changelist: file.changelist ? file.changelist.toString() : "",
          },
          leaf: true,
        };

        if (parts.length === 1) {
          rootChildren.push(fileNode);
        } else {
          // Nested file: ensure intermediate directory nodes exist.
          const parentNode = ensureDirNode(
            parts.slice(0, -1),
            rootChildren,
            "",
          );
          if (!parentNode.children) parentNode.children = [];
          parentNode.children.push(fileNode);
        }
      }
    }

    setNodes(rootChildren);
  }, [currentWorkspace, workspacePendingChanges]);

  // ─── Handle lazy-loading when a directory node is expanded ─────────
  const handleExpand = useCallback(
    (event: { node: TreeNode }) => {
      const node = event.node;
      if (!node || !currentWorkspace) return;

      // Only fetch when the node has no children yet (lazy placeholder).
      if (node.children && node.children.length > 0) return;

      const dirPath = node.key as string;

      ipc.once("workspace:directory-pending-contents", (data) => {
        if (data.path !== dirPath) return;

        const directory = data.directory;
        node.children = directory.children.map((file) => {
          const childKey = dirPath ? `${dirPath}/${file.path}` : file.path;
          const isDir = file.type === FileType.Directory;

          const childNode: TreeNode = {
            id: childKey,
            key: childKey,
            data: {
              path: isDir ? undefined : childKey,
              name: file.path,
              ext: isDir ? " " : file.path.split(".").pop() || "",
              status: FileStatus[file.status],
              size: isDir ? "" : prettyBytes(file.size),
              modified: isDir
                ? ""
                : new Date(file.modifiedAt).toLocaleDateString(),
              type: isDir ? "Directory" : FileType[file.type],
              changelist: file.changelist ? file.changelist.toString() : "",
            },
            leaf: !isDir,
            children: isDir ? [] : undefined,
          };

          return childNode;
        });

        // Auto-check children if the parent directory was checked.
        if (
          checkedDirsRef.current.has(dirPath) &&
          selectedNodeKeysRef.current
        ) {
          const updated = { ...selectedNodeKeysRef.current };
          for (const child of node.children ?? []) {
            const ck = child.key as string;
            updated[ck] = { checked: true, partialChecked: false };
            if (!child.leaf) {
              checkedDirsRef.current.add(ck);
            }
          }
          setSelectedNodeKeys(updated);
        }

        // Trigger a re-render by cloning the nodes array.
        setNodes((prev) => [...prev]);
      });

      ipc.sendMessage("workspace:get-directory-pending", { path: dirPath });
    },
    [currentWorkspace],
  );

  // ─── Track checked directories for auto-check on lazy load ────────
  const handleSelectionChange = useCallback(
    (e: { value: TreeTableSelectionKeysType | string }) => {
      const newKeys = e.value;

      if (typeof newKeys === "string") {
        // This case happens when selectionMode is "single", but we use "checkbox" mode, so it shouldn't occur.
        setSelectedNodeKeys({
          [newKeys]: { checked: true, partialChecked: false },
        });
        return;
      }

      setSelectedNodeKeys(newKeys);

      // Rebuild the set of checked directory keys.
      const dirs = new Set<string>();
      for (const [key, value] of Object.entries(newKeys)) {
        const sel = value as {
          checked?: boolean;
          partialChecked?: boolean;
        };
        if (sel.checked && !sel.partialChecked) {
          dirs.add(key);
        }
      }
      checkedDirsRef.current = dirs;
    },
    [],
  );

  const columnPt = useMemo<ColumnPassThroughOptions>(
    () => ({
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
    }),
    [],
  );

  const treeTablePt = useMemo(
    () => ({
      resizeHelper: {
        style: {
          width: "0.1rem",
          backgroundColor: "var(--color-border-lighter)",
        },
      },
      tbody: {
        style: {
          maxHeight: "initial",
          overflowY: "auto" as const,
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
          borderCollapse: "separate" as const,
          borderSpacing: 0,
          minWidth: "50rem",
          opacity: isSubmitting ? 0.5 : 1,
          pointerEvents: isSubmitting ? ("none" as const) : ("auto" as const),
        },
      },
    }),
    [isSubmitting],
  );

  const itemBodyTemplate = useCallback((rowData: any) => {
    return (
      <div style={itemBodyStyle}>
        <FileIcon extension={rowData.data.ext} />
        <span style={itemBodyNameStyle}>{rowData.data.name}</span>
      </div>
    );
  }, []);

  const handleToggle = useCallback(
    (e: { value: TreeTableExpandedKeysType }) => setExpandedKeys(e.value),
    [],
  );

  const rowClassName = useCallback(
    (node: TreeNode) => {
      const classes: Record<string, boolean> = {};
      if (node.key === highlightedRowKey) {
        classes["row-highlighted"] = true;
      }
      return classes;
    },
    [highlightedRowKey],
  );

  const handleRowClick = useCallback(
    (event: any) => {
      if (isSubmitting) return;
      const target = event.originalEvent.target as HTMLElement;
      if (target && target.tagName === "INPUT") return;
      if (event.node.data?.path) {
        setHighlightedRowKey(event.node.key as string);
        ipc.sendMessage("workspace:diff:file", {
          path: event.node.data.path,
        });
      }
    },
    [isSubmitting],
  );

  const handleContextMenu = useCallback(
    (event: any) => {
      handleRowContextMenu(event.originalEvent as React.MouseEvent, event.node);
    },
    [handleRowContextMenu],
  );

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
        <DropdownButton
          className="p-[0.3rem] text-[0.8em]"
          label="Refresh"
          disabled={isSubmitting}
          onClick={() => {
            ipc.sendMessage("workspace:refresh", null);
          }}
          items={[
            {
              label: "Refresh (Reload Ignore/Hidden)",
              onClick: () => {
                ipc.sendMessage("workspace:refresh-ignores", null);
              },
            },
          ]}
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

              // Key is the relative path directly (no category prefix).
              const relativePath = key.replace(/^\//, "");
              if (!relativePath) continue;

              const pendingChange =
                workspacePendingChanges!.files[relativePath];

              if (pendingChange) {
                // For directories the daemon will expand into individual
                // files during submit; for files send delete flag as needed.
                modifications.push({
                  path: relativePath,
                  delete: pendingChange.status === FileStatus.Deleted,
                });
              } else {
                // Key might belong to a lazily-loaded child that isn't in
                // the top-level pending map. Send it as a non-delete mod;
                // the daemon will figure out the correct status.
                modifications.push({
                  path: relativePath,
                  delete: false,
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
            <PendingChangesTree
              treeTableRef={treeTableRef}
              nodes={nodes}
              selectedNodeKeys={selectedNodeKeys}
              onSelectionChange={handleSelectionChange}
              expandedKeys={expandedKeys}
              onToggle={handleToggle}
              onExpand={handleExpand}
              highlightedRowKey={highlightedRowKey}
              onRowClick={handleRowClick}
              onContextMenu={handleContextMenu}
              treeTablePt={treeTablePt}
              columnPt={columnPt}
              itemBodyTemplate={itemBodyTemplate}
            />
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
        resolveDialogVisible={resolveDialogVisible}
        setResolveDialogVisible={setResolveDialogVisible}
        resolveDialogPath={resolveDialogPath}
        resolveDontAsk={resolveDontAsk}
        setResolveDontAsk={setResolveDontAsk}
        resolveDontAskDuration={resolveDontAskDuration}
        setResolveDontAskDuration={setResolveDontAskDuration}
        confirmResolve={confirmResolve}
      />
    </div>
  );
}
