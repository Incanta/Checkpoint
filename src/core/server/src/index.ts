import express from "express";
import config from "@incanta/config";
import { routes } from "./routes/index.js";
import { Logger } from "./logging.js";

// beforeExit does NOT fire when process.exit() is called explicitly.
// Use "exit" event + monkey-patch to catch all exit paths.
const originalExit = process.exit;
process.exit = function (...args: Parameters<typeof process.exit>) {
  console.error(`process.exit(${args[0]}) called`);
  console.trace("Stack trace at process.exit:");
  return originalExit.apply(process, args);
} as typeof process.exit;

process.on("exit", (code) => {
  console.log(`Process exiting with code: ${code}`);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const port = config.get<number>("server.listen-port");

const app = express();

app.use(express.json());
app.use(routes());

app.listen(port, () => {
  const mode = config.get<string>("storage.mode");
  Logger.log(`Checkpoint Server:`);
  Logger.log(`  Port:        ${port}`);
  Logger.log(`  Storage:     ${mode}`);

  if (mode === "local") {
    Logger.log(`  Path:        ${config.get<string>("storage.local.path")}`);
  } else if (mode === "s3") {
    Logger.log(`  S3 bucket:   ${config.get<string>("storage.s3.bucket")}`);
  } else if (mode === "r2") {
    if (
      !config.get<string>("storage.r2.account-id") ||
      !config.get<string>("storage.r2.access-key-id") ||
      !config.get<string>("storage.r2.secret-access-key") ||
      !config.get<string>("storage.r2.api-token")
    ) {
      Logger.fatal("R2 storage configuration is incomplete");
      process.exit(1);
    }
  } else {
    Logger.fatal(`Unknown storage.mode: ${mode}`);
    process.exit(1);
  }

  Logger.log("[healthy] Server is ready");
});

process.on("SIGINT", () => {
  Logger.log("Received SIGINT. Shutting down gracefully...");
  process.exit(0);
});
