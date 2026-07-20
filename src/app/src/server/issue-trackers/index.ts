import { codecksAdapter } from "./codecks";
import { hacknplanAdapter } from "./hacknplan";
import { jiraAdapter } from "./jira";
import { getCachedIssues, setCachedIssues } from "./cache";
import type {
  ExternalIssue,
  TrackerAdapter,
  TrackerConfigWithSecret,
} from "./types";

export { invalidateIssueCache } from "./cache";
export { TrackerError } from "./types";
export type {
  ExternalIssue,
  TrackerAdapter,
  TrackerConfigWithSecret,
  TrackerErrorKind,
} from "./types";

export type ExternalIssuesPlatform = "JIRA" | "CODECKS" | "HACKNPLAN";

const ADAPTERS: Record<ExternalIssuesPlatform, TrackerAdapter> = {
  JIRA: jiraAdapter,
  CODECKS: codecksAdapter,
  HACKNPLAN: hacknplanAdapter,
};

export function isExternalPlatform(
  platform: string,
): platform is ExternalIssuesPlatform {
  return platform in ADAPTERS;
}

export function getAdapter(platform: ExternalIssuesPlatform): TrackerAdapter {
  return ADAPTERS[platform];
}

export async function listIssuesCached(
  repoId: string,
  platform: ExternalIssuesPlatform,
  cfg: TrackerConfigWithSecret,
): Promise<ExternalIssue[]> {
  const cached = getCachedIssues(repoId);
  if (cached) {
    return cached;
  }
  const issues = await getAdapter(platform).listIssues(cfg);
  setCachedIssues(repoId, issues);
  return issues;
}
