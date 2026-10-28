import type {
  TeamSyncLinkConfirmReason,
  TeamSyncLinkReport,
  TeamSyncPinChange,
} from "../../../common/state/team-sync";

// Wording for linked repos, shared by the status bar, settings, the confirm
// prompt, the changelist browser, and bisect.

export type LinkTone = "success" | "warning" | "danger" | "default";

/** A short label and color for a link's status. */
export function linkBadge(link: TeamSyncLinkReport): {
  label: string;
  tone: LinkTone;
} {
  switch (link.status) {
    case "up-to-date":
    case "synced":
      return { label: `at ${link.pin}`, tone: "success" };
    case "out-of-date":
      return {
        label: link.mode === "manual" ? "differs from pin" : "needs sync",
        tone: "warning",
      };
    case "needs-confirmation":
      return { label: "needs confirmation", tone: "warning" };
    case "not-set-up":
      return { label: "not set up", tone: "default" };
    case "ignored":
      return { label: "ignored", tone: "default" };
    case "unsupported":
      return { label: "nested, not synced yet", tone: "default" };
    case "busy":
      return { label: "busy", tone: "warning" };
    case "missing-workspace":
      return { label: "workspace missing", tone: "danger" };
    case "wrong-repo":
      return { label: "wrong repo", tone: "danger" };
    case "wrong-branch":
      return { label: "wrong branch", tone: "danger" };
    case "overlay-active":
      return { label: "feature branch active", tone: "danger" };
  }
}

/** One sentence on where a link stands and what Team Sync will do. */
export function describeLink(link: TeamSyncLinkReport): string {
  const at =
    link.fromChangelist !== undefined
      ? `at changelist ${link.fromChangelist}`
      : "not synced";
  switch (link.status) {
    case "up-to-date":
    case "synced":
      return `Pinned ${link.pin}, at ${link.pin}.`;
    case "out-of-date":
      return link.mode === "manual"
        ? `Pinned ${link.pin}, ${at}. Manual mode: Team Sync reports this but never moves it.`
        : `Pinned ${link.pin}, ${at}. The next sync moves it to the pin.`;
    case "needs-confirmation":
      return `Pinned ${link.pin}, ${at}. Moving it needs your go-ahead.`;
    case "not-set-up":
      return `Pinned ${link.pin}. No workspace chosen: pick one, create one, or ignore the link. This workspace still syncs.`;
    case "ignored":
      return "Ignored. Team Sync leaves it alone.";
    case "unsupported":
      return `Mounted at ${link.path ?? "a path"} inside this workspace. Team Sync doesn't sync nested links yet.`;
    case "busy":
      return `Pinned ${link.pin}, ${at}. Another operation is running in it; syncing waits until it finishes.`;
    case "missing-workspace":
      return "The chosen workspace isn't registered on this machine. Pick another or create one.";
    case "wrong-repo":
      return `The chosen workspace holds a different repo than ${link.repo}.`;
    case "wrong-branch":
      return `The chosen workspace isn't on ${link.branch}, the branch the pin refers to.`;
    case "overlay-active":
      return "The chosen workspace has feature branches active, so Team Sync won't move it.";
  }
}

const REASONS: Record<TeamSyncLinkConfirmReason, string> = {
  "local-changes": "It has local changes. They're kept, merged like any sync.",
  "ahead-of-pin": "It's ahead of the pin, so this moves it back.",
  "held-by-other": "Another workspace moved it to a different changelist.",
};

/** Why a link needs confirmation, one sentence per reason. */
export function confirmReasons(link: TeamSyncLinkReport): string[] {
  return (link.reasons ?? []).map((reason) =>
    reason === "held-by-other" && link.holder
      ? `${link.holder.workspaceName} moved it to changelist ${link.holder.changelist}, and moving it may break that workspace's build.`
      : REASONS[reason],
  );
}

/** "UE5 48213 → 48500", "UE5 added at 48213", or "UE5 removed". */
export function describePinChange(change: TeamSyncPinChange): string {
  const { repo, from, to } = change;
  if (!from && to) return `${repo} added at ${to.branch}@${to.changelist}`;
  if (from && !to) return `${repo} removed`;
  if (from && to && from.branch !== to.branch) {
    return `${repo} ${from.branch}@${from.changelist} → ${to.branch}@${to.changelist}`;
  }
  return `${repo} ${from?.changelist} → ${to?.changelist}`;
}
