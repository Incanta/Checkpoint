import type { TrackerPublicConfig } from "~/lib/issue-refs";

// Normalized issue shape returned by every tracker adapter.
export interface ExternalIssue {
  id: string; // stable native id used in URLs
  displayId: string; // "PROJ-123", "123", "$1a7"
  title: string;
  status: string | null;
  type: string | null;
  url: string;
  assignee: string | null;
  labels: string[];
  updatedAt: string | null; // ISO timestamp
}

export interface TrackerConfigWithSecret extends TrackerPublicConfig {
  token: string;
  jiraEmail?: string | null;
}

export type TrackerErrorKind = "auth" | "notFound" | "network" | "other";

export class TrackerError extends Error {
  kind: TrackerErrorKind;

  constructor(kind: TrackerErrorKind, message: string) {
    super(message);
    this.name = "TrackerError";
    this.kind = kind;
  }
}

export interface TrackerAdapter {
  listIssues(cfg: TrackerConfigWithSecret): Promise<ExternalIssue[]>;
  // Returns a user-facing error message, or null when the config is valid.
  validateConfig(
    cfg: Partial<TrackerConfigWithSecret>,
    hasStoredToken: boolean,
  ): string | null;
}

const FETCH_TIMEOUT_MS = 10_000;

export async function trackerFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new TrackerError(
      "network",
      "Could not reach the issue tracker. Check the configured URL and your network connection.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new TrackerError(
      "auth",
      "The issue tracker rejected the configured credentials.",
    );
  }
  if (response.status === 404) {
    throw new TrackerError(
      "notFound",
      "The issue tracker endpoint was not found. Check the configured URL and project settings.",
    );
  }
  if (!response.ok) {
    throw new TrackerError(
      "other",
      `The issue tracker returned an unexpected error (HTTP ${response.status}).`,
    );
  }

  return response;
}
