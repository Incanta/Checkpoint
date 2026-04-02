import express from "express";
import config from "@incanta/config";
import { routes } from "./routes/index.js";

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
  console.log(`Server listening on port ${port}`);
  console.log("[healthy] Server is ready");
});

process.on("SIGINT", () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  process.exit(0);
});
