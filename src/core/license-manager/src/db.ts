import { PrismaClient } from "@prisma/client";
import config from "@incanta/config";
import { Logger } from "./logging.js";

let prisma: PrismaClient | null = null;

export async function initDb(): Promise<void> {
  const url = config.get<string>("db.url");

  prisma = new PrismaClient({
    datasources: { db: { url } },
  });

  await prisma.$connect();
  Logger.info("Database connected");
}

export function getDb(): PrismaClient {
  if (!prisma) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return prisma;
}

export async function disconnectDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
