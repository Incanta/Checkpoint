import { type NextRequest } from "next/server";

import { db } from "~/server/db";
import { createCaller } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

// PostBadgeStatus-equivalent REST endpoint for generic CI (GitHub Actions,
// TeamCity, Jenkins) that cannot speak tRPC+superjson. Authenticated with the
// same `Authorization: Bearer <ApiToken>` a service account uses; access and
// license checks are enforced by the tRPC caller.
//
// Body: { repo?: "org/repo", repoId?: string, changelist: number,
//         badges: [{ name, group?, state, url?, metadata? }] }
// State is accepted case-insensitively.

const VALID_STATES = new Set([
  "STARTING",
  "FAILURE",
  "WARNING",
  "SUCCESS",
  "SKIPPED",
]);

interface BadgeBody {
  name?: unknown;
  group?: unknown;
  state?: unknown;
  url?: unknown;
  metadata?: unknown;
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: {
    repo?: unknown;
    repoId?: unknown;
    changelist?: unknown;
    badges?: unknown;
  };
  try {
    body = (await request.json()) as {
      repo?: unknown;
      repoId?: unknown;
      changelist?: unknown;
      badges?: unknown;
    };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const changelistNumber =
    typeof body.changelist === "number" ? body.changelist : NaN;
  if (!Number.isInteger(changelistNumber)) {
    return Response.json(
      { error: "Missing or invalid 'changelist'" },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.badges) || body.badges.length === 0) {
    return Response.json({ error: "Missing 'badges'" }, { status: 400 });
  }

  // Normalize + validate badges (uppercase the state for UGS-script parity).
  const badges: {
    changelistNumber: number;
    name: string;
    group?: string;
    state: "STARTING" | "FAILURE" | "WARNING" | "SUCCESS" | "SKIPPED";
    url?: string;
    metadata?: Record<string, unknown>;
  }[] = [];
  for (const raw of body.badges as BadgeBody[]) {
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      return Response.json(
        { error: "Each badge needs a 'name'" },
        { status: 400 },
      );
    }
    const state =
      typeof raw.state === "string" ? raw.state.toUpperCase() : "";
    if (!VALID_STATES.has(state)) {
      return Response.json(
        {
          error: `Invalid state '${String(raw.state)}' for badge '${raw.name}'`,
        },
        { status: 400 },
      );
    }
    badges.push({
      changelistNumber,
      name: raw.name,
      state: state as "STARTING" | "FAILURE" | "WARNING" | "SUCCESS" | "SKIPPED",
      ...(typeof raw.group === "string" ? { group: raw.group } : {}),
      ...(typeof raw.url === "string" ? { url: raw.url } : {}),
      ...(raw.metadata && typeof raw.metadata === "object"
        ? { metadata: raw.metadata as Record<string, unknown> }
        : {}),
    });
  }

  // Resolve repoId from an explicit id or "org/repo".
  let repoId: string | null =
    typeof body.repoId === "string" ? body.repoId : null;
  if (!repoId && typeof body.repo === "string" && body.repo.includes("/")) {
    const [orgName, repoName] = body.repo.split("/", 2);
    const repo = await db.repo.findFirst({
      where: { name: repoName, org: { name: orgName } },
      select: { id: true },
    });
    repoId = repo?.id ?? null;
  }
  if (!repoId) {
    return Response.json(
      { error: "Missing or unknown 'repo'/'repoId'" },
      { status: 404 },
    );
  }

  const ctx = await createTRPCContext({ headers: request.headers });
  if (!ctx.session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const caller = createCaller(ctx);
  try {
    const result = await caller.buildBadge.postBatch({ repoId, badges });
    return Response.json({ ok: true, count: result.count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to post badges";
    // Map tRPC access/feature failures to 403, everything else to 400.
    const status = /access|feature|forbidden|license/i.test(message)
      ? 403
      : 400;
    return Response.json({ error: message }, { status });
  }
}
