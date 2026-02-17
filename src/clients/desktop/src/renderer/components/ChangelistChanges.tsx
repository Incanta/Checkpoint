import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Splitter, SplitterPanel } from "primereact/splitter";
// @ts-ignore
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  changelistChangesAtom,
  ChangelistChangesState,
  ChangelistFileChange,
  workspaceHistoryAtom,
} from "../../common/state/workspace";
import { store } from "../../common/state/store";
import { ipc } from "../pages/ipc";

interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  changeType?: "ADD" | "DELETE" | "MODIFY";
  children: FileTreeNode[];
  expanded?: boolean;
}

function buildFileTree(files: ChangelistFileChange[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const existingNode = currentLevel.find((n) => n.name === part);

      if (existingNode) {
        if (isLast) {
          existingNode.changeType = file.changeType;
        }
        currentLevel = existingNode.children;
      } else {
        const newNode: FileTreeNode = {
          name: part,
          path: isLast ? file.path : parts.slice(0, i + 1).join("/"),
          isDirectory: !isLast,
          changeType: isLast ? file.changeType : undefined,
          children: [],
          expanded: true,
        };
        currentLevel.push(newNode);
        currentLevel = newNode.children;
      }
    }
  }

  return root;
}

const changeTypeColors: Record<string, string> = {
  ADD: "#4CAF50",
  DELETE: "#F44336",
  MODIFY: "#2196F3",
};

const changeTypeLabels: Record<string, string> = {
  ADD: "A",
  DELETE: "D",
  MODIFY: "M",
};

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
}

function FileTreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  expandedPaths,
  onToggleExpand,
}: FileTreeItemProps) {
  const isSelected = node.path === selectedPath && !node.isDirectory;
  const isExpanded = expandedPaths.has(node.path);

  return (
    <>
      <div
        onClick={() => {
          if (node.isDirectory) {
            onToggleExpand(node.path);
          } else {
            onSelect(node.path);
          }
        }}
        style={{
          padding: "0.25rem 0.5rem",
          paddingLeft: `${depth + 0.5}rem`,
          cursor: "pointer",
          backgroundColor: isSelected ? "#3A3A3A" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: "0.85rem",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLDivElement).style.backgroundColor =
              "#374151";
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLDivElement).style.backgroundColor =
              "transparent";
          }
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.35rem",
            overflow: "hidden",
          }}
        >
          {node.isDirectory ? (
            <span
              style={{
                fontSize: "0.75rem",
                color: "#9CA3AF",
                width: "1rem",
                textAlign: "center",
              }}
            >
              {isExpanded ? "▼" : "▶"}
            </span>
          ) : (
            <span style={{ width: "1rem" }} />
          )}
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {node.name}
          </span>
        </span>
        {node.changeType && (
          <span
            style={{
              fontSize: "0.7rem",
              fontWeight: "bold",
              color:
                changeTypeColors[node.changeType] ||
                "var(--color-text-secondary)",
              marginLeft: "0.5rem",
              flexShrink: 0,
            }}
          >
            {changeTypeLabels[node.changeType]}
          </span>
        )}
      </div>
      {node.isDirectory &&
        isExpanded &&
        node.children.map((child) => (
          <FileTreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            expandedPaths={expandedPaths}
            onToggleExpand={onToggleExpand}
          />
        ))}
    </>
  );
}

interface ChangelistChangesProps {
  isPopout?: boolean;
}

export default function ChangelistChanges({
  isPopout = false,
}: ChangelistChangesProps) {
  const atomValue = useAtomValue(changelistChangesAtom);
  const [localState, setLocalState] = useState<ChangelistChangesState | null>(
    null,
  );

  // Popout: capture the atom value into local state once it arrives from sync
  useEffect(() => {
    if (isPopout && localState === null && atomValue !== null) {
      setLocalState(atomValue);
    }
  }, [isPopout, localState, atomValue]);

  // In popout mode, use local state; otherwise use the shared atom
  const changelistChanges = isPopout ? localState : atomValue;

  const monacoEl = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] =
    useState<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeNodes, setTreeNodes] = useState<FileTreeNode[]>([]);

  const handleBack = () => {
    if (isPopout) {
      window.close();
    } else {
      ipc.sendMessage("workspace:history:close", null);
    }
  };

  const handleOpenInNewWindow = () => {
    ipc.sendMessage("workspace:history:open-window", null);
  };

  const handleSelectFile = async (filePath: string) => {
    if (isPopout && localState) {
      // Popout: compute previousChangelistNumber from workspace history, invoke for diff
      const history = store.get(workspaceHistoryAtom);
      const changelist = history?.find(
        (cl) => cl.number === localState.changelistNumber,
      );
      const previousChangelistNumber = changelist?.parentNumber ?? null;

      setLocalState({
        ...localState,
        selectedFilePath: filePath,
        diffContent: null,
      });

      const diffResult = await ipc.invoke("popout:get-diff", {
        filePath,
        changelistNumber: localState.changelistNumber,
        previousChangelistNumber,
      });

      setLocalState((prev) =>
        prev
          ? { ...prev, selectedFilePath: filePath, diffContent: diffResult }
          : prev,
      );
    } else {
      ipc.sendMessage("workspace:history:select-file", { filePath });
    }
  };

  const handleToggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Build tree when files change
  useEffect(() => {
    if (changelistChanges?.files) {
      const tree = buildFileTree(changelistChanges.files);
      setTreeNodes(tree);

      // Auto-expand all directories
      const allDirPaths = new Set<string>();
      const collectDirPaths = (nodes: FileTreeNode[]) => {
        for (const node of nodes) {
          if (node.isDirectory) {
            allDirPaths.add(node.path);
            collectDirPaths(node.children);
          }
        }
      };
      collectDirPaths(tree);
      setExpandedPaths(allDirPaths);
    }
  }, [changelistChanges?.files]);

  // Set up the diff editor when diffContent changes
  useEffect(() => {
    if (monacoEl?.current && changelistChanges?.diffContent) {
      setEditor((currentEditor: monaco.editor.IStandaloneDiffEditor | null) => {
        if (currentEditor) {
          currentEditor.dispose();
          monacoEl.current!.innerHTML = "";
        }

        const filePath = changelistChanges.selectedFilePath || "";
        const extension = filePath.split(".").pop() || "";
        const languageMap: Record<string, string> = {
          ts: "typescript",
          tsx: "typescript",
          js: "javascript",
          jsx: "javascript",
          json: "json",
          css: "css",
          html: "html",
          md: "markdown",
          py: "python",
          rs: "rust",
          go: "go",
          cpp: "cpp",
          c: "c",
          h: "cpp",
          hpp: "cpp",
          yaml: "yaml",
          yml: "yaml",
          xml: "xml",
          sql: "sql",
          sh: "shell",
          bat: "bat",
        };
        const language = languageMap[extension] || "text/plain";

        const newEditor = monaco.editor.createDiffEditor(monacoEl.current!, {
          theme: "vs-dark",
          automaticLayout: true,
          readOnly: true,
          renderSideBySide: true,
        });

        newEditor.setModel({
          original: monaco.editor.createModel(
            changelistChanges.diffContent!.left,
            language,
          ),
          modified: monaco.editor.createModel(
            changelistChanges.diffContent!.right,
            language,
          ),
        });

        newEditor.getOriginalEditor().updateOptions({ readOnly: true });
        newEditor.getModifiedEditor().updateOptions({ readOnly: true });

        return newEditor;
      });
    }
  }, [changelistChanges?.diffContent, changelistChanges?.selectedFilePath]);

  // Clean up editor on unmount
  useEffect(() => {
    return () => {
      if (editor) {
        editor.dispose();
      }
    };
  }, [editor]);

  if (!changelistChanges) {
    return null;
  }

  const selectedFile = changelistChanges.files.find(
    (f) => f.path === changelistChanges.selectedFilePath,
  );

  return (
    <div
      className={
        isPopout
          ? "grid grid-rows-[2.5rem_calc(100vh-2.5rem)]"
          : "grid grid-rows-[2.5rem_calc(100vh-8.5rem)] gap-4"
      }
    >
      <div
        className="row-span-1 flex items-center space-x-2"
        style={{
          backgroundColor: "var(--color-panel)",
          borderColor: "var(--color-border)",
          borderWidth: "0 0 1px 0",
          borderStyle: "solid",
          padding: "0.3rem",
        }}
      >
        <button
          onClick={handleBack}
          title="Back to history"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "0.3rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "0.25rem",
            color: "var(--color-text-secondary)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor =
              "#404040";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor =
              "transparent";
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span>
          Changes in{" "}
          <span style={{ fontWeight: "bold" }}>
            CL {changelistChanges.changelistNumber}
          </span>
          {changelistChanges.message && (
            <span style={{ color: "#9CA3AF" }}>
              {" "}
              &mdash; {changelistChanges.message}
            </span>
          )}
        </span>
        {!isPopout && (
          <button
            onClick={handleOpenInNewWindow}
            title="Open in new window"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "0.3rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "0.25rem",
              color: "var(--color-text-secondary)",
              marginLeft: "auto",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "#404040";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "transparent";
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
      </div>
      <div
        className="row-span-1"
        style={{ textAlign: "left", overflow: "hidden" }}
      >
        <Splitter
          layout="horizontal"
          className="w-full h-full"
          pt={{
            gutter: {
              className: "file-history-splitter-gutter",
            },
          }}
        >
          <SplitterPanel className="flex flex-col" size={30}>
            <div
              className="h-full overflow-y-auto"
              style={{ backgroundColor: "var(--color-surface)" }}
            >
              {changelistChanges.files.length === 0 ? (
                <div className="p-4 text-gray-500 text-center">
                  No files changed in this changelist
                </div>
              ) : (
                <div style={{ padding: "0.25rem 0" }}>
                  <div
                    style={{
                      padding: "0.4rem 0.75rem",
                      fontSize: "0.75rem",
                      color: "#9CA3AF",
                      borderBottom: "1px solid #374151",
                      marginBottom: "0.25rem",
                    }}
                  >
                    {changelistChanges.files.length} file
                    {changelistChanges.files.length !== 1 ? "s" : ""} changed
                  </div>
                  {treeNodes.map((node) => (
                    <FileTreeItem
                      key={node.path}
                      node={node}
                      depth={0}
                      selectedPath={changelistChanges.selectedFilePath}
                      onSelect={handleSelectFile}
                      expandedPaths={expandedPaths}
                      onToggleExpand={handleToggleExpand}
                    />
                  ))}
                </div>
              )}
            </div>
          </SplitterPanel>
          <SplitterPanel className="flex flex-col" size={70}>
            {selectedFile && changelistChanges.diffContent ? (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div
                  style={{
                    backgroundColor: "#252525",
                    padding: "0.5rem 0.75rem",
                    borderBottom: "1px solid #374151",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.875rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {selectedFile.path}
                  </span>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: "bold",
                      paddingLeft: "0.5rem",
                      paddingRight: "0.5rem",
                      paddingTop: "0.125rem",
                      paddingBottom: "0.125rem",
                      borderRadius: "0.25rem",
                      backgroundColor:
                        changeTypeColors[selectedFile.changeType] ||
                        "var(--color-border-lighter)",
                      flexShrink: 0,
                    }}
                  >
                    {selectedFile.changeType}
                  </span>
                </div>
                <div style={{ flex: 1 }} ref={monacoEl}></div>
              </div>
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#6B7280",
                }}
              >
                Select a file to view the diff
              </div>
            )}
          </SplitterPanel>
        </Splitter>
      </div>
    </div>
  );
}
