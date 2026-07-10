import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { promises as fs } from "fs";
import { homedir } from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { AppRouter } from "@checkpointvcs/daemon";

export type DaemonClient = ReturnType<typeof createTRPCClient<AppRouter>>;

const DEFAULT_DAEMON_PORT = 13010;

/**
 * Resolves the daemon port from the `checkpoint.daemonPort` setting, falling
 * back to ~/.checkpoint/daemon.json (the same source the other clients use),
 * and finally the well-known default.
 */
export async function resolveDaemonPort(): Promise<number> {
  const override = vscode.workspace
    .getConfiguration("checkpoint")
    .get<number>("daemonPort", 0);
  if (override > 0) {
    return override;
  }

  try {
    const raw = await fs.readFile(
      path.join(homedir(), ".checkpoint", "daemon.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    if (typeof parsed.daemonPort === "number" && parsed.daemonPort > 0) {
      return parsed.daemonPort;
    }
  } catch {
    // No daemon config yet; use the default port.
  }

  return DEFAULT_DAEMON_PORT;
}

export async function createDaemonClient(): Promise<DaemonClient> {
  const port = await resolveDaemonPort();

  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${port}`,
        transformer: superjson,
      }),
    ],
  });
}

const JOB_POLL_INTERVAL_MS = 500;

export interface JobProgress {
  currentStep: string;
  done: number;
  total: number;
}

export interface JobResult {
  status: string;
  result: unknown;
  error: string | null;
}

/**
 * Polls a long-running daemon job (submit/pull) until it completes or fails.
 */
export async function pollJob(
  client: DaemonClient,
  jobId: string,
  onProgress?: (progress: JobProgress) => void,
): Promise<JobResult> {
  while (true) {
    const job = await client.jobs.getStatus.query({ jobId });

    if (onProgress) {
      onProgress({
        currentStep: job.currentStep ?? "",
        done: job.progress?.done ?? 0,
        total: job.progress?.total ?? 0,
      });
    }

    if (job.status === "completed") {
      return { status: job.status, result: job.result, error: null };
    }
    if (job.status === "failed") {
      return { status: job.status, result: null, error: job.error };
    }

    await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
  }
}
