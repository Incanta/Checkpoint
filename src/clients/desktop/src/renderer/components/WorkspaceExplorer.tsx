import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createColumnHelper,
  type ExpandedState,
  type SortingFn,
  type SortingState,
} from "@tanstack/react-table";
import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceDirectoriesAtom,
  workspacePendingChangesAtom,
  fileHistoryAtom,
} from "../../common/state/workspace";
import { ipc } from "../pages/ipc";
import Button from "./Button";
import DropdownButton from "./DropdownButton";
import prettyBytes from "pretty-bytes";
import {
  FileStatus,
  FileType,
  type File,
  type WorkspacePendingChanges,
} from "@checkpointvcs/daemon/types";
import FileContextMenu, {
  useFileContextMenu,
  FileContextInfo,
} from "./FileContextMenu";
import FileHistory from "./FileHistory";
import { FileIcon } from "./FileIcon";
import { DataTable } from "./ui/data-table";
import { compareNames, treeSortFields } from "./file-tree-sort";

/** The root directory's path, as sent to `workspace:get-directory`. */
const ROOT_PATH = "/";

interface ExplorerRow {
  /** Workspace-relative path with a leading slash; the root is "/". */
  id: string;
  name: string;
  /** Icon key for FileIcon: " " for a folder. */
  ext: string;
  isDirectory: boolean;
  status: string;
  /** Bytes, so the column sorts numerically. Null for directories. */
  size: number | null;
  sizeLabel: string;
  /** Epoch ms, so the column sorts chronologically. Null for the root. */
  modified: number | null;
  modifiedLabel: string;
  type: string;
  changelist: number | null;
  /** Hidden sort keys: directories first, then natural name order. */
  dirRank: number;
  sortName: string;
  /** Set for a symbolic link or junction: what it points to. */
  linkTarget?: string;
  /** Loaded children of a directory; undefined until it has been listed. */
  children?: ExplorerRow[];
}

/**
 * Row fields for a symbolic link or junction, which would otherwise pass for
 * a plain file: the icon of what it points to (badged as a link), and a type
 * that says it is one. A link to a folder stays a leaf, since Checkpoint never
 * follows it. Nothing for any other row.
 */
function linkRowFields(file: {
  link?: { target: string; directory: boolean };
}): Partial<Pick<ExplorerRow, "ext" | "status" | "type" | "linkTarget">> {
  if (!file.link) return {};
  return {
    // A folder link is never submitted, so it has no status either.
    ...(file.link.directory && { ext: " ", status: "" }),
    type: file.link.directory ? "Link to folder" : "Link to file",
    linkTarget: file.link.target,
  };
}

function childPath(dirPath: string, name: string): string {
  return dirPath === ROOT_PATH ? ROOT_PATH + name : `${dirPath}/${name}`;
}

/** One listed entry of the directory at `dirPath`, as a table row. */
function fileToRow(
  file: File,
  dirPath: string,
  pendingChanges: WorkspacePendingChanges | null,
): ExplorerRow {
  const isDirectory = file.type === FileType.Directory;
  const name = file.path.split("/").pop() || "";
  const id = childPath(dirPath, name);

  // A directory is a container, never a change of its own, so it shows no
  // status even when the daemon reports its subtree as pending. For a file,
  // the live pending changes (keyed repo-relative, no leading slash) win over
  // the status captured when the directory was listed.
  let status =
    isDirectory || file.status === FileStatus.Unknown
      ? ""
      : FileStatus[file.status];
  const pending = isDirectory ? undefined : pendingChanges?.files[id.slice(1)];
  if (pending) status = FileStatus[pending.status];

  return {
    id,
    name,
    ext: isDirectory ? " " : file.path.split(".").pop() || "",
    isDirectory,
    status,
    size: isDirectory ? null : file.size,
    sizeLabel: isDirectory ? "" : prettyBytes(file.size),
    modified: file.modifiedAt,
    modifiedLabel: new Date(file.modifiedAt).toLocaleDateString(),
    type: isDirectory ? " " : FileType[file.type],
    // 0 means none, as it always has here.
    changelist: file.changelist || null,
    ...treeSortFields(name, isDirectory),
    ...linkRowFields(file),
  };
}

/** Natural name order ("file2" before "file10"), as the pending tree uses. */
const byName: SortingFn<ExplorerRow> = (a, b, columnId) =>
  compareNames(a.getValue<string>(columnId), b.getValue<string>(columnId));

// Directories stay above files whatever the user sorts by, and rows the
// sorted column can't separate fall back to name order.
const SORT_PREFIX: SortingState = [{ id: "dirRank", desc: false }];
const SORT_SUFFIX: SortingState = [{ id: "sortName", desc: false }];

const column = createColumnHelper<ExplorerRow>();

const columns = [
  column.accessor("name", {
    id: "name",
    header: "Item",
    minSize: 200,
    sortingFn: byName,
    cell: (info) => {
      const row = info.row.original;
      const linkTarget = row.linkTarget;
      return (
        <span
          title={
            linkTarget !== undefined
              ? `Link to ${linkTarget || "an unknown target"}`
              : undefined
          }
        >
          <FileIcon extension={row.ext} link={linkTarget !== undefined} />
          <span className="ml-2">{row.name}</span>
        </span>
      );
    },
    meta: { expander: true, fill: true },
  }),
  column.accessor("status", {
    id: "status",
    header: "Status",
    meta: { measure: (row) => row.status },
  }),
  column.accessor((row) => row.size ?? 0, {
    id: "size",
    header: "Size",
    cell: (info) => info.row.original.sizeLabel,
    meta: { measure: (row) => row.sizeLabel },
  }),
  column.accessor((row) => row.modified ?? 0, {
    id: "modified",
    header: "Date Modified",
    cell: (info) => info.row.original.modifiedLabel,
    meta: { measure: (row) => row.modifiedLabel },
  }),
  column.accessor("type", {
    id: "type",
    header: "Type",
    meta: { measure: (row) => row.type },
  }),
  column.accessor((row) => row.changelist ?? -1, {
    id: "changelist",
    header: "Changelist",
    cell: (info) => info.row.original.changelist?.toString() ?? "",
    meta: { measure: (row) => row.changelist?.toString() ?? "" },
  }),
  column.accessor("dirRank", {
    id: "dirRank",
    meta: { hidden: true },
  }),
  column.accessor("sortName", {
    id: "sortName",
    sortingFn: byName,
    meta: { hidden: true },
  }),
];

export default function WorkspaceExplorer(): React.ReactElement {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspaceDirectories = useAtomValue(workspaceDirectoriesAtom);
  const workspacePendingChanges = useAtomValue(workspacePendingChangesAtom);
  const fileHistory = useAtomValue(fileHistoryAtom);

  /** Listed directory contents, keyed by workspace-relative path ("/" is the root). */
  const [contents, setContents] = useState<Record<string, File[]>>({});
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // Paths asked for since the workspace was last switched. Responses carry
  // the path they answer, so several folders can load at once in any order,
  // and a late answer for a previous workspace is dropped.
  const requestedRef = useRef(new Set<string>());
  const loadedWorkspaceIdRef = useRef<string | null>(null);

  const requestDirectory = useCallback((path: string) => {
    requestedRef.current.add(path);
    ipc.sendMessage("workspace:get-directory", { path });
  }, []);

  useEffect(
    () =>
      ipc.on("workspace:directory-contents", (data) => {
        if (!requestedRef.current.has(data.path)) return;
        setContents((prev) => ({
          ...prev,
          [data.path]: data.directory.children,
        }));
      }),
    [],
  );

  // A new workspace starts from its root, expanded. The daemon resets
  // workspaceDirectories on every refresh, which reloads the root and every
  // open folder in place; closed folders are forgotten and reload when
  // next opened.
  const workspaceId = currentWorkspace?.id ?? null;
  useEffect(() => {
    if (!workspaceId) {
      loadedWorkspaceIdRef.current = null;
      requestedRef.current.clear();
      setContents({});
      setExpanded({});
      return;
    }

    if (loadedWorkspaceIdRef.current !== workspaceId) {
      loadedWorkspaceIdRef.current = workspaceId;
      requestedRef.current.clear();
      setContents({});
      setExpanded({ [ROOT_PATH]: true });
      requestDirectory(ROOT_PATH);
      return;
    }

    const open = expandedRef.current;
    if (open === true) {
      requestDirectory(ROOT_PATH);
      return;
    }
    const keep = new Set([
      ROOT_PATH,
      ...Object.keys(open).filter((path) => open[path]),
    ]);
    setContents((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([path]) => keep.has(path)),
      ),
    );
    for (const path of keep) requestDirectory(path);
  }, [workspaceId, workspaceDirectories, requestDirectory]);

  const rows = useMemo<ExplorerRow[]>(() => {
    if (!currentWorkspace) return [];

    const listDirectory = (dirPath: string): ExplorerRow[] | undefined =>
      contents[dirPath]
        ?.filter((file) => file.path !== ".checkpoint")
        .map((file) => {
          const row = fileToRow(file, dirPath, workspacePendingChanges);
          if (row.isDirectory) row.children = listDirectory(row.id);
          return row;
        });

    const root: ExplorerRow = {
      id: ROOT_PATH,
      name: currentWorkspace.localPath,
      ext: " ",
      isDirectory: true,
      status: "",
      size: null,
      sizeLabel: "",
      modified: null,
      modifiedLabel: "",
      type: " ",
      changelist: null,
      ...treeSortFields(currentWorkspace.localPath, true),
      children: listDirectory(ROOT_PATH),
    };
    return [root];
  }, [currentWorkspace, contents, workspacePendingChanges]);

  const handleRowExpand = useCallback(
    (row: ExplorerRow) => {
      if (row.isDirectory && !contents[row.id]?.length) {
        requestDirectory(row.id);
      }
    },
    [contents, requestDirectory],
  );

  // Context menu hook
  const {
    contextMenuRef,
    showContextMenu,
    buildMenuItems,
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
    (event: React.MouseEvent, row: ExplorerRow) => {
      if (!currentWorkspace) return;

      const workspaceLocalPath = currentWorkspace.localPath
        .split(/[/\\]/)
        .join("/");
      const relativePath = row.id;
      const absolutePath = workspaceLocalPath + relativePath;

      const fileInfo: FileContextInfo = {
        absolutePath,
        relativePath,
        isDirectory: row.isDirectory,
        status: row.status,
        hasChangelist: row.changelist !== null,
        changelistId: row.changelist,
      };

      showContextMenu(event, fileInfo);
      // Rebuild menu items after setting the file
      setTimeout(() => {
        setMenuItems(buildMenuItems());
      }, 0);
    },
    [currentWorkspace, showContextMenu, buildMenuItems],
  );

  // The table stays mounted (just hidden) while a file's history is open, so
  // its sorting, scroll position, and selection are still there on the way
  // back.
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
        resolveDialogVisible={resolveDialogVisible}
        setResolveDialogVisible={setResolveDialogVisible}
        resolveDialogPath={resolveDialogPath}
        resolveDontAsk={resolveDontAsk}
        setResolveDontAsk={setResolveDontAsk}
        resolveDontAskDuration={resolveDontAskDuration}
        setResolveDontAskDuration={setResolveDontAskDuration}
        confirmResolve={confirmResolve}
      />

      {fileHistory && <FileHistory />}
      <div
        className={`grid h-full grid-rows-[2.5rem_minmax(0,1fr)] ${
          fileHistory ? "hidden" : ""
        }`}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3">
          <DropdownButton
            className="px-3 py-1 text-xs"
            label="Refresh"
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
            className="px-3 py-1 text-xs"
            label="Pull"
            onClick={() => {
              ipc.sendMessage("workspace:pull", {
                changelistId: null,
                filePaths: null,
              });
            }}
          />
        </div>
        <div className="min-h-0 min-w-0 overflow-hidden">
          <DataTable
            data={rows}
            columns={columns}
            getRowId={(row) => row.id}
            storageKey="workspace-explorer"
            getSubRows={(row) => row.children}
            getRowCanExpand={(row) => row.isDirectory}
            onRowExpand={handleRowExpand}
            expanded={expanded}
            onExpandedChange={setExpanded}
            sortPrefix={SORT_PREFIX}
            sortSuffix={SORT_SUFFIX}
            onRowContextMenu={handleRowContextMenu}
          />
        </div>
      </div>
    </>
  );
}
