import { z } from "zod";

// Canonical zod schema for the repo-committed Team Sync config file
// (`teamsync.yaml` at the repo root). Applies defaults so consumers always
// see a fully-resolved config.
//
// MIRROR NOTE: the app workspace cannot depend on @checkpointvcs/common
// (type-only import cycle; see src/app/src/server/api/api-version.ts). The
// resolved output shape is mirrored as pure types in
// src/core/common/src/types/teamsync-config.ts for the daemon and desktop.
// Keep the two in sync.

export const TEAM_SYNC_CONFIG_PATH = "teamsync.yaml";

const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "ids may only contain letters, numbers, hyphens, and underscores",
  );

export const HOST_OSES = ["windows", "macos", "linux"] as const;

// One OS or a list; resolved to a list so consumers handle one shape.
const ifOsSchema = z
  .union([z.enum(HOST_OSES), z.array(z.enum(HOST_OSES)).min(1)])
  .transform((value) => [...new Set(Array.isArray(value) ? value : [value])]);

const buildStepSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(200),
    /** Host OSes the step runs on; absent means every OS. */
    ifOs: ifOsSchema.optional(),
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

export const LINK_MODES = ["follow-pin", "manual", "ignore"] as const;

// A linked repo: another repo in the same org, pinned at a changelist, that a
// workspace of this repo keeps a workspace of in sync (see
// plans/linked-repos-plan.md). Linking is engine-agnostic: it only syncs.
const linkedRepoSchema = z.object({
  /** Repo name in the same org; also the key workspaces and presets use. */
  repo: z.string().min(1).max(200),
  branch: z.string().min(1).max(200),
  changelist: z.number().int().nonnegative(),
  /**
   * Repo-relative mount path for a nested link: syncing creates the linked
   * repo's workspace in this folder.
   */
  path: z
    .string()
    .min(1)
    .refine(
      (p) =>
        !/^[\\/]/.test(p) &&
        !/^[a-zA-Z]:/.test(p) &&
        !p.split(/[\\/]/).includes(".."),
      "path must be repo-relative and stay inside the repo",
    )
    .refine((p) => {
      const segments = p.replace(/[\\/]+$/, "").split(/[\\/]/);
      return segments.every((s) => s !== "" && s !== ".");
    }, "path must not have empty or '.' segments")
    .refine(
      (p) => p.split(/[\\/]/)[0]!.toLowerCase() !== ".checkpoint",
      "path must not be inside the workspace's .checkpoint folder",
    )
    .optional(),
  /** Nested links only: create the child for workspaces with no entry. */
  enabledByDefault: z.boolean().default(true),
});

// An artifact include or exclude pattern, in .chkignore syntax. A backslash
// there escapes the next character, so a Windows-style separator would
// silently match nothing.
const artifactPatternSchema = z
  .string()
  .min(1)
  .refine((p) => !p.includes("\\"), "use / in patterns, not \\");

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
        /** Linked repo name -> mode for workspaces that have not chosen one. */
        linkedRepos: z.record(z.string(), z.enum(LINK_MODES)).default({}),
      }),
    )
    .default([]),
  linkedRepos: z
    .array(linkedRepoSchema)
    .default([])
    .refine(
      (links) =>
        new Set(links.map((l) => l.repo.toLowerCase())).size === links.length,
      "each repo may only be linked once",
    )
    .superRefine((links, ctx) => {
      // Each mount folder belongs to one child; two children can't share
      // one, or sit one inside the other. Compared without case, as Windows
      // and macOS would.
      const folder = (p: string) =>
        p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const mounts = links
        .map((l, index) => ({ index, repo: l.repo, path: l.path }))
        .filter((m): m is { index: number; repo: string; path: string } =>
          m.path !== undefined,
        );
      for (const a of mounts) {
        for (const b of mounts) {
          if (a.index >= b.index) continue;
          const pa = folder(a.path);
          const pb = folder(b.path);
          if (pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [b.index, "path"],
              message: `${b.repo} and ${a.repo} are mounted at overlapping folders ("${b.path}" and "${a.path}")`,
            });
          }
        }
      }
    }),
  buildSteps: z
    .array(buildStepSchema)
    .default([])
    .superRefine((steps, ctx) => {
      // A step that requires a step limited to other OSes treats it as
      // satisfied wherever it is skipped. When the two never share an OS the
      // requirement can never mean anything, which is almost certainly a
      // mistake in the config. Ids not defined here (the Unreal default
      // steps) run everywhere, so they never trip this.
      const byId = new Map(steps.map((step) => [step.id, step]));
      steps.forEach((step, index) => {
        const mine = step.ifOs ?? HOST_OSES;
        for (const requiredId of step.requires) {
          const theirs = byId.get(requiredId)?.ifOs;
          if (!theirs) continue;
          if (!mine.some((os) => theirs.includes(os))) {
            ctx.addIssue({
              code: "custom",
              path: [index, "requires"],
              message: `step "${step.id}" (runs on ${mine.join(", ")}) requires "${requiredId}", which only runs on ${theirs.join(", ")}`,
            });
          }
        }
      });
    }),
  artifacts: z
    .array(
      z.object({
        type: idSchema,
        name: z.string().optional(),
        requiredBadges: z.array(z.string().min(1)).default([]),
        // The files an upload of this type collects, as .chkignore-style
        // patterns: everything matching `include` and not `exclude`.
        include: z.array(artifactPatternSchema).default([]),
        exclude: z.array(artifactPatternSchema).default([]),
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
