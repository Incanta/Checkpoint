import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, adminProcedure } from "~/server/api/trpc";
import { SERVER_VERSION } from "~/server/api/api-version";
import { Logger } from "~/server/logging";
import {
  checkForServerUpdate,
  getUpdateChannel,
  isUpdateCheckEnabled,
} from "~/server/updates/check";
import {
  applyUpdate,
  getStageStatus,
  isBundleDeployment,
  isStaged,
  readComponentState,
  readDesired,
  rollback,
  stageUpdate,
} from "~/server/updates/bundle-state";

/**
 * Which version to act on.
 *
 * Both fields are pasted straight into a filesystem path and a GitHub asset URL
 * by docker/runtime/bootstrap.js. Signature verification is what actually stops
 * a malicious bundle from executing, but there is no reason to let a path
 * segment reach that far, so shape them here.
 */
const bundleTarget = z.object({
  version: z
    .string()
    .regex(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
      "not a semver version",
    ),
  releaseTag: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, "not a valid release tag")
    .nullable()
    .optional(),
});

/**
 * Instance update control.
 *
 * Gated on adminProcedure (checkpointAdmin), NOT licenseManagerAdminProcedure:
 * this is the panel a self-hosted operator uses on their own instance, which is
 * the opposite of the license-manager-only admin surface.
 */
export const updatesRouter = createTRPCRouter({
  getStatus: adminProcedure.query(async () => {
    const bundleDeployment = isBundleDeployment();

    const [app, server, desired] = bundleDeployment
      ? await Promise.all([
          readComponentState("app"),
          readComponentState("server"),
          readDesired(),
        ])
      : [null, null, null];

    const check = await (async () => {
      try {
        const { db } = await import("~/server/db");
        return await checkForServerUpdate(db);
      } catch (err: unknown) {
        Logger.warn(`[Updates] Status check failed: ${String(err)}`);
        return null;
      }
    })();

    const latestVersion = check?.latestVersion ?? null;

    return {
      // What is running.
      currentVersion: SERVER_VERSION,
      channel: getUpdateChannel(),
      checkEnabled: isUpdateCheckEnabled(),

      // How it is deployed. `canInstall` is what the UI keys off: a pinned or
      // air-gapped deployment can see that an update exists but must not offer
      // to install it, because its version is controlled outside the app.
      bundleDeployment,
      mode: app?.mode ?? null,
      canInstall: bundleDeployment && (app?.selfUpdatable ?? false),
      runtimeAbi: app?.runtimeAbi ?? null,
      components: {
        app: app
          ? {
              active: app.active,
              previous: app.previous,
              startedAt: app.startedAt,
            }
          : null,
        server: server
          ? {
              active: server.active,
              previous: server.previous,
              startedAt: server.startedAt,
            }
          : null,
      },
      previousVersion: app?.previous ?? null,
      desired: desired?.version ?? null,

      // What is available.
      latestVersion,
      updateAvailable: check?.updateAvailable ?? false,
      staged:
        latestVersion && bundleDeployment
          ? await isStaged(latestVersion)
          : false,
      stage: getStageStatus(),
    };
  }),

  checkNow: adminProcedure.mutation(async ({ ctx }) => {
    // An explicit click bypasses the cache; getStatus deliberately does not.
    return await checkForServerUpdate(ctx.db, { force: true });
  }),

  /**
   * Begin downloading and verifying a version. Returns immediately; the work
   * continues in the background and is polled through getStatus.
   */
  download: adminProcedure.input(bundleTarget).mutation(async ({ input }) => {
    if (!isBundleDeployment()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "This instance does not run from a deployment bundle, so it cannot download updates.",
      });
    }

    const app = await readComponentState("app");
    if (!app?.selfUpdatable) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "This deployment is pinned to a fixed version. Change the deployment's configuration to move it.",
      });
    }

    // Intentionally not awaited: staging is a large download and the caller
    // polls getStatus for progress.
    void stageUpdate(input.version, input.releaseTag ?? null);

    return { started: true };
  }),

  /**
   * Activate a staged version. The app exits shortly after responding and the
   * container's restart policy brings it back on the new bundle.
   */
  install: adminProcedure
    .input(bundleTarget)
    .mutation(async ({ ctx, input }) => {
      if (!isBundleDeployment()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This instance does not run from a deployment bundle.",
        });
      }

      try {
        await applyUpdate(
          input.version,
          input.releaseTag ?? null,
          ctx.session.user.email ?? ctx.session.user.id,
        );
      } catch (err: unknown) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      return { restarting: true, version: input.version };
    }),

  rollback: adminProcedure.mutation(async ({ ctx }) => {
    if (!isBundleDeployment()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This instance does not run from a deployment bundle.",
      });
    }

    try {
      const version = await rollback(
        ctx.session.user.email ?? ctx.session.user.id,
      );
      return { restarting: true, version };
    } catch (err: unknown) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }),
});
