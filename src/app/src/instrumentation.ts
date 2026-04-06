/**
 * Next.js instrumentation file - runs on server startup
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import { InitLogger, Logger } from "./server/logging";

export async function register() {
  await InitLogger();

  // Only log in server runtime, not edge
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Small delay to ensure the server is fully ready
    setTimeout(() => {
      Logger.log("[healthy] App is ready");
    }, 100);
  }
}
