import { buildIssueUrlTemplate, fillIssueUrl } from "~/lib/issue-refs";
import {
  trackerFetch,
  type ExternalIssue,
  type TrackerAdapter,
  type TrackerConfigWithSecret,
} from "./types";

interface HacknPlanWorkItem {
  workItemId: number;
  title?: string;
  stage?: { name?: string };
  board?: { name?: string };
  category?: { name?: string };
  assignedUsers?: { user?: { name?: string } }[];
  tags?: { tag?: { name?: string } }[];
  updateDate?: string;
  creationDate?: string;
}

export const hacknplanAdapter: TrackerAdapter = {
  validateConfig(cfg, hasStoredToken) {
    if (!cfg.hacknplanProjectId) return "HacknPlan project ID is required";
    if (!cfg.token && !hasStoredToken) return "HacknPlan API key is required";
    return null;
  },

  async listIssues(cfg: TrackerConfigWithSecret): Promise<ExternalIssue[]> {
    const urlTemplate = buildIssueUrlTemplate("HACKNPLAN", cfg)!;
    const response = await trackerFetch(
      `https://api.hacknplan.com/v0/projects/${cfg.hacknplanProjectId}/workitems?limit=100`,
      {
        headers: {
          Authorization: `ApiKey ${cfg.token}`,
          Accept: "application/json",
        },
      },
    );

    const data = (await response.json()) as
      | HacknPlanWorkItem[]
      | { items?: HacknPlanWorkItem[] };
    const items = Array.isArray(data) ? data : (data.items ?? []);

    return items.map((item) => ({
      id: String(item.workItemId),
      displayId: String(item.workItemId),
      title: item.title ?? `Work item ${item.workItemId}`,
      status: item.stage?.name ?? item.board?.name ?? null,
      type: item.category?.name ?? null,
      url: fillIssueUrl(urlTemplate, String(item.workItemId)),
      assignee: item.assignedUsers?.[0]?.user?.name ?? null,
      labels:
        item.tags
          ?.map((t) => t.tag?.name)
          .filter((name): name is string => !!name) ?? [],
      updatedAt: item.updateDate ?? item.creationDate ?? null,
    }));
  },
};
