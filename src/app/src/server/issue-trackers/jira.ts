import { buildIssueUrlTemplate, fillIssueUrl } from "~/lib/issue-refs";
import {
  TrackerError,
  trackerFetch,
  type ExternalIssue,
  type TrackerAdapter,
  type TrackerConfigWithSecret,
} from "./types";

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    assignee?: { displayName?: string } | null;
    labels?: string[];
    updated?: string;
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
}

function mapIssues(
  issues: JiraIssue[],
  urlTemplate: string,
): ExternalIssue[] {
  return issues.map((issue) => ({
    id: issue.key,
    displayId: issue.key,
    title: issue.fields?.summary ?? issue.key,
    status: issue.fields?.status?.name ?? null,
    type: issue.fields?.issuetype?.name ?? null,
    url: fillIssueUrl(urlTemplate, issue.key),
    assignee: issue.fields?.assignee?.displayName ?? null,
    labels: issue.fields?.labels ?? [],
    updatedAt: issue.fields?.updated ?? null,
  }));
}

const JIRA_FIELDS = [
  "summary",
  "status",
  "assignee",
  "labels",
  "issuetype",
  "updated",
];

export const jiraAdapter: TrackerAdapter = {
  validateConfig(cfg, hasStoredToken) {
    if (!cfg.jiraBaseUrl) return "Jira base URL is required";
    if (!cfg.jiraEmail) return "Jira account email is required";
    if (!cfg.jiraProjectKey) return "Jira project key is required";
    if (!cfg.token && !hasStoredToken) return "Jira API token is required";
    return null;
  },

  async listIssues(cfg: TrackerConfigWithSecret): Promise<ExternalIssue[]> {
    const base = cfg.jiraBaseUrl!.replace(/\/+$/, "");
    const urlTemplate = buildIssueUrlTemplate("JIRA", cfg)!;
    const jql = `project = ${cfg.jiraProjectKey} ORDER BY updated DESC`;
    const authorization = `Basic ${Buffer.from(
      `${cfg.jiraEmail}:${cfg.token}`,
    ).toString("base64")}`;

    // Current-generation search endpoint; older Jira deployments only have
    // the deprecated /rest/api/3/search, so fall back on 404.
    try {
      const response = await trackerFetch(`${base}/rest/api/3/search/jql`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jql,
          maxResults: 100,
          fields: JIRA_FIELDS,
        }),
      });
      const data = (await response.json()) as JiraSearchResponse;
      return mapIssues(data.issues ?? [], urlTemplate);
    } catch (err) {
      if (!(err instanceof TrackerError) || err.kind !== "notFound") {
        throw err;
      }
    }

    const params = new URLSearchParams({
      jql,
      maxResults: "100",
      fields: JIRA_FIELDS.join(","),
    });
    const response = await trackerFetch(
      `${base}/rest/api/3/search?${params.toString()}`,
      {
        headers: { Authorization: authorization, Accept: "application/json" },
      },
    );
    const data = (await response.json()) as JiraSearchResponse;
    return mapIssues(data.issues ?? [], urlTemplate);
  },
};
