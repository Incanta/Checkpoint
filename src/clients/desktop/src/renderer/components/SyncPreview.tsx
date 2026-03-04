import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Splitter, SplitterPanel } from "primereact/splitter";
// @ts-ignore
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  workspaceSyncPreviewAtom,
  workspaceSyncStatusAtom,
  SyncPreviewState,
  SyncPreviewChangelist,
  SyncPreviewFileChange,
} from "../../common/state/workspace";
import { ipc } from "../pages/ipc";
import FileTreeItem, {
  changeTypeColors,
  changeTypeLabels,
} from "./FileTreeItem";
import type { FileTreeNode } from "./FileTreeItem";
import {
  buildFileTree as buildFileTreeGeneric,
  collectDirPaths,
} from "./build-file-tree";

interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  changeType?: "ADD" | "DELETE" | "MODIFY";
  /** Which CLs this file was changed in */
  changelists?: number[];
  children: FileTreeNode[];
  expanded?: boolean;
}

/**
 * Aggregates file changes across all incoming changelists into a single
 * deduplicated list. If a file is modified in multiple CLs, we show it
 * once with the latest change type.
 */
function aggregateFileChanges(
  changelists: SyncPreviewChangelist[],
): SyncPreviewFileChange[] {
  const fileMap = new Map<
    string,
    SyncPreviewFileChange & { changelists: number[] }
  >();

  for (const cl of changelists) {
    for (const file of cl.files) {
      const existing = fileMap.get(file.path);
      if (existing) {
        // Keep the latest change type and add this CL number
        existing.changeType = file.changeType;
        existing.changelists.push(cl.changelistNumber);
      } else {
        fileMap.set(file.path, {
          ...file,
          changelists: [cl.changelistNumber],
        });
      }
    }
  }

  return Array.from(fileMap.values());
}

export default function SyncPreview() {
  const syncPreview = useAtomValue(workspaceSyncPreviewAtom);
  const syncStatus = useAtomValue(workspaceSyncStatusAtom);

  const monacoEl = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] =
    useState<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeNodes, setTreeNodes] = useState<FileTreeNode[]>([]);
  const [aggregatedFiles, setAggregatedFiles] = useState<
    SyncPreviewFileChange[]
  >([]);
  const [viewMode, setViewMode] = useState<"files" | "changelists">("files");

  const handleClose = useCallback(() => {
    ipc.sendMessage("workspace:sync-preview:close", null);
  }, []);

  const handleSelectFile = useCallback((filePath: string) => {
    ipc.sendMessage("workspace:sync-preview:select-file", { filePath });
  }, []);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Aggregate files when preview data changes
  useEffect(() => {
    if (syncPreview?.allFileChanges) {
      const files = aggregateFileChanges(syncPreview.allFileChanges);
      setAggregatedFiles(files);
      const tree = buildFileTreeGeneric(files);
      setTreeNodes(tree);

      // Auto-expand all directories
      setExpandedPaths(collectDirPaths(tree));
    }
  }, [syncPreview?.allFileChanges]);

  // Set up the diff editor when diffContent changes
  useEffect(() => {
    if (monacoEl?.current && syncPreview?.diffContent) {
      setEditor((currentEditor: monaco.editor.IStandaloneDiffEditor | null) => {
        if (currentEditor) {
          currentEditor.dispose();
          monacoEl.current!.innerHTML = "";
        }

        const filePath = syncPreview.selectedFilePath || "";
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
            syncPreview.diffContent!.left,
            language,
          ),
          modified: monaco.editor.createModel(
            syncPreview.diffContent!.right,
            language,
          ),
        });

        newEditor.getOriginalEditor().updateOptions({ readOnly: true });
        newEditor.getModifiedEditor().updateOptions({ readOnly: true });

        return newEditor;
      });
    }
  }, [syncPreview?.diffContent, syncPreview?.selectedFilePath]);

  // Clean up editor on unmount
  useEffect(() => {
    return () => {
      if (editor) {
        editor.dispose();
      }
    };
  }, [editor]);

  if (!syncPreview) {
    return null;
  }

  const selectedFile = aggregatedFiles.find(
    (f) => f.path === syncPreview.selectedFilePath,
  );

  const { totalFiles, addedCount, modifiedCount, deletedCount } =
    useMemo(() => {
      let added = 0;
      let modified = 0;
      let deleted = 0;
      for (const f of aggregatedFiles) {
        if (f.changeType === "ADD") added++;
        else if (f.changeType === "MODIFY") modified++;
        else if (f.changeType === "DELETE") deleted++;
      }
      return {
        totalFiles: aggregatedFiles.length,
        addedCount: added,
        modifiedCount: modified,
        deletedCount: deleted,
      };
    }, [aggregatedFiles]);

  return (
    <div className="grid grid-rows-[2.5rem_calc(100vh-8.5rem)] gap-4">
      {/* Header bar */}
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
          onClick={handleClose}
          title="Close sync preview"
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
          <span style={{ fontWeight: "bold" }}>Incoming Changes</span>
          <span style={{ color: "#9CA3AF" }}>
            {" "}
            &mdash; {syncPreview.syncStatus.changelistsBehind} changelist
            {syncPreview.syncStatus.changelistsBehind !== 1 ? "s" : ""} behind
            (CL {syncPreview.syncStatus.localChangelistNumber} &rarr; CL{" "}
            {syncPreview.syncStatus.remoteHeadNumber})
          </span>
        </span>
      </div>

      {/* Main content */}
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
              {/* View mode toggle */}
              <div
                style={{
                  display: "flex",
                  borderBottom: "1px solid #374151",
                }}
              >
                <button
                  onClick={() => setViewMode("files")}
                  style={{
                    flex: 1,
                    padding: "0.4rem",
                    fontSize: "0.75rem",
                    border: "none",
                    cursor: "pointer",
                    backgroundColor:
                      viewMode === "files" ? "#374151" : "transparent",
                    color:
                      viewMode === "files"
                        ? "#fff"
                        : "var(--color-text-secondary)",
                  }}
                >
                  Files ({totalFiles})
                </button>
                <button
                  onClick={() => setViewMode("changelists")}
                  style={{
                    flex: 1,
                    padding: "0.4rem",
                    fontSize: "0.75rem",
                    border: "none",
                    cursor: "pointer",
                    backgroundColor:
                      viewMode === "changelists" ? "#374151" : "transparent",
                    color:
                      viewMode === "changelists"
                        ? "#fff"
                        : "var(--color-text-secondary)",
                  }}
                >
                  Changelists ({syncPreview.changelists.length})
                </button>
              </div>

              {viewMode === "files" ? (
                <>
                  {/* File summary */}
                  <div
                    style={{
                      padding: "0.4rem 0.75rem",
                      fontSize: "0.75rem",
                      color: "#9CA3AF",
                      borderBottom: "1px solid #374151",
                      marginBottom: "0.25rem",
                      display: "flex",
                      gap: "0.75rem",
                    }}
                  >
                    <span>
                      {totalFiles} file{totalFiles !== 1 ? "s" : ""}
                    </span>
                    {addedCount > 0 && (
                      <span style={{ color: changeTypeColors.ADD }}>
                        +{addedCount}
                      </span>
                    )}
                    {modifiedCount > 0 && (
                      <span style={{ color: changeTypeColors.MODIFY }}>
                        ~{modifiedCount}
                      </span>
                    )}
                    {deletedCount > 0 && (
                      <span style={{ color: changeTypeColors.DELETE }}>
                        -{deletedCount}
                      </span>
                    )}
                  </div>

                  {totalFiles === 0 ? (
                    <div className="p-4 text-gray-500 text-center">
                      No incoming file changes
                    </div>
                  ) : (
                    <div style={{ padding: "0.25rem 0" }}>
                      {treeNodes.map((node) => (
                        <FileTreeItem
                          key={node.path}
                          node={node}
                          depth={0}
                          selectedPath={syncPreview.selectedFilePath}
                          onSelect={handleSelectFile}
                          expandedPaths={expandedPaths}
                          onToggleExpand={handleToggleExpand}
                        />
                      ))}
                    </div>
                  )}
                </>
              ) : (
                /* Changelist list view */
                <div style={{ padding: "0.25rem 0" }}>
                  {syncPreview.changelists.map((cl) => (
                    <div
                      key={cl.changelistNumber}
                      style={{
                        padding: "0.5rem 0.75rem",
                        borderBottom: "1px solid #374151",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "0.25rem",
                        }}
                      >
                        <span
                          style={{
                            fontWeight: "bold",
                            fontSize: "0.85rem",
                          }}
                        >
                          CL {cl.changelistNumber}
                        </span>
                        <span
                          style={{
                            fontSize: "0.7rem",
                            color: "#9CA3AF",
                          }}
                        >
                          {cl.files.length} file
                          {cl.files.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      {cl.message && (
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "#D1D5DB",
                            marginBottom: "0.2rem",
                          }}
                        >
                          {cl.message}
                        </div>
                      )}
                      <div
                        style={{
                          fontSize: "0.7rem",
                          color: "#6B7280",
                        }}
                      >
                        {cl.user} &mdash;{" "}
                        {new Date(cl.date).toLocaleDateString()}
                      </div>
                      {/* File list within changelist */}
                      <div style={{ marginTop: "0.3rem" }}>
                        {cl.files.map((file) => (
                          <div
                            key={file.path}
                            onClick={() => handleSelectFile(file.path)}
                            style={{
                              padding: "0.15rem 0.5rem",
                              fontSize: "0.8rem",
                              cursor: "pointer",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              backgroundColor:
                                syncPreview.selectedFilePath === file.path
                                  ? "#3A3A3A"
                                  : "transparent",
                              borderRadius: "0.15rem",
                            }}
                            onMouseEnter={(e) => {
                              if (syncPreview.selectedFilePath !== file.path) {
                                (
                                  e.currentTarget as HTMLDivElement
                                ).style.backgroundColor = "#374151";
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (syncPreview.selectedFilePath !== file.path) {
                                (
                                  e.currentTarget as HTMLDivElement
                                ).style.backgroundColor = "transparent";
                              }
                            }}
                          >
                            <span
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {file.path}
                            </span>
                            <span
                              style={{
                                fontSize: "0.65rem",
                                fontWeight: "bold",
                                color:
                                  changeTypeColors[file.changeType] ||
                                  "var(--color-text-secondary)",
                                marginLeft: "0.5rem",
                                flexShrink: 0,
                              }}
                            >
                              {changeTypeLabels[file.changeType]}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SplitterPanel>
          <SplitterPanel className="flex flex-col" size={70}>
            {selectedFile && syncPreview.diffContent ? (
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
                Select a file to view the incoming diff
              </div>
            )}
          </SplitterPanel>
        </Splitter>
      </div>
    </div>
  );
}
