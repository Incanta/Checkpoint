import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck } from "@fortawesome/free-solid-svg-icons/faCheck";
import { faPen } from "@fortawesome/free-solid-svg-icons/faPen";
import { faTrashCan } from "@fortawesome/free-solid-svg-icons/faTrashCan";
import { faCodeBranch } from "@fortawesome/free-solid-svg-icons/faCodeBranch";
import { FileIcon } from "./FileIcon";
import { FileStatus, FileType } from "@checkpointvcs/daemon/types";
import type { File as PendingFile } from "@checkpointvcs/daemon/types";
import { compareTreeEntries } from "./file-tree-sort";
import { ipc } from "../pages/ipc";

/**
 * The pending-changes tree, grouped by changelist.
 *
 * Sections are one per changelist: each branch's default changelist (the
 * workspace's domain root first, then each overlaid feature branch), each
 * numbered pending changelist under the branch it submits to, and UNSTAGED
 * last. Dragging rows between sections restages them, which also moves each
 * file's claim, so "in this changelist" and "destined for its branch" stay the
 * same fact rather than two that can disagree.
 *
 * Directories are shown as containers, never as changes: no status marker, and
 * selecting one acts on everything pending beneath it. That holds for the
 * collapsed untracked-subtree rows the daemon sends as a single Directory entry
 * too, which are staged and submitted by their own path. Expanding one of
 * those lists its contents from the daemon a level at a time, so a folder of
 * thousands of files costs nothing until someone looks inside it.
 *
 * Deliberately not a PrimeReact TreeTable: section headers fight a uniform
 * column layout, and drag-and-drop across groups is awkward there. This
 * follows the lighter recursive tree already used by File History, Changelist
 * Changes, and Sync Preview.
 */

export const UNSTAGED = "__unstaged__";

export interface PendingTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  file?: PendingFile;
  children: PendingTreeNode[];
  /** Its contents come from the daemon on expand (a collapsed folder). */
  lazy: boolean;
  /**
   * Listed from inside a collapsed folder rather than reported as a change,
   * so it moves only by being staged on its own.
   */
  listed: boolean;
}

export interface Bucket {
  /** UNSTAGED, `default:<branch>`, or `cl:<id>`. */
  id: string;
  kind: "unstaged" | "default" | "numbered";
  label: string;
  /** The branch it submits to; null for UNSTAGED. */
  branchName: string | null;
  /** The numbered pending changelist; null for a default one and UNSTAGED. */
  changelistId: number | null;
  description: string;
  files: PendingFile[];
}

/**
 * The selected rows. Every row is in one section: selecting in another
 * section starts over there.
 */
export interface PendingSelection {
  bucketId: string;
  /** Selected row paths. */
  rows: string[];
  /** Where a shift-click range starts. */
  anchor: string;
  /** The pending paths the selection acts on, in daemon terms. */
  paths: string[];
  /**
   * False when a row sits inside a folder that is in a changelist as a whole,
   * which cannot be split from it.
   */
  actionable: boolean;
}

/**
 * The pending-change paths at or below a node.
 *
 * A node carries a `file` when the daemon reported it as a change. That
 * includes collapsed untracked directories, which the daemon deliberately
 * reports as one row rather than enumerating a subtree that may hold thousands
 * of files, so its own path is what we hand back rather than its children.
 */
function pendingPathsUnder(node: PendingTreeNode): string[] {
  if (node.listed) return [node.path];
  const paths = node.file ? [node.path] : [];
  for (const child of node.children) {
    if (!child.listed) paths.push(...pendingPathsUnder(child));
  }
  return paths;
}

/** Order every level the way the explorer does: directories first, then name. */
function sortLevels(nodes: PendingTreeNode[]): PendingTreeNode[] {
  nodes.sort(compareTreeEntries);
  for (const node of nodes) {
    sortLevels(node.children);
  }
  return nodes;
}

function buildTree(files: PendingFile[]): PendingTreeNode[] {
  const root: PendingTreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let level = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      let node = level.find((n) => n.name === part);

      // The daemon reports an untracked subtree as a single Directory row, so
      // the last part of a path is not necessarily a file.
      const isDir = !isLast || file.type === FileType.Directory;

      if (!node) {
        node = {
          name: part,
          path: isLast ? file.path : parts.slice(0, i + 1).join("/"),
          isDirectory: isDir,
          ...(isLast ? { file } : {}),
          children: [],
          lazy: isLast && file.type === FileType.Directory,
          listed: false,
        };
        level.push(node);
      } else if (isLast) {
        node.file = file;
        node.isDirectory = node.isDirectory || isDir;
        node.lazy = file.type === FileType.Directory;
      }

      level = node.children;
    }
  }

  return sortLevels(root);
}

/**
 * Adds a collapsed folder's listed contents beneath it. Entries that are a
 * row of their own somewhere (staged on their own) are left out, so nothing
 * shows twice.
 */
function withListings(
  nodes: PendingTreeNode[],
  listings: Record<string, PendingFile[]>,
  ownRows: Set<string>,
  insideListed = false,
): PendingTreeNode[] {
  return nodes.map((node) => {
    let children = withListings(node.children, listings, ownRows, insideListed);
    const listing = node.lazy ? listings[node.path] : undefined;
    if (listing) {
      const known = new Set(children.map((c) => c.path));
      const listed: PendingTreeNode[] = listing
        .map((f) => {
          const fullPath = `${node.path}/${f.path}`;
          const isDir = f.type === FileType.Directory;
          return {
            name: f.path,
            path: fullPath,
            isDirectory: isDir,
            file: { ...f, path: fullPath },
            children: [],
            lazy: isDir,
            listed: true,
          };
        })
        .filter((c) => !known.has(c.path) && !ownRows.has(c.path));
      children = sortLevels([
        ...children,
        ...withListings(listed, listings, ownRows, true),
      ]);
    }
    return { ...node, children };
  });
}

function canExpand(node: PendingTreeNode): boolean {
  return node.isDirectory && (node.lazy || node.children.length > 0);
}

/**
 * Folders that only hold the changes reported beneath them start open, so the
 * changed files are visible at a glance. A collapsed folder (a whole untracked
 * subtree the daemon sent as one row, or one listed from inside it) starts
 * closed, since opening it means asking the daemon for what is inside.
 */
function openByDefault(node: PendingTreeNode): boolean {
  return !node.lazy;
}

/**
 * Whether a row is open. `toggled` holds the keys of rows the user flipped
 * away from their default, so new folders follow the default as they appear.
 */
function isOpenIn(
  toggled: Set<string>,
  key: string,
  node: PendingTreeNode,
): boolean {
  return canExpand(node) && openByDefault(node) !== toggled.has(key);
}

/** Every node of a tree, by path. */
function indexNodes(
  nodes: PendingTreeNode[],
  into = new Map<string, PendingTreeNode>(),
): Map<string, PendingTreeNode> {
  for (const node of nodes) {
    into.set(node.path, node);
    indexNodes(node.children, into);
  }
  return into;
}

/** Row paths in the order they show, for shift-click ranges. */
function visibleOrder(
  nodes: PendingTreeNode[],
  isOpen: (node: PendingTreeNode) => boolean,
  into: string[] = [],
): string[] {
  for (const node of nodes) {
    into.push(node.path);
    if (isOpen(node)) {
      visibleOrder(node.children, isOpen, into);
    }
  }
  return into;
}

function selectionOf(
  bucket: Bucket,
  index: Map<string, PendingTreeNode>,
  rows: string[],
  anchor: string,
): PendingSelection {
  const nodes = rows
    .map((p) => index.get(p))
    .filter((n): n is PendingTreeNode => n !== undefined);
  const paths = [...new Set(nodes.flatMap(pendingPathsUnder))];
  return {
    bucketId: bucket.id,
    rows: nodes.map((n) => n.path),
    anchor,
    paths,
    // A listed entry can be staged on its own out of UNSTAGED, but inside a
    // changelist it belongs to its folder's row.
    actionable:
      paths.length > 0 &&
      (bucket.kind === "unstaged" || nodes.every((n) => !n.listed)),
  };
}

/**
 * Single-letter marker, matching the vocabulary used elsewhere in the app. A
 * new file is untracked (U) until it is staged, which is what adds it (A).
 */
function statusMarker(file: { status: FileStatus; staged: boolean }): {
  label: string;
  color: string;
} {
  switch (file.status) {
    case FileStatus.Local:
      return file.staged
        ? { label: "A", color: "var(--color-success)" }
        : { label: "U", color: "var(--color-success)" };
    case FileStatus.Deleted:
      return { label: "D", color: "var(--color-danger)" };
    case FileStatus.Renamed:
      return { label: "R", color: "var(--color-warning)" };
    case FileStatus.Conflicted:
    case FileStatus.MergeConflict:
      return { label: "!", color: "var(--color-danger)" };
    default:
      return { label: "M", color: "var(--color-info)" };
  }
}

const DRAG_TYPE = "application/checkpoint-path";

interface RowProps {
  node: PendingTreeNode;
  depth: number;
  isOpen: (node: PendingTreeNode) => boolean;
  onToggle: (path: string) => void;
  isSelected: (path: string) => boolean;
  onRowClick?: (event: React.MouseEvent, node: PendingTreeNode) => void;
  onRowContextMenu?: (event: React.MouseEvent, node: PendingTreeNode) => void;
  onRowDragStart?: (event: React.DragEvent, node: PendingTreeNode) => void;
}

function Row(props: RowProps) {
  const {
    node,
    depth,
    isOpen,
    onToggle,
    isSelected,
    onRowClick,
    onRowContextMenu,
    onRowDragStart,
  } = props;
  const open = isOpen(node);
  const claim = node.file?.claims?.[0];
  // Directories are containers, not changes: no status, however the daemon
  // labelled the row.
  const marker =
    node.file && !node.isDirectory ? statusMarker(node.file) : null;
  const expandable = canExpand(node);

  return (
    <>
      <div
        className={
          "pending-row flex cursor-pointer select-none items-center justify-between gap-2 px-2 py-1 text-[0.85rem]" +
          (isSelected(node.path) ? " is-selected" : "")
        }
        style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
        draggable={!!onRowDragStart}
        onDragStart={(e) => onRowDragStart?.(e, node)}
        onClick={(e) => onRowClick?.(e, node)}
        onDoubleClick={() => {
          if (expandable) onToggle(node.path);
        }}
        onContextMenu={(e) => onRowContextMenu?.(e, node)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {expandable ? (
            <span
              className="w-4 text-center text-[0.7rem] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(node.path);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {open ? "▾" : "▸"}
            </span>
          ) : (
            <span className="w-4" />
          )}
          <FileIcon
            extension={
              node.isDirectory
                ? " "
                : (node.name.split(".").pop()?.toLowerCase() ?? "")
            }
            link={!!node.file?.link}
          />
          <span
            className="truncate"
            title={
              node.file?.link
                ? `Link to ${node.file.link.target || "an unknown target"}`
                : undefined
            }
          >
            {node.name}
          </span>
        </span>

        {node.file && marker && (
          <span className="flex shrink-0 items-center gap-2">
            {claim?.blocking && (
              <span
                className="rounded px-1 text-[0.65rem]"
                style={{
                  background: "var(--color-danger)",
                  color: "var(--color-bg-primary)",
                }}
                title={`Claimed on "${claim.branchName}" by ${
                  claim.user.name ?? claim.user.username ?? claim.user.email
                }`}
              >
                BLOCKED
              </span>
            )}
            {claim?.strength === "EXCLUSIVE" && !claim.blocking && (
              <span
                className="rounded px-1 text-[0.65rem] text-[var(--color-text-muted)]"
                title="Exclusive claim: nobody else may edit this"
              >
                EXCL
              </span>
            )}
            {claim?.state === "SUBMITTED" && (
              <span
                className="text-[0.65rem] text-[var(--color-text-muted)]"
                title={`Submitted to "${claim.branchName}", not yet merged`}
              >
                submitted
              </span>
            )}
            <span
              className="w-3 text-center font-bold"
              style={{ color: marker.color }}
            >
              {marker.label}
            </span>
          </span>
        )}
      </div>

      {expandable &&
        open &&
        (node.lazy && node.children.length === 0 ? (
          <div
            className="py-1 text-[0.75rem] text-[var(--color-text-muted)]"
            style={{ paddingLeft: `${0.5 + (depth + 1) * 0.85 + 1.4}rem` }}
          >
            Loading...
          </div>
        ) : (
          node.children.map((child) => (
            <Row {...props} key={child.path} node={child} depth={depth + 1} />
          ))
        ))}
    </>
  );
}

/**
 * Lists collapsed folders' contents from the daemon on demand, a level at a
 * time. Listings are dropped whenever `resetKey` changes (the pending changes
 * were refreshed), and folders still open are listed again.
 */
function useFolderListings(resetKey: unknown) {
  const [listings, setListings] = useState<Record<string, PendingFile[]>>({});
  const requested = useRef(new Set<string>());

  useEffect(
    () =>
      ipc.on("workspace:directory-pending-contents", (data) => {
        if (!requested.current.has(data.path)) return;
        requested.current.delete(data.path);
        setListings((prev) => ({
          ...prev,
          [data.path]: data.directory.children,
        }));
      }),
    [],
  );

  useEffect(() => {
    setListings({});
    requested.current.clear();
  }, [resetKey]);

  const request = useCallback((dir: string) => {
    if (requested.current.has(dir)) return;
    requested.current.add(dir);
    ipc.sendMessage("workspace:get-directory-pending", { path: dir });
  }, []);

  return { listings, request };
}

/**
 * One section's file tree with its own expand state. Read-only unless the
 * row handlers are given (the submit dialog shows it read-only).
 */
export function PendingFileTree({
  files,
  ownRows,
  isSelected = () => false,
  onRowClick,
  onRowContextMenu,
  onRowDragStart,
  expandKeyPrefix = "",
  toggled,
  onToggle,
  onNodes,
}: {
  files: PendingFile[];
  /** Paths with a row of their own anywhere, left out of folder listings. */
  ownRows: Set<string>;
  isSelected?: (path: string) => boolean;
  onRowClick?: RowProps["onRowClick"];
  onRowContextMenu?: RowProps["onRowContextMenu"];
  onRowDragStart?: RowProps["onRowDragStart"];
  /** Scopes expand state when several trees share one `toggled` set. */
  expandKeyPrefix?: string;
  /** Rows flipped away from their default open state (see isOpenIn). */
  toggled?: Set<string>;
  onToggle?: (key: string) => void;
  /** Receives the tree as shown, for selection bookkeeping. */
  onNodes?: (nodes: PendingTreeNode[]) => void;
}) {
  const [ownToggled, setOwnToggled] = useState<Set<string>>(new Set());
  const toggledSet = toggled ?? ownToggled;
  const toggleKey = useCallback(
    (key: string) => {
      if (onToggle) {
        onToggle(key);
        return;
      }
      setOwnToggled((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [onToggle],
  );

  const { listings, request } = useFolderListings(files);
  const nodes = useMemo(
    () => withListings(buildTree(files), listings, ownRows),
    [files, listings, ownRows],
  );

  const isOpen = useCallback(
    (node: PendingTreeNode) =>
      isOpenIn(toggledSet, expandKeyPrefix + node.path, node),
    [toggledSet, expandKeyPrefix],
  );

  // An open collapsed folder with no listing yet (just expanded, or its
  // listing was dropped by a refresh) asks the daemon for one.
  useEffect(() => {
    const walk = (list: PendingTreeNode[]) => {
      for (const node of list) {
        if (!isOpen(node)) continue;
        if (node.lazy && !listings[node.path]) request(node.path);
        walk(node.children);
      }
    };
    walk(nodes);
  }, [nodes, isOpen, listings, request]);

  useEffect(() => onNodes?.(nodes), [nodes, onNodes]);

  return (
    <>
      {nodes.map((node) => (
        <Row
          key={node.path}
          node={node}
          depth={0}
          isOpen={isOpen}
          onToggle={(path) => toggleKey(expandKeyPrefix + path)}
          isSelected={isSelected}
          onRowClick={onRowClick}
          onRowContextMenu={onRowContextMenu}
          onRowDragStart={onRowDragStart}
        />
      ))}
    </>
  );
}

function HeaderIcon({
  icon,
  title,
  onClick,
  disabled,
}: {
  icon: typeof faCheck;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent p-0 text-[0.75rem] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <FontAwesomeIcon icon={icon} />
    </button>
  );
}

interface StagedChangesTreeProps {
  buckets: Bucket[];
  selection: PendingSelection | null;
  onSelectionChange: (
    selection: PendingSelection | null,
    clicked: PendingTreeNode | null,
  ) => void;
  /** Right-click on a row, with the selection it acts on. */
  onContextMenu: (
    event: React.MouseEvent,
    node: PendingTreeNode,
    selection: PendingSelection,
  ) => void;
  /** Rows dragged into another section, with their paths. */
  onMove: (paths: string[], from: Bucket, to: Bucket) => void;
  onSubmit: (bucket: Bucket) => void;
  onEditDescription: (bucket: Bucket) => void;
  /** Retarget a numbered changelist at another branch. */
  onChangeBranch: (bucket: Bucket) => void;
  onDelete: (bucket: Bucket) => void;
  disabled: boolean;
}

export default function StagedChangesTree({
  buckets,
  selection,
  onSelectionChange,
  onContextMenu,
  onMove,
  onSubmit,
  onEditDescription,
  onChangeBranch,
  onDelete,
  disabled,
}: StagedChangesTreeProps) {
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Each section's tree as shown, kept for selection ranges and paths.
  const [nodesByBucket, setNodesByBucket] = useState<
    Record<string, PendingTreeNode[]>
  >({});

  const onToggle = useCallback((key: string) => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const ownRows = useMemo(
    () => new Set(buckets.flatMap((b) => b.files.map((f) => f.path))),
    [buckets],
  );

  const nodeSetters = useMemo(() => {
    const setters: Record<string, (nodes: PendingTreeNode[]) => void> = {};
    for (const bucket of buckets) {
      setters[bucket.id] = (nodes) =>
        setNodesByBucket((prev) => ({ ...prev, [bucket.id]: nodes }));
    }
    return setters;
  }, [buckets]);

  const indexes = useMemo(() => {
    const out: Record<string, Map<string, PendingTreeNode>> = {};
    for (const [id, nodes] of Object.entries(nodesByBucket)) {
      out[id] = indexNodes(nodes);
    }
    return out;
  }, [nodesByBucket]);

  // Rows that left their section (staged elsewhere, submitted, reverted)
  // leave the selection too.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    const current = selectionRef.current;
    if (!current) return;
    const bucket = buckets.find((b) => b.id === current.bucketId);
    const index = indexes[current.bucketId];
    if (!bucket || !index) {
      onSelectionChange(null, null);
      return;
    }
    const rows = current.rows.filter((p) => index.has(p));
    if (rows.length === 0) {
      onSelectionChange(null, null);
      return;
    }
    const next = selectionOf(bucket, index, rows, current.anchor);
    if (
      next.rows.length !== current.rows.length ||
      next.paths.join("\n") !== current.paths.join("\n") ||
      next.actionable !== current.actionable
    ) {
      onSelectionChange(next, null);
    }
  }, [buckets, indexes, onSelectionChange]);

  const selectedRows = useMemo(
    () => new Set(selection?.rows ?? []),
    [selection],
  );

  const handleRowClick = (
    event: React.MouseEvent,
    bucket: Bucket,
    node: PendingTreeNode,
  ) => {
    if (disabled) return;
    const index = indexes[bucket.id];
    if (!index) return;

    const sameSection = selection?.bucketId === bucket.id;
    const additive = event.ctrlKey || event.metaKey;
    let rows: string[];
    let anchor = node.path;

    if (event.shiftKey && sameSection && selection) {
      const order = visibleOrder(nodesByBucket[bucket.id] ?? [], (n) =>
        isOpenIn(toggled, bucket.id + ":" + n.path, n),
      );
      const from = order.indexOf(selection.anchor);
      const to = order.indexOf(node.path);
      anchor = selection.anchor;
      const range =
        from >= 0 && to >= 0
          ? order.slice(Math.min(from, to), Math.max(from, to) + 1)
          : [node.path];
      rows = additive ? [...new Set([...selection.rows, ...range])] : range;
    } else if (additive && sameSection && selection) {
      rows = selection.rows.includes(node.path)
        ? selection.rows.filter((p) => p !== node.path)
        : [...selection.rows, node.path];
    } else {
      // A plain click, or any click in another section, starts over: a
      // selection only ever holds rows from one section.
      rows = [node.path];
    }

    onSelectionChange(
      rows.length > 0 ? selectionOf(bucket, index, rows, anchor) : null,
      node,
    );
  };

  const handleContextMenu = (
    event: React.MouseEvent,
    bucket: Bucket,
    node: PendingTreeNode,
  ) => {
    event.preventDefault();
    if (disabled) return;
    const index = indexes[bucket.id];
    if (!index) return;

    // Right-clicking a selected row acts on the whole selection; any other
    // row is selected on its own first, as in a file manager.
    let effective = selection;
    if (
      !effective ||
      effective.bucketId !== bucket.id ||
      !effective.rows.includes(node.path)
    ) {
      effective = selectionOf(bucket, index, [node.path], node.path);
      onSelectionChange(effective, node);
    }
    onContextMenu(event, node, effective);
  };

  const handleDragStart = (
    event: React.DragEvent,
    bucket: Bucket,
    node: PendingTreeNode,
  ) => {
    const index = indexes[bucket.id];
    if (!index) return;
    const dragged =
      selection?.bucketId === bucket.id && selection.rows.includes(node.path)
        ? selection
        : selectionOf(bucket, index, [node.path], node.path);
    if (!dragged.actionable) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(
      DRAG_TYPE,
      JSON.stringify({ paths: dragged.paths, from: bucket.id }),
    );
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="flex flex-col gap-3">
      {buckets.map((bucket) => (
        <div
          key={bucket.id}
          className={
            "rounded border " +
            (dragOver === bucket.id
              ? "border-[var(--color-accent)]"
              : "border-[var(--color-border-default)]")
          }
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOver(bucket.id);
          }}
          onDragLeave={() => setDragOver((d) => (d === bucket.id ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            try {
              const { paths, from } = JSON.parse(
                e.dataTransfer.getData(DRAG_TYPE),
              ) as { paths: string[]; from: string };
              const source = buckets.find((b) => b.id === from);
              if (source && from !== bucket.id && paths.length > 0) {
                onMove(paths, source, bucket);
              }
            } catch {
              // A drag from outside the app; nothing to do.
            }
          }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-default)] px-2 py-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-[0.8rem] font-medium text-[var(--color-text-primary)]">
                {bucket.label}
              </span>
              <span className="shrink-0 text-[0.7rem] text-[var(--color-text-muted)]">
                {bucket.files.length}
              </span>
              {bucket.description && (
                <span
                  className="truncate text-[0.75rem] text-[var(--color-text-secondary)]"
                  title={bucket.description}
                >
                  {bucket.description.split("\n")[0]}
                </span>
              )}
            </span>
            {bucket.kind !== "unstaged" && (
              <span className="flex shrink-0 items-center gap-0.5">
                <HeaderIcon
                  icon={faPen}
                  title="Edit description"
                  disabled={disabled}
                  onClick={() => onEditDescription(bucket)}
                />
                {bucket.kind === "numbered" && (
                  <HeaderIcon
                    icon={faCodeBranch}
                    title={`Change branch (submits to ${bucket.branchName})`}
                    disabled={disabled}
                    onClick={() => onChangeBranch(bucket)}
                  />
                )}
                {bucket.kind === "numbered" && (
                  <HeaderIcon
                    icon={faTrashCan}
                    title="Delete changelist (its files stay staged)"
                    disabled={disabled}
                    onClick={() => onDelete(bucket)}
                  />
                )}
                <HeaderIcon
                  icon={faCheck}
                  title={
                    bucket.files.length === 0
                      ? "Nothing to submit"
                      : "Submit this changelist"
                  }
                  disabled={disabled || bucket.files.length === 0}
                  onClick={() => onSubmit(bucket)}
                />
              </span>
            )}
          </div>

          {bucket.files.length === 0 ? (
            <div className="px-3 py-2 text-[0.75rem] text-[var(--color-text-muted)]">
              {bucket.kind === "unstaged"
                ? "Nothing unstaged."
                : "Drag changes here to stage them."}
            </div>
          ) : (
            <PendingFileTree
              files={bucket.files}
              ownRows={ownRows}
              expandKeyPrefix={bucket.id + ":"}
              toggled={toggled}
              onToggle={onToggle}
              onNodes={nodeSetters[bucket.id]}
              isSelected={(p) =>
                selection?.bucketId === bucket.id && selectedRows.has(p)
              }
              onRowClick={(e, node) => handleRowClick(e, bucket, node)}
              onRowContextMenu={(e, node) => handleContextMenu(e, bucket, node)}
              onRowDragStart={
                disabled
                  ? undefined
                  : (e, node) => handleDragStart(e, bucket, node)
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}
