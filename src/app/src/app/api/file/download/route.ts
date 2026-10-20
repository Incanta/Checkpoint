import config from "@incanta/config";
import path from "path";
import { type NextRequest } from "next/server";
import {
  readFileFromVersionAsync,
  pollReadFileHandle,
  freeReadFileHandle,
  GetLogLevel,
} from "@checkpointvcs/longtail-addon";

import { TRPCError } from "@trpc/server";

import { getSession } from "~/server/auth";
import { db } from "~/server/db";
import { getUserAndRepoWithAccess } from "~/server/api/auth-utils";
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

  // Verify access: the same READ rule the tRPC routes apply. This used to
  // check only that the repo existed, so any signed-in user could download
  // any repo's files by id.
  let repo: Awaited<ReturnType<typeof getUserAndRepoWithAccess>>["repo"];
  try {
    ({ repo } = await getUserAndRepoWithAccess(
      { db, session, headers: request.headers },
      repoId,
      "READ",
    ));
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    if (error.code === "FORBIDDEN") {
      return Response.json({ error: error.message }, { status: 403 });
    }
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

    // A view, not a copy: files can be large.
    const body = new Uint8Array(
      buffer.buffer as ArrayBuffer,
      buffer.byteOffset,
      buffer.length,
    );
    return new Response(body, {
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
