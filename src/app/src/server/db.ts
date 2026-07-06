import { type Prisma, PrismaClient } from "@prisma/client";
import config from "@incanta/config";

import { env } from "~/env";

const createPrismaClient = () => {
  const logLevel = config.get<string>("logging.level");

  const log: Prisma.LogLevel[] = ["error"];
  if (logLevel === "trace") {
    log.push("query", "warn");
  }

  // Read DATABASE_URL at construction (runtime), not module-import time, and
  // pass it to Prisma explicitly. The Next.js/Turbopack standalone bundle
  // mangles Prisma's implicit env("DATABASE_URL") resolution, so the engine
  // ends up negotiating TLS against a plaintext server ("Error opening a TLS
  // connection: OpenSSL error"). Handing the URL to the constructor bypasses
  // that. During `next build` (Turbopack page-data collection) the var is
  // unset, so omit datasourceUrl then; the constructor rejects `undefined`
  // and no connection is made at build time anyway.
  const url = process.env.DATABASE_URL;

  return new PrismaClient({
    log,
    ...(url ? { datasourceUrl: url } : {}),
  });
};

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") globalForPrisma.prisma = db;
