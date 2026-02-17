import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Splitter, SplitterPanel } from "primereact/splitter";
// @ts-ignore
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  fileHistoryAtom,
  FileHistoryEntry,
  FileHistoryState,
} from "../../common/state/workspace";
import { ipc } from "../pages/ipc";

interface ChangelistItemProps {
  entry: FileHistoryEntry;
  isSelected: boolean;
  onSelect: () => void;
}

function ChangelistItem({ entry, isSelected, onSelect }: ChangelistItemProps) {
  const changeTypeColors: Record<string, string> = {
    ADD: "#4CAF50",
    DELETE: "#F44336",
    MODIFY: "#2196F3",
  };

  return (
    <div
      onClick={onSelect}
      style={{
        padding: "0.5rem",
        cursor: "pointer",
        borderBottom: "1px solid #374151",
        backgroundColor: isSelected ? "#3A3A3A" : "var(--color-panel)",
      }}
      onMouseEnter={(e) => {
        if (!isSelected)
          (e.currentTarget as HTMLDivElement).style.backgroundColor = "#374151";
      }}
      onMouseLeave={(e) => {
        if (!isSelected)
          (e.currentTarget as HTMLDivElement).style.backgroundColor =
            "var(--color-panel)";
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontWeight: "bold" }}>CL {entry.changelistNumber}</span>
        {entry.changeType !== "MODIFY" && (
          <span
            style={{
              fontSize: "0.75rem",
              paddingLeft: "0.5rem",
              paddingRight: "0.5rem",
              paddingTop: "0.125rem",
              paddingBottom: "0.125rem",
              borderRadius: "0.25rem",
              backgroundColor:
                changeTypeColors[entry.changeType] ||
                "var(--color-border-lighter)",
            }}
          >
            {entry.changeType}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: "0.875rem",
          color: "#9CA3AF",
          marginTop: "0.25rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.changelist.message || "(No description)"}
      </div>
      <div
        style={{
          fontSize: "0.75rem",
          color: "#6B7280",
          marginTop: "0.25rem",
        }}
      >
        {entry.changelist.user?.name ||
          entry.changelist.user?.username ||
          entry.changelist.user?.email ||
          "Unknown user"}
        {" • "}
        {new Date(entry.changelist.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}

interface FileHistoryProps {
  isPopout?: boolean;
}

export default function FileHistory({ isPopout = false }: FileHistoryProps) {
  const atomValue = useAtomValue(fileHistoryAtom);
  const [localState, setLocalState] = useState<FileHistoryState | null>(null);

  // Popout: capture the atom value into local state once it arrives from sync
  useEffect(() => {
    if (isPopout && localState === null && atomValue !== null) {
      setLocalState(atomValue);
    }
  }, [isPopout, localState, atomValue]);

  // In popout mode, use local state; otherwise use the shared atom
  const fileHistory = isPopout ? localState : atomValue;

  const monacoEl = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] =
    useState<monaco.editor.IStandaloneDiffEditor | null>(null);

  const handleBack = () => {
    if (isPopout) {
      window.close();
    } else {
      ipc.sendMessage("file:history:close", null);
    }
  };

  const handleOpenInNewWindow = () => {
    ipc.sendMessage("file:history:open-window", null);
  };

  const handleSelectChangelist = async (changelistNumber: number) => {
    if (isPopout && localState) {
      // Popout: compute previousChangelistNumber locally, invoke for diff
      const entries = localState.entries;
      const selectedIndex = entries.findIndex(
        (e) => e.changelistNumber === changelistNumber,
      );
      const previousEntry =
        selectedIndex >= 0 && selectedIndex < entries.length - 1
          ? entries[selectedIndex + 1]
          : null;

      setLocalState({
        ...localState,
        selectedChangelistNumber: changelistNumber,
        diffContent: null,
      });

      const diffResult = await ipc.invoke("popout:get-diff", {
        filePath: localState.filePath,
        changelistNumber,
        previousChangelistNumber: previousEntry?.changelistNumber ?? null,
      });

      setLocalState((prev) =>
        prev
          ? {
              ...prev,
              selectedChangelistNumber: changelistNumber,
              diffContent: diffResult,
            }
          : prev,
      );
    } else {
      ipc.sendMessage("file:history:select-changelist", { changelistNumber });
    }
  };

  // Set up the diff editor when diffContent changes
  useEffect(() => {
    if (monacoEl?.current && fileHistory?.diffContent) {
      setEditor((currentEditor: monaco.editor.IStandaloneDiffEditor | null) => {
        if (currentEditor) {
          currentEditor.dispose();
          monacoEl.current!.innerHTML = "";
        }
        const newEditor = monaco.editor.createDiffEditor(monacoEl.current!, {
          theme: "vs-dark",
          automaticLayout: true,
          readOnly: true,
          renderSideBySide: true,
        });

        newEditor.setModel({
          original: monaco.editor.createModel(
            fileHistory.diffContent!.left,
            "text/plain",
          ),
          modified: monaco.editor.createModel(
            fileHistory.diffContent!.right,
            "text/plain",
          ),
        });

        newEditor.getOriginalEditor().updateOptions({ readOnly: true });
        newEditor.getModifiedEditor().updateOptions({ readOnly: true });

        return newEditor;
      });
    }
  }, [fileHistory?.diffContent]);

  // Clean up editor on unmount
  useEffect(() => {
    return () => {
      if (editor) {
        editor.dispose();
      }
    };
  }, [editor]);

  if (!fileHistory) {
    return null;
  }

  const selectedEntry = fileHistory.entries.find(
    (e) => e.changelistNumber === fileHistory.selectedChangelistNumber,
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
          title="Back to workspace"
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
          Changelist history for{" "}
          <span style={{ fontWeight: "bold" }}>{fileHistory.filePath}</span>
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
          <SplitterPanel className="flex flex-col" size={35}>
            <div
              className="h-full overflow-y-auto"
              style={{ backgroundColor: "var(--color-surface)" }}
            >
              {fileHistory.entries.length === 0 ? (
                <div className="p-4 text-gray-500 text-center">
                  No history found for this file
                </div>
              ) : (
                fileHistory.entries.map((entry) => (
                  <ChangelistItem
                    key={entry.changelistNumber}
                    entry={entry}
                    isSelected={
                      entry.changelistNumber ===
                      fileHistory.selectedChangelistNumber
                    }
                    onSelect={() =>
                      handleSelectChangelist(entry.changelistNumber)
                    }
                  />
                ))
              )}
            </div>
          </SplitterPanel>
          <SplitterPanel className="flex flex-col" size={65}>
            {selectedEntry && fileHistory.diffContent ? (
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
                    padding: "0.75rem",
                    borderBottom: "1px solid #374151",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <span style={{ fontWeight: "bold", fontSize: "1.125rem" }}>
                      CL {selectedEntry.changelistNumber}
                    </span>
                    <span style={{ color: "#9CA3AF", fontSize: "0.875rem" }}>
                      {new Date(
                        selectedEntry.changelist.createdAt,
                      ).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.875rem" }}>
                    {selectedEntry.changelist.message || "(No description)"}
                  </div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "#6B7280",
                      marginTop: "0.25rem",
                    }}
                  >
                    By{" "}
                    {selectedEntry.changelist.user?.name ||
                      selectedEntry.changelist.user?.username ||
                      selectedEntry.changelist.user?.email ||
                      "Unknown user"}
                  </div>
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
                Select a changelist to view the diff
              </div>
            )}
          </SplitterPanel>
        </Splitter>
      </div>
    </div>
  );
}
