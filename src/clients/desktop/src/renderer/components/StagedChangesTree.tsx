import React, { useCallback, useMemo, useState } from "react";
import { FileIcon } from "./FileIcon";
import { FileStatus } from "@checkpointvcs/daemon/types";
import type { File as PendingFile } from "@checkpointvcs/daemon/types";

/**
 * The pending-changes tree, grouped by where each change is going.
 *
 * Sections are UNSTAGED plus one per bucket: the workspace's domain root, then
 * each overlaid feature branch. Dragging a row between sections restages it,
 * which also moves that file's claim, so "staged here" and "destined for this
 * branch" stay the same fact rather than two that can disagree.
 *
 * Deliberately not a PrimeReact TreeTable: bucket headers fight a uniform
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
}

export interface Bucket {
  /** Branch name, or UNSTAGED for the not-yet-staged section. */
  id: string;
  label: string;
  files: PendingFile[];
}

function buildTree(files: PendingFile[]): PendingTreeNode[] {
  const root: PendingTreeNode[] = [];

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split("/");
    let level = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      let node = level.find((n) => n.name === part);

      if (!node) {
        node = {
          name: part,
          path: isLast ? file.path : parts.slice(0, i + 1).join("/"),
          isDirectory: !isLast,
          ...(isLast ? { file } : {}),
          children: [],
        };
        level.push(node);
      } else if (isLast) {
        node.file = file;
      }

      level = node.children;
    }
  }

  return root;
}

/** Single-letter marker, matching the vocabulary used elsewhere in the app. */
function statusMarker(status: FileStatus): { label: string; color: string } {
  switch (status) {
    case FileStatus.Added:
    case FileStatus.Local:
      return { label: "A", color: "var(--color-success)" };
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

interface RowProps {
  node: PendingTreeNode;
  depth: number;
  bucketId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, file: PendingFile) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  draggable: boolean;
}

function Row({
  node,
  depth,
  bucketId,
  selectedPath,
  onSelect,
  onContextMenu,
  expanded,
  onToggle,
  draggable,
}: RowProps) {
  const isOpen = expanded.has(node.path);
  const claim = node.file?.claims?.[0];
  const marker = node.file ? statusMarker(node.file.status) : null;

  return (
    <>
      <div
        className={
          "flex cursor-pointer items-center justify-between gap-2 px-2 py-1 text-[0.85rem] hover:bg-[var(--color-bg-hover)]" +
          (selectedPath === node.path ? " bg-[var(--color-bg-selected)]" : "")
        }
        style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
        draggable={draggable && !node.isDirectory}
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/checkpoint-path",
            JSON.stringify({ path: node.path, from: bucketId }),
          );
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => {
          if (node.isDirectory) {
            onToggle(node.path);
          } else {
            onSelect(node.path);
          }
        }}
        onContextMenu={(e) => {
          if (node.file) onContextMenu(e, node.file);
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {node.isDirectory ? (
            <span className="w-4 text-center text-[0.7rem] text-[var(--color-text-muted)]">
              {isOpen ? "▾" : "▸"}
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
          />
          <span className="truncate">{node.name}</span>
        </span>

        {node.file && marker && (
          <span className="flex shrink-0 items-center gap-2">
            {claim?.blocking && (
              <span
                className="rounded px-1 text-[0.65rem]"
                style={{
                  background: "var(--color-danger)",
                  color: "var(--color-bg-default)",
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

      {node.isDirectory &&
        isOpen &&
        node.children.map((child) => (
          <Row
            key={child.path}
            node={child}
            depth={depth + 1}
            bucketId={bucketId}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            expanded={expanded}
            onToggle={onToggle}
            draggable={draggable}
          />
        ))}
    </>
  );
}

interface StagedChangesTreeProps {
  buckets: Bucket[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, file: PendingFile) => void;
  /** Fired when a row is dragged into another section. */
  onMove: (path: string, from: string, to: string) => void;
  /** Fired by a bucket's own Submit button. Absent for UNSTAGED. */
  onSubmit: (bucketId: string) => void;
  submitDisabled: boolean;
}

export default function StagedChangesTree({
  buckets,
  selectedPath,
  onSelect,
  onContextMenu,
  onMove,
  onSubmit,
  submitDisabled,
}: StagedChangesTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState<string | null>(null);

  const onToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const trees = useMemo(
    () => buckets.map((b) => ({ bucket: b, tree: buildTree(b.files) })),
    [buckets],
  );

  return (
    <div className="flex flex-col gap-3 overflow-auto">
      {trees.map(({ bucket, tree }) => (
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
              const { path, from } = JSON.parse(
                e.dataTransfer.getData("application/checkpoint-path"),
              ) as { path: string; from: string };
              if (from !== bucket.id) onMove(path, from, bucket.id);
            } catch {
              // A drag from outside the app; nothing to do.
            }
          }}
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-2 py-1">
            <span className="text-[0.8rem] font-medium text-[var(--color-text-secondary)]">
              {bucket.label}
              <span className="ml-2 text-[0.7rem] text-[var(--color-text-muted)]">
                {bucket.files.length}
              </span>
            </span>
            {bucket.id !== UNSTAGED && bucket.files.length > 0 && (
              <button
                type="button"
                className="rounded px-2 py-0.5 text-[0.75rem] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
                disabled={submitDisabled}
                onClick={() => onSubmit(bucket.id)}
              >
                Submit
              </button>
            )}
          </div>

          {bucket.files.length === 0 ? (
            <div className="px-3 py-2 text-[0.75rem] text-[var(--color-text-muted)]">
              {bucket.id === UNSTAGED
                ? "Nothing unstaged."
                : "Drag changes here to stage them."}
            </div>
          ) : (
            tree.map((node) => (
              <Row
                key={node.path}
                node={node}
                depth={0}
                bucketId={bucket.id}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                expanded={expanded}
                onToggle={onToggle}
                draggable
              />
            ))
          )}
        </div>
      ))}
    </div>
  );
}
