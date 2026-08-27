import { z } from "zod";

// Canonical zod schema for the repo-committed Game Sync config file
// (`.checkpoint/gamesync.yaml`). Applies defaults so consumers always see a
// fully-resolved config.
//
// MIRROR NOTE: the app workspace cannot depend on @checkpointvcs/common
// (type-only import cycle; see src/app/src/server/api/api-version.ts). The
// resolved output shape is mirrored as pure types in
// src/core/common/src/types/gamesync-config.ts for the daemon and desktop.
// Keep the two in sync.

export const GAME_SYNC_CONFIG_PATH = ".checkpoint/gamesync.yaml";

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
    type: z.enum(["compile", "cook", "other"]),
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
  .refine((step) => step.type !== "compile" || !!step.target, {
    message: "compile steps require a target",
  })
  .refine((step) => step.type !== "other" || !!step.command, {
    message: "other steps require a command",
  });

export const GameSyncConfigSchema = z.object({
  version: z.literal(1),
  project: z
    .object({
      name: z.string().optional(),
      uproject: z.string().optional(),
      editorTarget: z.string().optional(),
      editorConfigurations: z
        .array(z.string().min(1))
        .default(["Development", "DebugGame"]),
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

export type GameSyncConfig = z.infer<typeof GameSyncConfigSchema>;

export interface GameSyncConfigResult {
  config: GameSyncConfig | null;
  sourceChangelistNumber: number | null;
  errors: string[] | null;
}
