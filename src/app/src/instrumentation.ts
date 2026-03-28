/**
 * Next.js instrumentation file - runs on server startup
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only log in server runtime, not edge
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Small delay to ensure the server is fully ready
    setTimeout(() => {
      console.log("[healthy] App is ready");
    }, 100);

    // Initialize license client for self-hosted instances
    const { initLicenseClient } = await import("~/server/license-client");
    void initLicenseClient();
  }
}
