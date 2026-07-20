import { buildIssueUrlTemplate, fillIssueUrl } from "~/lib/issue-refs";
import {
  trackerFetch,
  type ExternalIssue,
  type TrackerAdapter,
  type TrackerConfigWithSecret,
} from "./types";

// Codecks' query API and card ID scheme are poorly documented; everything
// Codecks-specific (query body, response parsing, accountSeq display IDs) is
// deliberately quarantined in this file. Expect to iterate against a real
// account.

interface CodecksCard {
  cardId?: string;
  accountSeq?: number;
  title?: string;
  status?: string;
  lastUpdatedAt?: string;
  assignee?: { name?: string } | string | null;
}

// Codecks displays card short IDs as "$" + accountSeq in base 36 (e.g. card
// 1234 -> "$ya"). If a real account shows a different alphabet, adjust here.
export function accountSeqToDisplayId(accountSeq: number): string {
  return `$${accountSeq.toString(36)}`;
}

export const codecksAdapter: TrackerAdapter = {
  validateConfig(cfg, hasStoredToken) {
    if (!cfg.codecksSubdomain) return "Codecks subdomain is required";
    if (!cfg.token && !hasStoredToken) return "Codecks API token is required";
    return null;
  },

  async listIssues(cfg: TrackerConfigWithSecret): Promise<ExternalIssue[]> {
    const urlTemplate = buildIssueUrlTemplate("CODECKS", cfg)!;
    const response = await trackerFetch("https://api.codecks.io/", {
      method: "POST",
      headers: {
        "X-Auth-Token": cfg.token,
        "X-Account": cfg.codecksSubdomain!,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: {
          _root: [
            {
              account: [
                {
                  'cards({"$order":"-lastUpdatedAt","$first":100})': [
                    "cardId",
                    "accountSeq",
                    "title",
                    "status",
                    "lastUpdatedAt",
                    { assignee: ["name"] },
                  ],
                },
              ],
            },
          ],
        },
      }),
    });

    // The query API returns a normalized graph keyed by entity type; cards
    // live under a top-level "card" map.
    const data = (await response.json()) as {
      card?: Record<string, CodecksCard>;
    };
    const cards = Object.values(data.card ?? {});

    return cards
      .filter((card) => card.accountSeq !== undefined)
      .map((card) => {
        const displayId = accountSeqToDisplayId(card.accountSeq!);
        const assignee =
          typeof card.assignee === "string"
            ? card.assignee
            : (card.assignee?.name ?? null);
        return {
          id: displayId,
          displayId,
          title: card.title ?? displayId,
          status: card.status ?? null,
          type: null,
          url: fillIssueUrl(urlTemplate, displayId),
          assignee,
          labels: [],
          updatedAt: card.lastUpdatedAt ?? null,
        };
      });
  },
};
