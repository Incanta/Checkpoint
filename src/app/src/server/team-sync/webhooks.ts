import type { BuildBadgeState, PrismaClient } from "@prisma/client";

import { getTeamSyncConfig } from "./config";

const WEBHOOK_TIMEOUT_MS = 5000;

interface BadgeWebhookOptions {
  repoId: string;
  changelistNumber: number;
  badgeName: string;
  state: BuildBadgeState;
  url: string | null;
  transition: "failure" | "recovered";
}

/**
 * Fire outbound webhooks configured in the repo's teamsync.yaml on badge
 * transitions. Best-effort: each POST is time-boxed and swallowed on error so
 * it never blocks or fails the badge write.
 */
export async function dispatchBadgeWebhooks(
  db: PrismaClient,
  opts: BadgeWebhookOptions,
): Promise<void> {
  const repo = await db.repo.findUnique({
    where: { id: opts.repoId },
    include: { org: true },
  });
  if (!repo) return;

  const branch = await db.branch.findFirst({
    where: { repoId: opts.repoId, isDefault: true },
    select: { headNumber: true },
  });
  if (!branch) return;

  // A config read needs a user id for storage tokens; any org member works,
  // but we avoid a lookup by only dispatching when the repo has a config with
  // notification channels. Reuse the badge poster is not available here, so
  // read as the repo owner-less path is not possible; instead resolve the
  // repo's most recent changelist author as the reader identity.
  const authorCl = await db.changelist.findFirst({
    where: { repoId: opts.repoId, userId: { not: null } },
    orderBy: { number: "desc" },
    select: { userId: true },
  });
  if (!authorCl?.userId) return;

  const configResult = await getTeamSyncConfig(
    db,
    authorCl.userId,
    repo,
    branch.headNumber,
  ).catch(() => null);

  const channels = configResult?.config?.notifications?.channels ?? [];
  if (channels.length === 0) return;

  const event =
    opts.transition === "failure" ? "badge-failure" : "badge-recovered";

  await Promise.all(
    channels
      .filter((channel) => channel.events.includes(event))
      .map((channel) => postWebhook(channel, opts, repo.org.name, repo.name)),
  );
}

async function postWebhook(
  channel: { type: "slack-webhook" | "generic-webhook"; url: string },
  opts: BadgeWebhookOptions,
  orgName: string,
  repoName: string,
): Promise<void> {
  const summary =
    opts.transition === "failure"
      ? `:red_circle: ${opts.badgeName} broke at ${orgName}/${repoName} CL ${opts.changelistNumber}`
      : `:large_green_circle: ${opts.badgeName} recovered at ${orgName}/${repoName} CL ${opts.changelistNumber}`;

  const body =
    channel.type === "slack-webhook"
      ? { text: opts.url ? `${summary}\n${opts.url}` : summary }
      : {
          event: `badge-${opts.transition}`,
          repo: `${orgName}/${repoName}`,
          changelist: opts.changelistNumber,
          badge: opts.badgeName,
          state: opts.state,
          url: opts.url,
        };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(channel.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Best-effort; swallow network/timeout errors.
  } finally {
    clearTimeout(timeout);
  }
}
