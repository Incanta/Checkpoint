import { z } from "zod";

// Canonical zod schema for the repo-committed Team Sync config file
// (`.checkpoint/teamsync.yaml`). Applies defaults so consumers always see a
// fully-resolved config.
//
// MIRROR NOTE: the app workspace cannot depend on @checkpointvcs/common
// (type-only import cycle; see src/app/src/server/api/api-version.ts). The
// resolved output shape is mirrored as pure types in
// src/core/common/src/types/teamsync-config.ts for the daemon and desktop.
// Keep the two in sync.

export const TEAM_SYNC_CONFIG_PATH = ".checkpoint/teamsync.yaml";

const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "ids may only contain letters, numbers, hyphens, and underscores",
  );

const buildStepSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(200),
    // Defaults to the engine-agnostic type: a repo that never mentions Unreal
    // still gets working build steps.
    type: z.enum(["command", "unreal-compile", "unreal-cook"]).default("command"),
    target: z.string().optional(),
    platform: z.string().optional(),
    configuration: z.string().optional(),
    arguments: z.string().optional(),
    command: z.string().optional(),
    workingDir: z.string().optional(),
    requires: z.array(idSchema).default([]),
    normalSync: z.boolean().default(false),
    scheduledSync: z.boolean().default(false),
    estimatedDurationSec: z.number().int().positive().optional(),
    link: z
      .object({ label: z.string().min(1), url: z.string().min(1) })
      .optional(),
  })
  .refine((step) => step.type !== "unreal-compile" || !!step.target, {
    message: "unreal-compile steps require a target",
  })
  .refine((step) => step.type !== "command" || !!step.command, {
    message: "command steps require a command",
  });

export const TeamSyncConfigSchema = z.object({
  version: z.literal(1),
  project: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
  // Opt-in Unreal support. Omitting this block keeps Team Sync fully
  // engine-agnostic: no Unreal discovery, no default build steps, and the
  // unreal-* step types are rejected at build time.
  unreal: z
    .object({
      uproject: z.string().optional(),
      editorTarget: z.string().optional(),
      editorConfigurations: z
        .array(z.string().min(1))
        .default(["Development", "DebugGame"]),
      defaultBuildSteps: z.boolean().default(true),
    })
    .optional(),
  codeExtensions: z.array(z.string().regex(/^\./, "extensions must start with a dot")).optional(),
  syncCategories: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().min(1).max(200),
        paths: z.array(z.string().min(1)).min(1),
        enabledByDefault: z.boolean().default(true),
        requires: z.array(idSchema).default([]),
        hidden: z.boolean().default(false),
      }),
    )
    .default([]),
  presets: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        default: z.boolean().default(false),
        locked: z.boolean().default(false),
        categories: z.record(z.string(), z.boolean()).default({}),
        buildSteps: z.record(z.string(), z.boolean()).default({}),
      }),
    )
    .default([]),
  buildSteps: z.array(buildStepSchema).default([]),
  artifacts: z
    .array(
      z.object({
        type: idSchema,
        name: z.string().optional(),
        requiredBadges: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
  badges: z
    .object({
      columns: z
        .array(
          z.object({
            name: z.string().min(1).max(100),
            group: z.string().max(100).optional(),
            link: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
  contentBadges: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        paths: z.array(z.string().min(1)).min(1),
      }),
    )
    .default([]),
  tools: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        path: z.string().optional(),
        installCommand: z.string().optional(),
        uninstallCommand: z.string().optional(),
      }),
    )
    .default([]),
  forceClean: z
    .object({
      changelists: z.array(z.number().int().positive()).default([]),
    })
    .default({ changelists: [] }),
  notifications: z
    .object({
      channels: z
        .array(
          z.object({
            type: z.enum(["slack-webhook", "generic-webhook"]),
            url: z.string().url(),
            events: z
              .array(
                z.enum([
                  "badge-failure",
                  "badge-recovered",
                  "investigation-started",
                  "investigation-resolved",
                ]),
              )
              .default(["badge-failure"]),
          }),
        )
        .default([]),
    })
    .optional(),
});

export type TeamSyncConfig = z.infer<typeof TeamSyncConfigSchema>;

export interface TeamSyncConfigResult {
  config: TeamSyncConfig | null;
  sourceChangelistNumber: number | null;
  errors: string[] | null;
}
