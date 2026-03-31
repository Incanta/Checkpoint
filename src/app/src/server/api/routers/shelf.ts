import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const shelfRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]).optional(),
        authorId: z.string().optional(),
      }),
    )
    .output(
      z.array(
        z.object({
          id: z.string(),
          createdAt: z.date(),
          updatedAt: z.date(),
          name: z.string(),
          description: z.string(),
          repoId: z.string(),
          authorId: z.string(),
          versionIndex: z.string(),
          stateTree: z.any(),
          changelistNumber: z.int(),
          status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]),
          submittedToBranch: z.string().nullable(),
          submittedAt: z.date().nullable(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  get: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string(),
      }),
    )
    .output(
      z.object({
        id: z.string(),
        createdAt: z.date(),
        updatedAt: z.date(),
        name: z.string(),
        description: z.string(),
        repoId: z.string(),
        authorId: z.string(),
        versionIndex: z.string(),
        stateTree: z.any(),
        changelistNumber: z.int(),
        status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]),
        submittedToBranch: z.string().nullable(),
        submittedAt: z.date().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  create: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string().min(1).max(100),
        description: z.string().default(""),
        versionIndex: z.string(),
        modifications: z.array(
          z.object({
            path: z.string(),
            delete: z.boolean().default(false),
          }),
        ),
      }),
    )
    .output(
      z.object({
        id: z.string(),
        createdAt: z.date(),
        updatedAt: z.date(),
        name: z.string(),
        description: z.string(),
        repoId: z.string(),
        authorId: z.string(),
        versionIndex: z.string(),
        stateTree: z.any(),
        changelistNumber: z.int(),
        status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]),
        submittedToBranch: z.string().nullable(),
        submittedAt: z.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  addFiles: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        versionIndex: z.string(),
        modifications: z.array(
          z.object({
            path: z.string(),
          }),
        ),
      }),
    )
    .output(
      z.object({
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  removeFiles: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        versionIndex: z.string(),
        filePaths: z.array(z.string()),
      }),
    )
    .output(
      z.object({
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  submitToBranch: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        branchName: z.string(),
        message: z.string().optional(),
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
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  // Called by the backend server during submit when shelfName is present.
  // Creates a dangling CL and shelf record (or updates existing shelf).
  createFromSubmit: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        description: z.string().default(""),
        versionIndex: z.string(),
        message: z.string(),
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
        shelfName: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  delete: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
      }),
    )
    .output(
      z.object({
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  rename: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        newName: z.string().min(1).max(100),
      }),
    )
    .output(
      z.object({
        id: z.string(),
        createdAt: z.date(),
        updatedAt: z.date(),
        name: z.string(),
        description: z.string(),
        repoId: z.string(),
        authorId: z.string(),
        versionIndex: z.string(),
        stateTree: z.any(),
        changelistNumber: z.int(),
        status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]),
        submittedToBranch: z.string().nullable(),
        submittedAt: z.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),

  getFileContent: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        shelfName: z.string(),
        filePath: z.string(),
      }),
    )
    .output(
      z.object({
        content: z.string().nullable(),
        isBinary: z.boolean(),
        size: z.number(),
        tooLarge: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Shelves are a Pro feature and are included in the closed-source distribution.",
      });
    }),
});
