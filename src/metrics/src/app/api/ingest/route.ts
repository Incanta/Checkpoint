import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "~/lib/db";

// No authentication: self-hosted instances post anonymous aggregate counts.
export const dynamic = "force-dynamic";

const reportSchema = z.object({
  instanceId: z.string().min(1).max(128),
  orgCount: z.number().int().min(0),
  repoCount: z.number().int().min(0),
  userCount: z.number().int().min(0),
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { instanceId, orgCount, repoCount, userCount } = parsed.data;

  await db.instanceReport.create({
    data: { instanceId, orgCount, repoCount, userCount },
  });

  return NextResponse.json({ ok: true });
}
