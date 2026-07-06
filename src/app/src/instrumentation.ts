/**
 * Next.js instrumentation file - runs on server startup
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only log in server runtime, not edge
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { Logger } = await import("./server/logging");

    // IMPORTANT: initialize the Prisma query engine (and, with it, the
    // process-global OpenSSL state) BEFORE any native addon is loaded. The Rust
    // @checkpointvcs/longtail-addon initializes its own OpenSSL, which corrupts
    // the OpenSSL used by Prisma's in-process (library) query engine; if
    // longtail loads first, every Prisma TLS/connection attempt fails with
    // "Error opening a TLS connection: OpenSSL error". Connecting here makes
    // Prisma win the init race; once established, later longtail loads and new
    // pool connections are unaffected. See src/server/db.ts.
    try {
      const { db } = await import("~/server/db");
      await db.$connect();
    } catch (err) {
      Logger.error(
        `[db] Prisma initial connect failed: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
    }

    // Verify license manager key (Ed25519 via DNS TXT record)
    const { verifyLicenseManagerKey, isLicenseManager } =
      await import("~/server/license-utils");
    await verifyLicenseManagerKey();

    // Initialize the license client (no-op unless this is the license manager)
    const { initLicenseClient } = await import("~/server/license-client");
    await initLicenseClient();

    // Start weekly anonymous usage telemetry (self-hosted instances only;
    // self-gates on opt-out and on the license-manager instance).
    const { initTelemetryScheduler } =
      await import("~/server/telemetry/scheduler");
    initTelemetryScheduler();

    const { default: config } = await import("@incanta/config");

    Logger.log(`Checkpoint App:`);
    Logger.log(`  Port:         ${config.get<number>("server.listen-port")}`);
    Logger.log(`  Storage:      ${config.get<string>("storage.mode")}`);
    Logger.log(`  Database:     ${config.get<string>("db.provider")}`);
    Logger.log(
      `  Database URL: ${await config.getWithSecrets<string>("db.url")}`,
    );
    Logger.log(`  SMTP:         ${config.get<boolean>("email.enabled")}`);
    if (isLicenseManager()) {
      Logger.log(`  Stripe:      ${config.get<boolean>("stripe.enabled")}`);
      Logger.log(
        `  Newsletter:  ${config.get<boolean>("newsletter.kit.enabled")}`,
      );
    }

    Logger.log("[healthy] App is ready");
  }
}
