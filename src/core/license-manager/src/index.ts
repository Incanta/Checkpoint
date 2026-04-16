import express from "express";
import config from "@incanta/config";
import { Logger } from "./logging.js";
import { verifyLicenseManagerKey } from "./license-utils.js";
import { initDb, disconnectDb } from "./db.js";
import { routes } from "./routes/index.js";

process.on("uncaughtException", (err) => {
  Logger.error(err, "Uncaught exception");
});

process.on("unhandledRejection", (reason) => {
  Logger.error({ reason }, "Unhandled rejection");
});

async function main(): Promise<void> {
  const verified = await verifyLicenseManagerKey();
  if (!verified) {
    Logger.fatal(
      "Failed to verify license manager key — cannot start license manager.",
    );
    process.exit(1);
  }

  await initDb();

  const port = config.get<number>("server.listen-port");
  const app = express();

  app.use(express.json());
  app.use(routes());

  app.listen(port, () => {
    Logger.info(`Checkpoint License Manager:`);
    Logger.info(`  Port: ${port}`);
    Logger.info("[healthy] License Manager is ready");
  });
}

async function shutdown(signal: string): Promise<void> {
  Logger.info(`Received ${signal}. Shutting down gracefully...`);
  await disconnectDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  Logger.fatal(err, "Failed to start License Manager");
  process.exit(1);
});
