import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const artifactRouter = createTRPCRouter({
  // Called by the backend server when CI uploads artifacts for an existing CL.
  // Merges new artifact files into the CL's artifactStateTree (additive overwrite).
  attachToChangelist: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
        versionIndex: z.string(),
        modifications: z.array(
          z.object({
            delete: z.boolean(),
            path: z.string(),
            oldPath: z.string().optional(),
          }),
        ),
      }),
    )
    .output(
      z.object({
        changelistNumber: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Artifacts are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  // List artifact files for a specific changelist
  list: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .output(
      z.array(
        z.object({
          id: z.string(),
          fileId: z.string(),
          path: z.string(),
          size: z.number(),
          createdAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Artifacts are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  // Batch query: which of the given CL numbers have artifacts?
  getForChangelists: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumbers: z.array(z.number()),
      }),
    )
    .output(z.array(z.number()))
    .query(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Artifacts are a Pro feature and are included in the closed-source distribution.",
      });
    }),
});
