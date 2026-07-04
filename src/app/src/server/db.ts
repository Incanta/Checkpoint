import { type Prisma, PrismaClient } from "@prisma/client";
import config from "@incanta/config";

import { env } from "~/env";

const createPrismaClient = () => {
  const logLevel = config.get<string>("logging.level");

  const log: Prisma.LogLevel[] = ["error"];
  if (logLevel === "trace") {
    log.push("query", "warn");
  }

  console.log(
    `Creating prisma client with url: ${env.DATABASE_URL} and log level: ${log.join(", ")}`,
  );

  return new PrismaClient({
    log,
    datasources: {
      db: {
        url: env.DATABASE_URL,
      },
    },
  });
};

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") globalForPrisma.prisma = db;
