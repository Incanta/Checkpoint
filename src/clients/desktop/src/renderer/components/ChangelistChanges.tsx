import { useCallback, useEffect, useRef, useState } from "react";
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
import FileTreeItem, { changeTypeColors } from "./FileTreeItem";
import type { FileTreeNode } from "./FileTreeItem";
import { buildFileTree, collectDirPaths } from "./build-file-tree";
import { Button, EmptyState } from "./ui";

const DESCRIPTION_MIN_HEIGHT = 32;
const DESCRIPTION_AUTO_MAX_HEIGHT = 96;
const CONTENT_MIN_HEIGHT = 160;

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

  // Description panel height. null = fit the message, capped by
  // DESCRIPTION_AUTO_MAX_HEIGHT; a number = the height the user dragged to.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const descriptionRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ y: number; height: number } | null>(null);
  const [descriptionHeight, setDescriptionHeight] = useState<number | null>(
    null,
  );

  const handleDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!descriptionRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = {
      y: e.clientY,
      height: descriptionRef.current.offsetHeight,
    };
  };

  const handleDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    // Leave room for the file list and diff below.
    const maxHeight = Math.max(
      DESCRIPTION_MIN_HEIGHT,
      (rootRef.current?.offsetHeight ?? 0) - CONTENT_MIN_HEIGHT,
    );
    const next = start.height + (e.clientY - start.y);
    setDescriptionHeight(
      Math.min(maxHeight, Math.max(DESCRIPTION_MIN_HEIGHT, next)),
    );
  };

  const handleDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

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

  const handleSelectFile = useCallback(
    async (filePath: string) => {
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
    },
    [isPopout, localState],
  );

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

  // Build tree when files change
  useEffect(() => {
    if (changelistChanges?.files) {
      const tree = buildFileTree(changelistChanges.files);
      setTreeNodes(tree);

      // Auto-expand all directories
      setExpandedPaths(collectDirPaths(tree));
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
      ref={rootRef}
      className={`flex flex-col ${isPopout ? "h-screen" : "h-full"}`}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleBack}
          title="Back to history"
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
          Changes in{" "}
          <span className="font-semibold">
            CL {changelistChanges.changelistNumber}
          </span>
        </span>
        {!isPopout && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenInNewWindow}
            title="Open in new window"
            className="!ml-auto !p-1.5"
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
          </Button>
        )}
      </div>
      {changelistChanges.message && (
        <>
          <div
            ref={descriptionRef}
            className="scroll-on-secondary shrink-0 overflow-y-auto whitespace-pre-wrap break-words bg-[var(--color-bg-secondary)] px-3 py-2 text-left text-sm text-[var(--color-text-muted)] select-text"
            style={
              descriptionHeight === null
                ? { maxHeight: DESCRIPTION_AUTO_MAX_HEIGHT }
                : { height: descriptionHeight }
            }
          >
            {changelistChanges.message}
          </div>
          <div
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize. Double-click to reset."
            className="flex h-[calc(4px+0.4rem)] shrink-0 cursor-row-resize touch-none items-center justify-center border-y border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] transition-colors hover:bg-[var(--color-accent)]"
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragEnd}
            onPointerCancel={handleDragEnd}
            onDoubleClick={() => setDescriptionHeight(null)}
          >
            <div className="h-1 w-6 rounded-lg bg-[var(--color-text-muted)]" />
          </div>
        </>
      )}
      <div
        className="min-h-0 flex-1"
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
            <div className="scroll-on-secondary h-full overflow-y-auto bg-[var(--color-bg-secondary)]">
              {changelistChanges.files.length === 0 ? (
                <EmptyState title="No files changed in this changelist" />
              ) : (
                <div>
                  <div className="border-b border-[var(--color-border-muted)] px-3 py-1.5 text-xs text-[var(--color-text-muted)]">
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
                <EmptyState title="Select a file to view the diff" />
              </div>
            )}
          </SplitterPanel>
        </Splitter>
      </div>
    </div>
  );
}
