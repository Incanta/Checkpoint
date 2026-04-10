/**
 * Next.js instrumentation file - runs on server startup
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only log in server runtime, not edge
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { Logger } = await import("./server/logging");

    // Small delay to ensure the server is fully ready
    setTimeout(() => {
      Logger.log("[healthy] App is ready");
    }, 100);
  }
}
