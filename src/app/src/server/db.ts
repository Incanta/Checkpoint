import { type Prisma, PrismaClient } from "@prisma/client";
import config from "@incanta/config";

import { env } from "~/env";

const createPrismaClient = () => {
  const logLevel = config.get<string>("logging.level");

  const log: Prisma.LogLevel[] = ["error"];
  if (logLevel === "debug" || logLevel === "trace") {
    log.push("query", "warn");
  }

  return new PrismaClient({
    log,
  });
};

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") globalForPrisma.prisma = db;
