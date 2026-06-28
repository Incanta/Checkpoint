import config from "@incanta/config";
import path from "path";
import { type NextRequest } from "next/server";
import {
  readFileFromVersionAsync,
  pollReadFileHandle,
  freeReadFileHandle,
  GetLogLevel,
} from "@checkpointvcs/longtail-addon";

import { getSession } from "~/server/auth";
import { db } from "~/server/db";
import { buildAddonStorageOptions } from "~/server/storage-options";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const repoId = searchParams.get("repoId");
  const clNumber = searchParams.get("cl");
  const filePath = searchParams.get("path");

  if (!repoId || !clNumber || !filePath) {
    return Response.json(
      { error: "Missing repoId, cl, or path" },
      { status: 400 },
    );
  }

  // Verify access
  const repo = await db.repo.findUnique({
    where: { id: repoId },
    include: { org: true },
  });

  if (!repo) {
    return Response.json({ error: "Repo not found" }, { status: 404 });
  }

  const changelist = await db.changelist.findUnique({
    where: {
      repoId_number: {
        repoId,
        number: parseInt(clNumber, 10),
      },
    },
    select: { versionIndex: true },
  });

  if (!changelist?.versionIndex) {
    return Response.json({ error: "Changelist not found" }, { status: 404 });
  }

  const remoteBasePath = `/${repo.orgId}/${repo.id}`;

  const storageOptions = await buildAddonStorageOptions(
    session.user.id,
    repo,
    false,
  );

  const logLevel = GetLogLevel(
    config.get<string>(
      "logging.longtail-level",
    ) as import("@checkpointvcs/longtail-addon").LongtailLogLevel,
  );

  const handle = readFileFromVersionAsync({
    filePath,
    versionIndexName: changelist.versionIndex,
    remoteBasePath,
    ...storageOptions,
    logLevel,
  });

  if (!handle) {
    return Response.json({ error: "Failed to read file" }, { status: 500 });
  }

  try {
    const { data, size } = await pollReadFileHandle(handle);

    const fileName = path.basename(filePath);
    const buffer = data && size > 0 ? data : Buffer.alloc(0);

    return new Response(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(buffer.length),
      },
    });
  } finally {
    freeReadFileHandle(handle);
  }
}
