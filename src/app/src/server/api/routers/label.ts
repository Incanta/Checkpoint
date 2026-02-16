import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const labelRouter = createTRPCRouter({
  getLabels: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      // Check repo access
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
        include: { org: true },
      });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      if (!repo.public) {
        const orgUser = await ctx.db.orgUser.findFirst({
          where: { orgId: repo.orgId, userId: checkpointUser.id },
        });

        if (!orgUser) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You do not have access to this repository",
          });
        }

        if (repo.org.defaultRepoAccess === "NONE") {
          const repoRole = await ctx.db.repoRole.findFirst({
            where: { repoId: repo.id, userId: checkpointUser.id },
          });

          if (!repoRole || repoRole.access === "NONE") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "You do not have access to this repository",
            });
          }
        }
      }

      return ctx.db.changelistLabel.findMany({
        where: { repoId: input.repoId },
        include: {
          changelist: {
            select: {
              number: true,
              message: true,
              createdAt: true,
              user: {
                select: { email: true, name: true },
              },
            },
          },
        },
        orderBy: { number: "desc" },
      });
    }),

  deleteLabel: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        repoId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      // Check repo access
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
        include: { org: true },
      });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      if (!repo.public) {
        const orgUser = await ctx.db.orgUser.findFirst({
          where: { orgId: repo.orgId, userId: checkpointUser.id },
        });

        if (!orgUser) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You do not have access to this repository",
          });
        }

        if (repo.org.defaultRepoAccess === "NONE") {
          const repoRole = await ctx.db.repoRole.findFirst({
            where: { repoId: repo.id, userId: checkpointUser.id },
          });

          if (!repoRole || repoRole.access === "NONE") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "You do not have access to this repository",
            });
          }
        }
      }

      const label = await ctx.db.changelistLabel.findUnique({
        where: { id: input.id },
      });

      if (!label || label.repoId !== input.repoId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Label not found",
        });
      }

      return ctx.db.changelistLabel.delete({
        where: { id: input.id },
      });
    }),

  renameLabel: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        repoId: z.string(),
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      // Check repo access
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
        include: { org: true },
      });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      if (!repo.public) {
        const orgUser = await ctx.db.orgUser.findFirst({
          where: { orgId: repo.orgId, userId: checkpointUser.id },
        });

        if (!orgUser) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You do not have access to this repository",
          });
        }

        if (repo.org.defaultRepoAccess === "NONE") {
          const repoRole = await ctx.db.repoRole.findFirst({
            where: { repoId: repo.id, userId: checkpointUser.id },
          });

          if (!repoRole || repoRole.access === "NONE") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "You do not have access to this repository",
            });
          }
        }
      }

      const label = await ctx.db.changelistLabel.findUnique({
        where: { id: input.id },
      });

      if (!label || label.repoId !== input.repoId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Label not found",
        });
      }

      // Check for name uniqueness within the repo
      const existing = await ctx.db.changelistLabel.findUnique({
        where: {
          repoId_name: {
            repoId: input.repoId,
            name: input.name,
          },
        },
      });

      if (existing && existing.id !== input.id) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `A label with the name "${input.name}" already exists in this repository`,
        });
      }

      return ctx.db.changelistLabel.update({
        where: { id: input.id },
        data: { name: input.name },
      });
    }),

  changeChangelist: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        repoId: z.string(),
        number: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      // Check repo access
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
        include: { org: true },
      });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      if (!repo.public) {
        const orgUser = await ctx.db.orgUser.findFirst({
          where: { orgId: repo.orgId, userId: checkpointUser.id },
        });

        if (!orgUser) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You do not have access to this repository",
          });
        }

        if (repo.org.defaultRepoAccess === "NONE") {
          const repoRole = await ctx.db.repoRole.findFirst({
            where: { repoId: repo.id, userId: checkpointUser.id },
          });

          if (!repoRole || repoRole.access === "NONE") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "You do not have access to this repository",
            });
          }
        }
      }

      const label = await ctx.db.changelistLabel.findUnique({
        where: { id: input.id },
      });

      if (!label || label.repoId !== input.repoId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Label not found",
        });
      }

      // Verify the target changelist exists
      const changelist = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: input.number,
          },
        },
      });

      if (!changelist) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Changelist #${input.number} does not exist in this repository`,
        });
      }

      return ctx.db.changelistLabel.update({
        where: { id: input.id },
        data: { number: input.number },
      });
    }),

  createLabel: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        name: z.string().min(1),
        number: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      // Check repo access
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
        include: { org: true },
      });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      if (!repo.public) {
        const orgUser = await ctx.db.orgUser.findFirst({
          where: { orgId: repo.orgId, userId: checkpointUser.id },
        });

        if (!orgUser) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You do not have access to this repository",
          });
        }

        if (repo.org.defaultRepoAccess === "NONE") {
          const repoRole = await ctx.db.repoRole.findFirst({
            where: { repoId: repo.id, userId: checkpointUser.id },
          });

          if (!repoRole || repoRole.access === "NONE") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "You do not have access to this repository",
            });
          }
        }
      }

      // Verify the target changelist exists
      const changelist = await ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: input.number,
          },
        },
      });

      if (!changelist) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Changelist #${input.number} does not exist in this repository`,
        });
      }

      // Check for name uniqueness within the repo
      const existing = await ctx.db.changelistLabel.findUnique({
        where: {
          repoId_name: {
            repoId: input.repoId,
            name: input.name,
          },
        },
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `A label with the name "${input.name}" already exists in this repository`,
        });
      }

      return ctx.db.changelistLabel.create({
        data: {
          name: input.name,
          repoId: input.repoId,
          number: input.number,
        },
      });
    }),
});
