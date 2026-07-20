// Issue reference ("#<native-id>") parsing and URL building shared by the
// web app and desktop clients. This module must stay dependency-free and
// browser-safe: client code deep-imports it (bypassing the barrel, which
// re-exports Node-only modules).

export type IssuesPlatformKind =
  | "CHECKPOINT"
  | "JIRA"
  | "CODECKS"
  | "HACKNPLAN"
  | "DISABLED";

// Each pattern captures: (1) the boundary prefix, (2) the platform-native id.
// Only the configured platform's pattern is ever applied, so e.g. "#123" is
// not linkified on a repo configured for Jira.
const REF_PATTERNS: Record<IssuesPlatformKind, RegExp | null> = {
  CHECKPOINT: /(^|[^\w#])#(\d+)\b/g,
  HACKNPLAN: /(^|[^\w#])#(\d+)\b/g,
  JIRA: /(^|[^\w#])#([A-Z][A-Z0-9]+-\d+)\b/g,
  CODECKS: /(^|[^\w#])#(\$?[0-9a-z]{2,5})\b/g,
  DISABLED: null,
};

export function getIssueRefPattern(
  platform: IssuesPlatformKind,
): RegExp | null {
  const pattern = REF_PATTERNS[platform] ?? null;
  // Return a fresh instance; the stored ones are stateful due to the g flag.
  return pattern ? new RegExp(pattern.source, pattern.flags) : null;
}

export interface IssueRefSegment {
  type: "text" | "ref";
  text: string;
  refId?: string;
}

export function tokenizeIssueRefs(
  text: string,
  platform: IssuesPlatformKind,
): IssueRefSegment[] {
  const pattern = getIssueRefPattern(platform);
  if (!pattern || !text) {
    return text ? [{ type: "text", text }] : [];
  }

  const segments: IssueRefSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const [full, prefix, refId] = match as unknown as [string, string, string];
    const refStart = match.index + prefix.length;
    if (refStart > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, refStart) });
    }
    segments.push({ type: "ref", text: `#${refId}`, refId });
    lastIndex = match.index + full.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }

  return segments;
}

// Non-secret configuration needed to build links to external issues.
export interface TrackerPublicConfig {
  jiraBaseUrl?: string | null;
  jiraProjectKey?: string | null;
  codecksSubdomain?: string | null;
  hacknplanProjectId?: number | null;
}

// Returns a URL template containing an "{id}" placeholder, or null when the
// platform has no external URL (Checkpoint links are internal app routes).
export function buildIssueUrlTemplate(
  platform: IssuesPlatformKind,
  cfg: TrackerPublicConfig,
): string | null {
  switch (platform) {
    case "JIRA":
      return cfg.jiraBaseUrl
        ? `${cfg.jiraBaseUrl.replace(/\/+$/, "")}/browse/{id}`
        : null;
    case "HACKNPLAN":
      return cfg.hacknplanProjectId
        ? `https://app.hacknplan.com/p/${cfg.hacknplanProjectId}/kanban?taskId={id}`
        : null;
    case "CODECKS":
      return cfg.codecksSubdomain
        ? `https://${cfg.codecksSubdomain}.codecks.io/card/{id}`
        : null;
    default:
      return null;
  }
}

export function fillIssueUrl(template: string, refId: string): string {
  return template.replace("{id}", encodeURIComponent(refId));
}
