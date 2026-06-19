/**
 * Next.js instrumentation file - runs on server startup
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only log in server runtime, not edge
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { Logger } = await import("./server/logging");

    // Verify license manager key (Ed25519 via DNS TXT record)
    const { verifyLicenseManagerKey, isLicenseManager } =
      await import("~/server/license-utils");
    await verifyLicenseManagerKey();

    // Initialize the license client (no-op unless this is the license manager)
    const { initLicenseClient, getInstanceTier } =
      await import("~/server/license-client");
    await initLicenseClient();

    const { default: config } = await import("@incanta/config");

    Logger.log(`Checkpoint App:`);
    Logger.log(`  Port:        ${config.get<number>("server.listen-port")}`);
    Logger.log(`  License:     ${getInstanceTier()}`);
    Logger.log(
      `  Storage:     ${config.get<string>("storage.mode") === "r2" ? "R2" : "SeaweedFS"}`,
    );
    Logger.log(`  Database:    ${config.get<string>("db.provider")}`);
    if (isLicenseManager()) {
      Logger.log(`  Stripe:      ${config.get<boolean>("stripe.enabled")}`);
      Logger.log(
        `  Newsletter:  ${config.get<boolean>("newsletter.kit.enabled")}`,
      );
      Logger.log(`  SMTP:        ${config.get<boolean>("email.enabled")}`);
    }

    Logger.log("[healthy] App is ready");
  }
}
