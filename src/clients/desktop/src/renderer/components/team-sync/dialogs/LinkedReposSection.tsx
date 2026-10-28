import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { currentWorkspaceAtom } from "../../../../common/state/workspace";
import {
  teamSyncLinksAtom,
  getWsRecord,
  type TeamSyncLinkMode,
  type TeamSyncLinkReport,
} from "../../../../common/state/team-sync";
import { ipc } from "../../../pages/ipc";
import { Badge, Button } from "../../ui";
import { describeLink, linkBadge } from "../links";
import { selectClass } from "./shared";

const CREATE = "__create__";

const MODES: { value: TeamSyncLinkMode; label: string }[] = [
  { value: "follow-pin", label: "Follow the pin" },
  { value: "manual", label: "Manual" },
  { value: "ignore", label: "Ignore" },
];

const inputClass = `${selectClass} min-w-0 flex-1`;

/**
 * The settings for each linked repo: which local workspace satisfies it, its
 * mode, and where it stands. Changes apply right away (they don't wait for
 * the dialog's Save), since creating a workspace can't be undone by Cancel.
 */
export default function LinkedReposSection(): React.ReactElement {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const linksRecord = useAtomValue(teamSyncLinksAtom);
  const links = getWsRecord(linksRecord, currentWorkspace?.id);

  useEffect(() => {
    ipc.sendMessage("team-sync:links:refresh", null);
  }, [currentWorkspace?.id]);

  if (!links) {
    return (
      <div className="text-sm text-[var(--color-text-muted)]">
        Loading linked repos...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs text-[var(--color-text-muted)]">
        Linked repos are synced to the changelist this repo pins, before this
        workspace syncs. Changes here apply right away.
        {links.configChangelist != null &&
          ` Pins as of changelist ${links.configChangelist}.`}
      </div>
      {links.error && (
        <div className="whitespace-pre-wrap rounded-md bg-[var(--color-danger)]/15 px-3 py-2 text-xs text-[var(--color-danger)]">
          {links.error}
        </div>
      )}
      {links.links.length === 0 && (
        <div className="text-sm text-[var(--color-text-muted)]">
          This workspace's changelist pins no linked repos.
        </div>
      )}
      {links.links.map((link) => (
        <LinkRow
          key={link.repo}
          link={link}
          candidates={links.candidates[link.repo.toLowerCase()] ?? []}
          busy={links.busy}
        />
      ))}
    </div>
  );
}

function LinkRow({
  link,
  candidates,
  busy,
}: {
  link: TeamSyncLinkReport;
  candidates: { id: string; name: string; localPath: string }[];
  busy: boolean;
}): React.ReactElement {
  const [creating, setCreating] = useState(false);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState(link.repo);
  const nested = link.path !== undefined;
  const badge = linkBadge(link);

  // The folder picker answers asynchronously, tagged with the repo.
  useEffect(() => {
    return ipc.on("team-sync:links:pick-folder:data", (data) => {
      if (data.repo === link.repo) setFolder(data.path);
    });
  }, [link.repo]);

  const set = (
    mode: TeamSyncLinkMode,
    linkedWorkspaceId: string | null,
  ): void =>
    ipc.sendMessage("team-sync:links:set", {
      repo: link.repo,
      mode,
      linkedWorkspaceId,
    });

  const onWorkspace = (value: string): void => {
    if (value === CREATE) {
      setCreating(true);
      return;
    }
    setCreating(false);
    // Choosing a workspace for an ignored link means the user wants it.
    const mode = link.mode === "ignore" && value ? "follow-pin" : link.mode;
    set(mode, value || null);
  };

  const onMode = (mode: TeamSyncLinkMode): void => {
    set(mode, mode === "ignore" ? null : (link.workspaceId ?? null));
  };

  const onCreate = (): void => {
    ipc.sendMessage("team-sync:links:create", {
      repo: link.repo,
      path: folder,
      name: name.trim() || link.repo,
      mode: link.mode === "manual" ? "manual" : "follow-pin",
    });
    setCreating(false);
  };

  // The chosen workspace may not be a candidate (missing, wrong repo); keep
  // it selectable so the select shows the real choice.
  const chosenKnown = candidates.some((c) => c.id === link.workspaceId);

  return (
    <div className="flex flex-col gap-2 border-b border-[var(--color-border-muted)] pb-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">
          {link.repo}
        </span>
        <span className="font-mono text-xs text-[var(--color-text-muted)]">
          {link.branch}@{link.pin}
        </span>
        <Badge variant={badge.tone} className="ml-auto">
          {badge.label}
        </Badge>
      </div>

      <div className="text-xs text-[var(--color-text-secondary)]">
        {describeLink(link)}
        {link.holder &&
          ` ${link.holder.workspaceName} last moved it, to changelist ${link.holder.changelist}.`}
        {link.source === "preset" && " Mode set by the preset."}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {nested ? (
          // A nested link's workspace is whatever is in its folder; Team
          // Sync creates it there, so there is nothing to pick.
          <span
            className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]"
            title={link.localPath}
          >
            In <span className="font-mono">{link.path}</span>
            {link.workspaceName && ` (${link.workspaceName})`}
          </span>
        ) : (
          <select
            aria-label={`Workspace for ${link.repo}`}
            value={creating ? CREATE : (link.workspaceId ?? "")}
            disabled={busy || link.mode === "ignore"}
            onChange={(e) => onWorkspace(e.target.value)}
            className={`${inputClass} disabled:opacity-50`}
          >
            <option value="">No workspace</option>
            {link.workspaceId && !chosenKnown && (
              <option value={link.workspaceId}>
                {link.workspaceName ?? "Unknown workspace"}
              </option>
            )}
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.localPath})
              </option>
            ))}
            <option value={CREATE}>Create a new workspace...</option>
          </select>
        )}
        <select
          aria-label={`Mode for ${link.repo}`}
          value={link.mode}
          disabled={busy}
          onChange={(e) => onMode(e.target.value as TeamSyncLinkMode)}
          className={`${selectClass} disabled:opacity-50`}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {link.source === "workspace" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              ipc.sendMessage("team-sync:links:clear", { repo: link.repo })
            }
            title="Forget this choice and use the preset's mode, or the default"
          >
            Reset
          </Button>
        )}
      </div>

      {creating && !nested && (
        <div className="flex flex-col gap-2 rounded-md bg-[var(--color-bg-primary)] p-3">
          <div className="text-xs text-[var(--color-text-muted)]">
            A new, empty workspace of {link.repo} on {link.branch}. The next
            sync brings it to the pin. Choose a folder outside every workspace;
            it can be shared by other repos that link {link.repo}.
          </div>
          <div className="flex items-center gap-2">
            <input
              aria-label="Folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="Folder"
              className={inputClass}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                ipc.sendMessage("team-sync:links:pick-folder", {
                  repo: link.repo,
                })
              }
            >
              Browse...
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <input
              aria-label="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workspace name"
              className={inputClass}
            />
            <Button
              size="sm"
              disabled={busy || folder.trim() === ""}
              onClick={onCreate}
            >
              Create and link
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
