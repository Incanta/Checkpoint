import React, { useEffect, useRef, useState } from "react";
import { ContextMenu } from "primereact/contextmenu";
import { MenuItem } from "primereact/menuitem";
import { Dialog } from "primereact/dialog";
import { useAtom, useAtomValue } from "jotai";
import { ipc } from "../pages/ipc";
import { userSettingsAtom } from "../../common/state/settings";
import { currentWorkspaceAtom } from "../../common/state/workspace";

export interface FileContextMenuProps {
  contextMenuRef: React.RefObject<ContextMenu | null>;
}

export interface FileContextInfo {
  /** Absolute path to the file/directory */
  absolutePath: string;
  /** Path relative to workspace root */
  relativePath: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** The file status string */
  status: string;
  /** Whether the file has a valid changelist */
  hasChangelist: boolean;
  /** The changelist ID if available */
  changelistId: number | null;
}

const isWindows = navigator.platform.toLowerCase().includes("win");

// Simple path utilities for browser environment
function getBasename(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const parts = normalizedPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function getExtname(filePath: string): string {
  const base = getBasename(filePath);
  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0) return "";
  return base.substring(lastDot);
}

// FileStatus enum values (matching the daemon types)
const FileStatusValues = {
  Unknown: 0,
  NotInWorkspaceRoot: 1,
  Local: 2,
  Added: 3,
  Renamed: 4,
  Deleted: 5,
  Ignored: 6,
  HiddenChanges: 7,
  ReadOnlyControlled: 8,
  WritableControlled: 9,
  ChangedNotCheckedOut: 10,
  ChangedCheckedOut: 11,
  NotChangedCheckedOut: 12,
  Conflicted: 13,
  Artifact: 14,
} as const;

type FileStatusType = (typeof FileStatusValues)[keyof typeof FileStatusValues];

function getFileStatusFromString(status: string): FileStatusType {
  const statusMap: Record<string, FileStatusType> = {
    "": FileStatusValues.Unknown,
    Unknown: FileStatusValues.Unknown,
    NotInWorkspaceRoot: FileStatusValues.NotInWorkspaceRoot,
    Local: FileStatusValues.Local,
    Added: FileStatusValues.Added,
    Renamed: FileStatusValues.Renamed,
    Deleted: FileStatusValues.Deleted,
    Ignored: FileStatusValues.Ignored,
    HiddenChanges: FileStatusValues.HiddenChanges,
    ReadOnlyControlled: FileStatusValues.ReadOnlyControlled,
    WritableControlled: FileStatusValues.WritableControlled,
    ChangedNotCheckedOut: FileStatusValues.ChangedNotCheckedOut,
    ChangedCheckedOut: FileStatusValues.ChangedCheckedOut,
    NotChangedCheckedOut: FileStatusValues.NotChangedCheckedOut,
    Conflicted: FileStatusValues.Conflicted,
    Artifact: FileStatusValues.Artifact,
  };
  return statusMap[status] ?? FileStatusValues.Unknown;
}

function isCheckedOut(status: FileStatusType): boolean {
  return (
    status === FileStatusValues.ChangedCheckedOut ||
    status === FileStatusValues.NotChangedCheckedOut
  );
}

function isIgnored(status: FileStatusType): boolean {
  return status === FileStatusValues.Ignored;
}

function isHidden(status: FileStatusType): boolean {
  return status === FileStatusValues.HiddenChanges;
}

export function useFileContextMenu() {
  const contextMenuRef = useRef<ContextMenu>(null);
  const currentFileRef = useRef<FileContextInfo | null>(null);
  const [userSettings, setUserSettings] = useAtom(userSettingsAtom);
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);

  // Locked warning dialog state
  const [lockedWarningVisible, setLockedWarningVisible] = useState(false);
  const [lockedWarningPath, setLockedWarningPath] = useState("");
  const [lockedWarningUser, setLockedWarningUser] = useState("");
  const pendingLockedCheckout = useRef<boolean>(false);

  useEffect(() => {
    const unsubscribe = ipc.on("file:checkout:locked-warning", (data) => {
      setLockedWarningPath(data.path);
      setLockedWarningUser(data.lockedBy);
      setLockedWarningVisible(true);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const showContextMenu = (
    event: React.MouseEvent,
    fileInfo: FileContextInfo,
  ) => {
    event.preventDefault();
    currentFileRef.current = fileInfo;
    contextMenuRef.current?.show(event);
  };

  const buildMenuItems = (): MenuItem[] => {
    const file = currentFileRef.current;
    if (!file || !currentWorkspace) return [];

    const status = getFileStatusFromString(file.status);
    const fileBasename = getBasename(file.relativePath);
    const fileExtname = getExtname(file.relativePath);

    const items: MenuItem[] = [];

    // Open submenu
    items.push({
      label: "Open",
      items: [
        {
          label: "Open",
          command: () => {
            ipc.sendMessage("file:open", { path: file.absolutePath });
          },
        },
        {
          label: "Open with...",
          command: () => {
            ipc.sendMessage("file:open-with", { path: file.absolutePath });
          },
        },
        {
          label: "Open in explorer",
          command: () => {
            ipc.sendMessage("file:open-in-explorer", {
              path: file.absolutePath,
            });
          },
        },
      ],
    });

    // History
    items.push({
      label: "History",
      disabled: !file.hasChangelist,
      command: () => {
        ipc.sendMessage("file:history", { path: file.relativePath });
      },
    });

    // Separator
    items.push({ separator: true });

    // Mark as added (only for Local status)
    items.push({
      label: "Mark as added",
      disabled: status !== FileStatusValues.Local,
      command: () => {
        ipc.sendMessage("file:mark-as-added", { path: file.relativePath });
      },
    });

    // Mark directory contents as added (only for directories)
    items.push({
      label: "Mark directory contents as added",
      disabled: !file.isDirectory,
      command: () => {
        ipc.sendMessage("file:mark-directory-as-added", {
          path: file.relativePath,
        });
      },
    });

    // Checkout
    items.push({
      label: "Checkout",
      disabled: isCheckedOut(status),
      command: () => {
        ipc.sendMessage("file:checkout", {
          path: file.relativePath,
          checkForLock: true,
        });
      },
    });

    // Checkout (locked)
    items.push({
      label: "Checkout (locked)",
      disabled: isCheckedOut(status),
      command: () => {
        ipc.sendMessage("file:checkout", {
          path: file.relativePath,
          locked: true,
          checkForLock: true,
        });
      },
    });

    // Undo checkout
    items.push({
      label: "Undo checkout",
      disabled: !isCheckedOut(status),
      command: () => {
        ipc.sendMessage("file:undo-checkout", { path: file.relativePath });
      },
    });

    // Revert (restore head version + undo checkout)
    const canRevert =
      status === FileStatusValues.ChangedCheckedOut ||
      status === FileStatusValues.ChangedNotCheckedOut ||
      status === FileStatusValues.NotChangedCheckedOut ||
      status === FileStatusValues.Added ||
      status === FileStatusValues.Renamed ||
      status === FileStatusValues.Deleted ||
      status === FileStatusValues.Conflicted;
    items.push({
      label: "Revert",
      disabled: !canRevert,
      command: () => {
        if (
          window.confirm(
            `Are you sure you want to revert "${fileBasename}" to its head version? Local changes will be lost.`,
          )
        ) {
          ipc.sendMessage("workspace:revert", {
            filePaths: [file.relativePath],
          });
        }
      },
    });

    // Separator
    items.push({ separator: true });

    // Ignored list
    const isFileIgnored = isIgnored(status);
    items.push({
      label: isFileIgnored ? "Remove from ignored list" : "Add to ignored list",
      items: isFileIgnored
        ? [
            {
              label: fileBasename,
              command: () => {
                ipc.sendMessage("file:remove-from-ignored", {
                  pattern: fileBasename,
                });
              },
            },
            {
              label: `*${fileExtname}`,
              command: () => {
                ipc.sendMessage("file:remove-from-ignored", {
                  pattern: `*${fileExtname}`,
                });
              },
            },
            {
              label: file.relativePath.replace(/^\//, ""),
              command: () => {
                ipc.sendMessage("file:remove-from-ignored", {
                  pattern: file.relativePath.replace(/^\//, ""),
                });
              },
            },
          ]
        : [
            {
              label: fileBasename,
              command: () => {
                ipc.sendMessage("file:add-to-ignored", {
                  pattern: fileBasename,
                });
              },
            },
            {
              label: `*${fileExtname}`,
              command: () => {
                ipc.sendMessage("file:add-to-ignored", {
                  pattern: `*${fileExtname}`,
                });
              },
            },
            {
              label: file.relativePath.replace(/^\//, ""),
              command: () => {
                ipc.sendMessage("file:add-to-ignored", {
                  pattern: file.relativePath.replace(/^\//, ""),
                });
              },
            },
          ],
    });

    // Hidden changes list
    const isFileHidden = isHidden(status);
    items.push({
      label: isFileHidden
        ? "Remove from hidden changes list"
        : "Add to hidden changes list",
      items: isFileHidden
        ? [
            {
              label: fileBasename,
              command: () => {
                ipc.sendMessage("file:remove-from-hidden", {
                  pattern: fileBasename,
                });
              },
            },
            {
              label: `*${fileExtname}`,
              command: () => {
                ipc.sendMessage("file:remove-from-hidden", {
                  pattern: `*${fileExtname}`,
                });
              },
            },
            {
              label: file.relativePath.replace(/^\//, ""),
              command: () => {
                ipc.sendMessage("file:remove-from-hidden", {
                  pattern: file.relativePath.replace(/^\//, ""),
                });
              },
            },
          ]
        : [
            {
              label: fileBasename,
              command: () => {
                ipc.sendMessage("file:add-to-hidden", {
                  pattern: fileBasename,
                });
              },
            },
            {
              label: `*${fileExtname}`,
              command: () => {
                ipc.sendMessage("file:add-to-hidden", {
                  pattern: `*${fileExtname}`,
                });
              },
            },
            {
              label: file.relativePath.replace(/^\//, ""),
              command: () => {
                ipc.sendMessage("file:add-to-hidden", {
                  pattern: file.relativePath.replace(/^\//, ""),
                });
              },
            },
          ],
    });

    // Separator
    items.push({ separator: true });

    // Copy full path
    items.push({
      label: "Copy full path",
      command: () => {
        ipc.sendMessage("file:copy-full-path", {
          path: file.absolutePath,
          useBackslashes: userSettings.useBackslashes,
        });
      },
    });

    // Copy relative path
    items.push({
      label: "Copy relative path",
      command: () => {
        ipc.sendMessage("file:copy-relative-path", {
          path: file.absolutePath,
          useBackslashes: userSettings.useBackslashes,
        });
      },
    });

    // Copy paths with backslashes (Windows only, checkbox state)
    if (isWindows) {
      items.push({
        label: "Copy paths with backslashes",
        icon: userSettings.useBackslashes ? "pi pi-check" : undefined,
        command: () => {
          setUserSettings({
            ...userSettings,
            useBackslashes: !userSettings.useBackslashes,
          });
        },
      });
    }

    // Rename
    items.push({
      label: "Rename...",
      command: () => {
        // Prompt for rename will be handled via a dialog in the component
        const currentName = getBasename(file.absolutePath);
        const newName = window.prompt("Enter new name:", currentName);
        if (newName && newName !== currentName) {
          ipc.sendMessage("file:rename", {
            path: file.absolutePath,
            newName,
          });
        }
      },
    });

    // Delete submenu
    items.push({
      label: "Delete",
      items: [
        {
          label: "Move to trash",
          command: () => {
            ipc.sendMessage("file:delete-to-trash", {
              path: file.absolutePath,
            });
          },
        },
        {
          label: "Force delete",
          command: () => {
            if (
              window.confirm(
                `Are you sure you want to permanently delete "${fileBasename}"? This cannot be undone.`,
              )
            ) {
              ipc.sendMessage("file:force-delete", { path: file.absolutePath });
            }
          },
        },
      ],
    });

    return items;
  };

  return {
    contextMenuRef,
    showContextMenu,
    buildMenuItems,
    currentFileRef,
    lockedWarningVisible,
    setLockedWarningVisible,
    lockedWarningPath,
    lockedWarningUser,
    confirmLockedCheckout: () => {
      setLockedWarningVisible(false);
      // Proceed with checkout despite the lock (without checkForLock to skip re-check)
      ipc.sendMessage("file:checkout", {
        path: lockedWarningPath,
      });
    },
  };
}

export default function FileContextMenu({
  contextMenuRef,
  menuItems,
  lockedWarningVisible,
  setLockedWarningVisible,
  lockedWarningUser,
  lockedWarningPath,
  confirmLockedCheckout,
}: {
  contextMenuRef: React.RefObject<ContextMenu | null>;
  menuItems: MenuItem[];
  lockedWarningVisible?: boolean;
  setLockedWarningVisible?: (visible: boolean) => void;
  lockedWarningUser?: string;
  lockedWarningPath?: string;
  confirmLockedCheckout?: () => void;
}) {
  return (
    <>
      <ContextMenu
        ref={contextMenuRef as React.RefObject<ContextMenu>}
        model={menuItems}
        breakpoint="767px"
        pt={{
          root: {
            style: {
              marginTop: "2rem",
              backgroundColor: "var(--color-panel)",
              border: "1px solid var(--color-border-light)",
              borderRadius: "4px",
              minWidth: "200px",
            },
          },
          menu: {
            style: {
              backgroundColor: "var(--color-panel)",
            },
          },
          menuitem: {
            style: {
              margin: 0,
            },
          },
          action: {
            style: {
              color: "#e0e0e0",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
            },
          },
          separator: {
            style: {
              borderColor: "var(--color-border-light)",
            },
          },
          submenuIcon: {
            style: {
              color: "#e0e0e0",
            },
          },
        }}
      />

      {lockedWarningVisible && setLockedWarningVisible && (
        <Dialog
          header="File Locked"
          visible={lockedWarningVisible}
          style={{ width: "30rem" }}
          onHide={() => setLockedWarningVisible(false)}
          footer={
            <div className="flex justify-end gap-2">
              <button
                className="p-[0.5rem] px-[1rem] text-[0.9em] rounded"
                style={{
                  backgroundColor: "var(--color-app-bg)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                }}
                onClick={() => setLockedWarningVisible(false)}
              >
                Cancel
              </button>
              <button
                className="p-[0.5rem] px-[1rem] text-[0.9em] rounded"
                style={{
                  backgroundColor: "#646cff",
                  border: "1px solid #646cff",
                  color: "#fff",
                }}
                onClick={confirmLockedCheckout}
              >
                Checkout Anyway
              </button>
            </div>
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
          <p>
            This file is currently locked by{" "}
            <strong>{lockedWarningUser}</strong>.
          </p>
          <p
            className="mt-2 text-sm"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {lockedWarningPath}
          </p>
          <p className="mt-2">
            You can still check out the file, but you will not be able to submit
            changes while it remains locked by another user.
          </p>
        </Dialog>
      )}
    </>
  );
}
