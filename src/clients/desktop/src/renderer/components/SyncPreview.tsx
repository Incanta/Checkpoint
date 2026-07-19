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
import { Button, EmptyState } from "./ui";

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
    <div className="absolute inset-0 grid grid-rows-[2.5rem_1fr]">
      {/* Header bar */}
      <div className="row-span-1 flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClose}
          title="Close sync preview"
          className="!p-1.5"
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
        </Button>
        <span className="text-sm text-[var(--color-text-primary)]">
          <span className="font-semibold">Incoming Changes</span>
          <span className="text-[var(--color-text-muted)]">
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
            <div className="h-full overflow-y-auto bg-[var(--color-bg-secondary)]">
              {/* View mode toggle */}
              <div className="flex border-b border-[var(--color-border-default)]">
                <button
                  onClick={() => setViewMode("files")}
                  className={`flex-1 cursor-pointer py-1.5 text-xs transition-colors ${
                    viewMode === "files"
                      ? "bg-[var(--color-bg-surface)] text-[var(--color-text-primary)]"
                      : "bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                  }`}
                >
                  Files ({totalFiles})
                </button>
                <button
                  onClick={() => setViewMode("changelists")}
                  className={`flex-1 cursor-pointer py-1.5 text-xs transition-colors ${
                    viewMode === "changelists"
                      ? "bg-[var(--color-bg-surface)] text-[var(--color-text-primary)]"
                      : "bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                  }`}
                >
                  Changelists ({syncPreview.changelists.length})
                </button>
              </div>

              {viewMode === "files" ? (
                <>
                  {/* File summary */}
                  <div className="mb-1 flex gap-3 border-b border-[var(--color-border-muted)] px-3 py-1.5 text-xs text-[var(--color-text-muted)]">
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
                    <EmptyState title="No incoming file changes" />
                  ) : (
                    <div className="py-1">
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
                <div className="py-1">
                  {syncPreview.changelists.map((cl) => (
                    <div
                      key={cl.changelistNumber}
                      className="border-b border-[var(--color-border-muted)] px-3 py-2"
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                          CL {cl.changelistNumber}
                        </span>
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {cl.files.length} file
                          {cl.files.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      {cl.message && (
                        <div className="mb-1 text-sm text-[var(--color-text-secondary)]">
                          {cl.message}
                        </div>
                      )}
                      <div className="text-xs text-[var(--color-text-muted)]">
                        {cl.user} &mdash;{" "}
                        {new Date(cl.date).toLocaleDateString()}
                      </div>
                      {/* File list within changelist */}
                      <div className="mt-1.5">
                        {cl.files.map((file) => {
                          const isSelected =
                            syncPreview.selectedFilePath === file.path;
                          return (
                            <div
                              key={file.path}
                              onClick={() => handleSelectFile(file.path)}
                              className="flex cursor-pointer items-center justify-between rounded-sm px-2 py-0.5 text-sm text-[var(--color-text-secondary)]"
                              style={{
                                backgroundColor: isSelected
                                  ? "var(--color-accent-muted)"
                                  : "transparent",
                              }}
                              onMouseEnter={(e) => {
                                if (!isSelected) {
                                  (
                                    e.currentTarget as HTMLDivElement
                                  ).style.backgroundColor =
                                    "var(--color-bg-overlay)";
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (!isSelected) {
                                  (
                                    e.currentTarget as HTMLDivElement
                                  ).style.backgroundColor = "transparent";
                                }
                              }}
                            >
                              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
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
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SplitterPanel>
          <SplitterPanel className="flex flex-col" size={70}>
            {selectedFile && syncPreview.diffContent ? (
              <div className="flex h-full flex-col">
                <div className="flex items-center justify-between border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2">
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-[var(--color-text-primary)]">
                    {selectedFile.path}
                  </span>
                  <span
                    className="flex-shrink-0 rounded px-2 py-0.5 text-xs font-bold text-white"
                    style={{
                      backgroundColor:
                        changeTypeColors[selectedFile.changeType] ||
                        "var(--color-bg-surface)",
                    }}
                  >
                    {selectedFile.changeType}
                  </span>
                </div>
                <div style={{ flex: 1 }} ref={monacoEl}></div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center">
                <EmptyState title="Select a file to view the incoming diff" />
              </div>
            )}
          </SplitterPanel>
        </Splitter>
      </div>
    </div>
  );
}
