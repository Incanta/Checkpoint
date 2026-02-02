import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import type { Changelist } from "@prisma/client";

export const changelistRouter = createTRPCRouter({
  getChangelist: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      // Check repo access (similar to other routers)
      // ... access check logic ...

      return ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: input.changelistNumber,
          },
        },
      });
    }),

  getChangelistsWithNumbers: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        numbers: z.array(z.number()),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      // Check repo access (similar to other routers)
      // ... access check logic ...

      return await ctx.db.changelist.findMany({
        where: {
          repoId: input.repoId,
          number: {
            in: input.numbers,
          },
        },
      });
    }),

  getChangelists: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        branchName: z.string(),
        start: z.object({
          number: z.number().nullable(),
          timestamp: z.date().nullable(),
        }),
        count: z.number().min(1).max(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      // Check repo access (similar to other routers)
      // ... access check logic ...

      let startNumber: number | Date | null = null;

      if (input.start.number === null && input.start.timestamp === null) {
        // our starting place is the headNumber for the branch
        const branch = await ctx.db.branch.findUnique({
          where: {
            repoId_name: {
              repoId: input.repoId,
              name: input.branchName,
            },
          },
        });

        if (!branch) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Could not find branch ${input.branchName} in the repo`,
          });
        }

        startNumber = branch.headNumber;
      } else if (
        input.start.number !== null &&
        input.start.timestamp === null
      ) {
        startNumber = input.start.number;
      } else {
        startNumber = input.start.timestamp;
      }

      if (startNumber === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No valid start number found to retrieve changelists",
        });
      }

      let startChangelist: Changelist | null = null;
      if (typeof startNumber === "object") {
        // must be a date; find the first changelist less than this date
        startChangelist = await ctx.db.changelist.findFirst({
          where: {
            repoId: input.repoId,
            createdAt: {
              lte: startNumber,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
        });
      } else {
        startChangelist = await ctx.db.changelist.findUnique({
          where: {
            repoId_number: {
              repoId: input.repoId,
              number: startNumber,
            },
          },
        });
      }

      if (!startChangelist) {
        // this probably shouldn't happen
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Could not find a start number to retrieve changelists from",
        });
      }

      // TODO MIKE HERE now we need to find the recursive parents; let's be dumb about it for now
      const changelists = [startChangelist];
      while (changelists.length < input.count) {
        const lastChangelist = changelists.at(-1)!;

        if (lastChangelist.parentNumber === null) {
          break;
        }

        const parentChangelist = await ctx.db.changelist.findUnique({
          where: {
            repoId_number: {
              repoId: input.repoId,
              number: lastChangelist.parentNumber,
            },
          },
        });

        if (!parentChangelist) {
          // TODO MIKE HERE: should log this invalid parent number
          break;
        }

        changelists.push(parentChangelist);
      }

      return changelists;
    }),

  createChangelist: protectedProcedure
    .input(
      z.object({
        message: z.string(),
        repoId: z.string(),
        versionIndex: z.string(),
        branchName: z.string(),
        modifications: z.array(
          z.object({
            delete: z.boolean(),
            path: z.string(),
            oldPath: z.string().optional(),
          }),
        ),
        keepCheckedOut: z.boolean(),
        workspaceId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      // Check write permissions to repo
      // ... permission check logic ...

      // Get the next changelist number
      const lastChangelist = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: "desc" },
      });

      const nextNumber = (lastChangelist?.number ?? -1) + 1;

      const branch = await ctx.db.branch.findFirst({
        where: {
          repoId: input.repoId,
          name: input.branchName,
        },
      });

      if (!branch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Branch ${input.branchName} not found in the repo`,
        });
      }

      const parentChangelist = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: branch.headNumber,
          },
        },
      });

      if (!parentChangelist) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Parent changelist ${branch.headNumber} not found in the repo`,
        });
      }

      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
      const stateTree: Record<string, number> =
        parentChangelist.stateTree as any;
      /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */

      // Apply modifications to state tree
      const modifiedFiles = await ctx.db.file.findMany({
        where: {
          repoId: input.repoId,
          path: {
            in: input.modifications.map((mod) =>
              mod.path.replaceAll("\\", "/"),
            ),
          },
        },
      });

      for (const mod of input.modifications) {
        const modPath = mod.path.replaceAll("\\", "/");
        let existingFile = modifiedFiles.find((f) => f.path === modPath);

        if (!existingFile && !mod.delete) {
          // Create new file entry
          existingFile = await ctx.db.file.create({
            data: {
              repoId: input.repoId,
              path: modPath,
            },
          });
        }

        if (mod.delete) {
          if (existingFile) {
            delete stateTree[existingFile.id];
          }
        } else {
          stateTree[existingFile!.id] = nextNumber;
        }
      }

      // Create the changelist
      const changelist = await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: input.message,
          versionIndex: input.versionIndex,
          parentNumber: branch.headNumber,
          stateTree: stateTree,
          repoId: input.repoId,
          userId: checkpointUser.id,
        },
      });

      await ctx.db.branch.update({
        where: { id: branch.id },
        data: { headNumber: nextNumber },
      });

      // TODO: Handle file changes and workspace checkout logic
      // For now, just return the basic changelist info

      return {
        id: changelist.id,
        number: changelist.number,
      };
    }),
});
