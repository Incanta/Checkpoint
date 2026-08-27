import { useAtomValue } from "jotai";
import { useCallback, useMemo, useRef, useState } from "react";
import { ContextMenu } from "primereact/contextmenu";
import { MenuItem } from "primereact/menuitem";
import { currentWorkspaceAtom } from "../../../common/state/workspace";
import {
  teamSyncChangelistsAtom,
  teamSyncMetadataAtom,
  teamSyncStatusAtom,
  getWsRecord,
  type TeamSyncChangelistEntry,
  type TeamSyncChangelistMeta,
} from "../../../common/state/team-sync";
import { ipc } from "../../pages/ipc";
import { EmptyState } from "../ui";
import CommentDialog from "./dialogs/CommentDialog";

interface DayGroup {
  day: string;
  entries: TeamSyncChangelistEntry[];
}

const BADGE_STATE_COLORS: Record<string, string> = {
  SUCCESS: "var(--color-success-fg, #16a34a)",
  WARNING: "var(--color-warning-fg, #d97706)",
  FAILURE: "var(--color-danger-fg, #dc2626)",
  STARTING: "var(--color-text-muted)",
  SKIPPED: "var(--color-text-muted)",
};

function BadgeChips({
  meta,
}: {
  meta: TeamSyncChangelistMeta | undefined;
}): React.ReactElement | null {
  if (!meta || meta.badges.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {meta.badges.map((badge) => (
        <span
          key={badge.name}
          title={`${badge.name}: ${badge.state}`}
          onClick={(e) => {
            if (badge.url) {
              e.stopPropagation();
              ipc.sendMessage("app:open-external", { url: badge.url });
            }
          }}
          className="inline-flex items-center rounded px-1.5 py-0.5 text-[0.65rem] font-medium"
          style={{
            color: "#fff",
            backgroundColor:
              BADGE_STATE_COLORS[badge.state] ?? "var(--color-text-muted)",
            cursor: badge.url ? "pointer" : "default",
          }}
        >
          {badge.name}
        </span>
      ))}
    </div>
  );
}

function authorLabel(entry: TeamSyncChangelistEntry): string {
  return (
    entry.user?.name || entry.user?.username || entry.user?.email || "Unknown"
  );
}

function groupByDay(entries: TeamSyncChangelistEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;

  for (const entry of entries) {
    const day = new Date(entry.createdAt).toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    if (!current || current.day !== day) {
      current = { day, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }

  return groups;
}

export default function ChangelistBrowser(): React.ReactElement | null {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const changelistsRecord = useAtomValue(teamSyncChangelistsAtom);
  const metadataRecord = useAtomValue(teamSyncMetadataAtom);
  const statusRecord = useAtomValue(teamSyncStatusAtom);
  const contextMenuRef = useRef<ContextMenu>(null);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [commentCl, setCommentCl] = useState<number | null>(null);

  const changelists = getWsRecord(changelistsRecord, currentWorkspace?.id);
  const metadata = getWsRecord(metadataRecord, currentWorkspace?.id);
  const status = getWsRecord(statusRecord, currentWorkspace?.id);
  const syncedCl = status?.syncedCl ?? null;
  const groups = useMemo(
    () => groupByDay(changelists?.entries ?? []),
    [changelists],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, entry: TeamSyncChangelistEntry) => {
      event.preventDefault();

      const number = entry.number;
      const meta = metadata?.[String(number)];
      const myVote = meta?.reviews.myReview?.vote ?? null;
      const starred = meta?.reviews.myReview?.starred ?? false;
      const investigating = meta?.reviews.myReview?.investigating ?? false;

      const items: MenuItem[] = [
        {
          label: "Sync to this CL",
          command: () => {
            ipc.sendMessage("team-sync:sync", { changelistNumber: number });
          },
        },
        { separator: true },
        {
          label: myVote === "GOOD" ? "Clear good" : "Mark good",
          command: () => {
            ipc.sendMessage("team-sync:vote", {
              changelistNumber: number,
              vote: myVote === "GOOD" ? null : "GOOD",
            });
          },
        },
        {
          label: myVote === "BAD" ? "Clear bad" : "Mark bad",
          command: () => {
            ipc.sendMessage("team-sync:vote", {
              changelistNumber: number,
              vote: myVote === "BAD" ? null : "BAD",
            });
          },
        },
        {
          label: starred ? "Unstar" : "Star",
          command: () => {
            ipc.sendMessage("team-sync:star", {
              changelistNumber: number,
              starred: !starred,
            });
          },
        },
        {
          label: investigating ? "Stop investigating" : "Start investigating",
          command: () => {
            ipc.sendMessage("team-sync:investigate", {
              changelistNumber: number,
              investigating: !investigating,
            });
          },
        },
        {
          label: "Leave comment...",
          command: () => {
            setCommentCl(number);
          },
        },
        { separator: true },
        {
          label: "Copy CL number",
          command: () => {
            void navigator.clipboard.writeText(String(number));
          },
        },
      ];

      setMenuItems(items);
      contextMenuRef.current?.show(event);
    },
    [metadata],
  );

  if (!currentWorkspace) return null;

  if (!changelists || changelists.entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="No changelists"
          description="Changelist history for this branch will appear here."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {commentCl != null && (
        <CommentDialog
          changelistNumber={commentCl}
          onClose={() => setCommentCl(null)}
        />
      )}

      <ContextMenu
        ref={contextMenuRef}
        model={menuItems}
        breakpoint="767px"
        pt={{
          root: {
            style: {
              backgroundColor: "var(--color-bg-overlay)",
              border: "1px solid var(--color-border-default)",
              borderRadius: "0.5rem",
              minWidth: "200px",
            },
          },
          menu: { style: { backgroundColor: "var(--color-bg-overlay)" } },
          menuitem: { style: { margin: 0 } },
          action: {
            style: {
              color: "var(--color-text-secondary)",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
            },
          },
          separator: { style: { borderColor: "var(--color-border-muted)" } },
        }}
      />

      {/* Column header */}
      <div className="grid grid-cols-[1.5rem_6rem_4rem_5rem_9rem_1fr_12rem] items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-4 py-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        <span />
        <span>CL</span>
        <span>Type</span>
        <span>Time</span>
        <span>Author</span>
        <span>Message</span>
        <span>Status</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {groups.map((group) => (
          <div key={group.day}>
            <div className="sticky top-0 z-10 border-b border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-4 py-1 text-xs font-semibold text-[var(--color-text-secondary)]">
              {group.day}
            </div>
            {group.entries.map((entry) => {
              const meta = metadata?.[String(entry.number)];
              const isSyncedHere = syncedCl === entry.number;
              const hasArtifacts = (meta?.artifactTypes.length ?? 0) > 0;
              const kind = meta
                ? meta.hasCodeChanges && meta.hasContentChanges
                  ? "Both"
                  : meta.hasCodeChanges
                    ? "Code"
                    : "Content"
                : "";
              const syncedUsers = meta?.syncedUsers ?? [];
              return (
                <div
                  key={entry.number}
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                  className="grid cursor-default grid-cols-[1.5rem_6rem_4rem_5rem_9rem_1fr_12rem] items-center gap-2 border-b border-[var(--color-border-muted)] px-4 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-overlay)]"
                >
                  <span
                    title={isSyncedHere ? "Synced here" : undefined}
                    className="text-[var(--color-accent-fg,#2563eb)]"
                  >
                    {isSyncedHere ? "▶" : ""}
                  </span>
                  <span className="flex items-center gap-1 font-mono text-[var(--color-text-secondary)]">
                    {entry.number}
                    {hasArtifacts ? (
                      <span
                        title={`Binaries available: ${meta?.artifactTypes.join(", ")}`}
                        className="inline-block h-2 w-2 rounded-full bg-[var(--color-success-fg,#16a34a)]"
                      />
                    ) : null}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {kind}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {new Date(entry.createdAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="truncate text-[var(--color-text-secondary)]">
                    {authorLabel(entry)}
                  </span>
                  <span className="truncate">{entry.message}</span>
                  <span className="flex items-center gap-2 overflow-hidden">
                    <BadgeChips meta={meta} />
                    {syncedUsers.length > 0 ? (
                      <span
                        title={syncedUsers
                          .map((u) => u.name || u.username || u.userId)
                          .join(", ")}
                        className="whitespace-nowrap text-xs text-[var(--color-text-muted)]"
                      >
                        {"\u{1F464}"} {syncedUsers.length}
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
