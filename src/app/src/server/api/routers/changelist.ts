import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { ClaimStrength, FileChangeType, RepoAccess } from "@prisma/client";
import {
  assertWorkspaceOwnership,
  getUserAndRepoWithAccess,
} from "../auth-utils";
import { recordActivity } from "../activity";
import {
  diffStateTrees,
  lookupStateTreePaths,
  stateRootOf,
  submitStateTree,
} from "~/server/state-tree";
import { TreeCollisionError, type TreeEdit } from "~/server/tree/tree";
import {
  canonicalProblems,
  describePathProblems,
  portabilityProblems,
  toRepoPath,
} from "~/server/repo-path";
import type { InputJsonValue } from "@prisma/client/runtime/library";
import { walkChangelistAncestry } from "~/server/changelist-walk";
import { compareTreePaths } from "~/lib/file-tree-sort";
import { classifyPaths } from "~/server/team-sync/classify";
import { settleClaimsForSubmit } from "~/server/claims/claims";
import { resolveDomainBranchName } from "~/server/claims/domain";
import {
  MAX_SUBMIT_ATTEMPTS,
  SubmitContention,
  describeBaseConflicts,
  findBaseConflicts,
  isSubmitContention,
} from "~/server/changelist-commit";

export const changelistRouter = createTRPCRouter({
  // Path-keyed diff between two changelists' state trees. The daemon's sync
  // path: returns only changed paths + the source CLs to pull (no full map).
  diffChangelists: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        fromNumber: z.number(),
        toNumber: z.number(),
        // Resolve fileIds for added paths. The pull path needs them; the
        // sync-status path does not (and on a fresh full sync that set is the
        // whole repo, so resolving it dominates the cost). Defaults to true.
        resolveAddedFileIds: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);
      return diffStateTrees(
        ctx.db,
        input.repoId,
        input.fromNumber,
        input.toNumber,
        { resolveAddedFileIds: input.resolveAddedFileIds },
      );
    }),

  getChangelist: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      return ctx.db.changelist.findUnique({
        where: {
          repoId_number: {
            repoId: input.repoId,
            number: input.changelistNumber,
          },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              username: true,
            },
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
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      return await ctx.db.changelist.findMany({
        where: {
          repoId: input.repoId,
          number: {
            in: input.numbers,
          },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              username: true,
            },
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
        count: z.number().min(1).max(250),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

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

      let resolvedStartNumber: number;
      if (typeof startNumber === "object") {
        // must be a date; find the first changelist at or before this date
        const startByDate = await ctx.db.changelist.findFirst({
          where: {
            repoId: input.repoId,
            createdAt: {
              lte: startNumber,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          select: {
            number: true,
          },
        });

        if (!startByDate) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message:
              "Could not find a start number to retrieve changelists from",
          });
        }

        resolvedStartNumber = startByDate.number;
      } else {
        resolvedStartNumber = startNumber;
      }

      const { numbers } = await walkChangelistAncestry(
        ctx.db,
        input.repoId,
        resolvedStartNumber,
        input.count,
      );

      if (numbers.length === 0) {
        // the start changelist itself doesn't exist
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Could not find a start number to retrieve changelists from",
        });
      }

      const changelists = await ctx.db.changelist.findMany({
        where: {
          repoId: input.repoId,
          number: {
            in: numbers,
          },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              username: true,
            },
          },
        },
      });

      // findMany does not preserve order; restore newest-first walk order
      const byNumber = new Map(changelists.map((cl) => [cl.number, cl]));
      return numbers
        .map((number) => byNumber.get(number))
        .filter((cl) => cl !== undefined);
    }),

  // What pulling a set of changelists would put on disk that the target
  // changelist's state does not want there.
  //
  // A pull applies the version index of every changelist that is the source
  // of some changed path, and an index holds everything its changelist
  // touched, not only the paths the pull is after. So an index can write:
  //
  //   - a "stray": a path the target state does not contain at all (added in
  //     one changelist, deleted in a later one);
  //   - a "stale" write: a path whose version in the target state comes from
  //     a different changelist than the last one in the set to write it.
  //
  // Neither shows up in the diff the daemon pulls from. It asks for them up
  // front so it can protect local files at those paths, and removes or
  // restores them afterwards. A mutation only because the list of numbers can
  // be long.
  getPullAnomalies: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        /** The changelist the workspace is being brought to. */
        toNumber: z.number(),
        /** The changelists whose version indexes will be applied. */
        numbers: z.array(z.number()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const stray: string[] = [];
      const stale: { path: string; cl: number }[] = [];
      if (input.numbers.length === 0) {
        return { stray, stale, written: [] as string[] };
      }

      // The last changelist in the set to write each path. Indexes are
      // applied in ascending order, so that is what ends up on disk.
      const lastWriter = new Map<string, number>();
      const BATCH_SIZE = 500;
      for (let i = 0; i < input.numbers.length; i += BATCH_SIZE) {
        const rows = await ctx.db.fileChange.findMany({
          where: {
            repoId: input.repoId,
            changelistNumber: { in: input.numbers.slice(i, i + BATCH_SIZE) },
            type: { not: FileChangeType.DELETE },
          },
          select: {
            changelistNumber: true,
            file: { select: { path: true } },
          },
        });
        for (const row of rows) {
          const previous = lastWriter.get(row.file.path);
          if (previous === undefined || row.changelistNumber > previous) {
            lastWriter.set(row.file.path, row.changelistNumber);
          }
        }
      }

      // Only the paths the indexes write matter, so read just those from the
      // target's tree rather than its whole path map.
      const target = await lookupStateTreePaths(
        ctx.db,
        input.repoId,
        await stateRootOf(ctx.db, input.repoId, input.toNumber),
        lastWriter.keys(),
      );
      for (const [path, writer] of lastWriter) {
        const expected = target.get(path);
        if (expected === undefined) {
          stray.push(path);
        } else if (expected !== writer) {
          stale.push({ path, cl: expected });
        }
      }

      stray.sort();
      stale.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      // Every path the indexes write, including the ones they write
      // correctly: a file the workspace already has at that changelist may
      // still hold local edits the write would replace.
      const written = [...lastWriter.keys()].sort();
      return { stray, stale, written };
    }),

  getChangelistFiles: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      const fileChanges = await ctx.db.fileChange.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: input.changelistNumber,
        },
        include: {
          file: {
            select: {
              id: true,
              path: true,
            },
          },
        },
      });

      // Sorted here rather than by the database: a plain path sort interleaves
      // a directory's own files with its subdirectories.
      return fileChanges
        .map((fc) => ({
          id: fc.id,
          fileId: fc.file.id,
          path: fc.file.path,
          changeType: fc.type,
          oldPath: fc.oldPath,
        }))
        .sort((a, b) => compareTreePaths(a.path, b.path));
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
            // The changelist the submitter's copy of the file came from, or
            // null for a file it believes is new to the branch. See
            // findBaseConflicts.
            baseChangelist: z.number().int().nonnegative().nullish(),
          }),
        ),
        keepCheckedOut: z.boolean(),
        workspaceId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.repoId,
        RepoAccess.WRITE,
      );
      await assertWorkspaceOwnership(ctx, input.workspaceId);

      // Every lookup below (claims, File rows, the tree, the base check) keys
      // on one canonical spelling, and nothing stored can climb out of a
      // workspace or into its .checkpoint directory.
      const pathProblems = canonicalProblems(input.modifications);
      if (pathProblems.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: describePathProblems(pathProblems),
        });
      }
      if (
        input.versionIndex === "" &&
        input.modifications.some((mod) => !mod.delete)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A changelist that writes files must name the version index holding them",
        });
      }

      const normalizedPaths = input.modifications.map((mod) =>
        toRepoPath(mod.path),
      );

      const submitBranch = await ctx.db.branch.findFirst({
        where: {
          repoId: input.repoId,
          name: input.branchName,
        },
      });

      if (!submitBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Branch ${input.branchName} not found in the repo`,
        });
      }

      if (submitBranch.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Branch ${input.branchName} is archived and read-only`,
        });
      }

      // Resolve the claim domain this submit lands in. Claims anchored at
      // other domains (a release branch, another mainline) are irrelevant here
      // by design.
      const submitDomainBranchName = await resolveDomainBranchName(
        ctx.db,
        input.repoId,
        submitBranch,
      );

      const BATCH_SIZE = 20000;

      // Exclusion guard. The predicate spells out both index columns so the
      // planner uses the partial unique index and never scans advisory rows.
      // Holding the claim is the requirement: reclaiming is how another
      // workspace takes one over, which collapses the "started on main then
      // branched", collaborator, and cross-branch cases into one check.
      const blockingClaims: {
        file: { path: string };
        branchName: string;
        workspace: {
          user: { email: string; name: string | null; username: string | null };
        };
      }[] = [];

      for (let i = 0; i < normalizedPaths.length; i += BATCH_SIZE) {
        const batch = normalizedPaths.slice(i, i + BATCH_SIZE);
        const results = await ctx.db.fileClaim.findMany({
          where: {
            repoId: input.repoId,
            domainBranchName: submitDomainBranchName,
            releasedAt: null,
            strength: ClaimStrength.EXCLUSIVE,
            workspaceId: { not: input.workspaceId },
            file: {
              path: { in: batch },
            },
          },
          include: {
            file: true,
            workspace: {
              include: {
                user: {
                  select: { email: true, name: true, username: true },
                },
              },
            },
          },
        });
        for (const r of results) blockingClaims.push(r);
      }

      if (blockingClaims.length > 0) {
        const blocked = blockingClaims.map((c) => {
          const displayName =
            c.workspace.user.name ||
            c.workspace.user.username ||
            c.workspace.user.email;
          return `${c.file.path} (claimed on "${c.branchName}" by ${displayName})`;
        });
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Cannot submit: the following files are claimed by others in the "${submitDomainBranchName}" domain:\n${blocked.join("\n")}`,
        });
      }

      // Classify code vs content from the modified paths (already in memory)
      const { hasCodeChanges, hasContentChanges } =
        classifyPaths(normalizedPaths);

      // Everything from reading the head to committing is one attempt, and an
      // attempt that loses a race is thrown away and redone from the top.
      //
      // Two things can only be decided against the head the changelist will
      // actually sit on: the tree it produces, and whether the submitter's
      // files were based on what that head holds. So nothing is trusted across
      // attempts. The transaction then holds only the writes, and it has two
      // gates that turn "the world moved" into a clean failure of the whole
      // attempt: the unique (repoId, number) index, and a head update that
      // matches only if the head is still the one this attempt read.
      let committed: {
        id: string;
        number: number;
        stateRootHash: string;
      } | null = null;

      for (
        let attempt = 0;
        attempt < MAX_SUBMIT_ATTEMPTS && !committed;
        attempt++
      ) {
        if (attempt > 0) {
          // Spread retries out so the same submits do not collide again.
          await new Promise((resolve) =>
            setTimeout(resolve, 15 * attempt + Math.random() * 60),
          );
        }

        const branch = await ctx.db.branch.findUnique({
          where: { id: submitBranch.id },
        });

        if (!branch) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Branch ${input.branchName} not found in the repo`,
          });
        }

        if (branch.archivedAt) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Branch ${input.branchName} is archived and read-only`,
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

        // What the head holds at the submitted paths: read from the tree
        // along just those paths, not the whole path map.
        const headRoot = parentChangelist.stateRootHash ?? null;
        const headPaths = await lookupStateTreePaths(
          ctx.db,
          input.repoId,
          headRoot,
          normalizedPaths,
        );

        if (repo.pathPortability) {
          const unportable = portabilityProblems(input.modifications, (p) =>
            headPaths.has(p),
          );
          if (unportable.length > 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: describePathProblems(unportable),
            });
          }
        }

        const conflicts = findBaseConflicts(input.modifications, headPaths);
        if (conflicts.length > 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: describeBaseConflicts(input.branchName, conflicts),
          });
        }

        // Get the next changelist number. Another submit to this repo may take
        // it first; the unique index decides, inside the transaction.
        const lastChangelist = await ctx.db.changelist.findFirst({
          where: { repoId: input.repoId },
          orderBy: { number: "desc" },
          select: { number: true },
        });

        const nextNumber = (lastChangelist?.number ?? -1) + 1;

        const edits: TreeEdit[] = input.modifications.map((mod) => {
          const path = mod.path.replaceAll("\\", "/");
          return mod.delete
            ? { path, delete: true as const }
            : { path, cl: nextNumber };
        });

        // The new file count follows from the parent's: the paths this submit
        // adds that the head lacks, less the ones it deletes that the head
        // has. Later modifications of the same path win, as in the tree.
        const finalOp = new Map<string, boolean>();
        for (const e of edits) finalOp.set(e.path, !e.delete);
        let fileCount = parentChangelist.fileCount;
        if (fileCount !== null) {
          for (const [path, present] of finalOp) {
            const atHead = headPaths.has(path);
            if (present && !atHead) fileCount++;
            if (!present && atHead) fileCount--;
          }
        }

        // Update the content-addressed state tree along the edited paths and
        // store the new blocks. Blocks are keyed by their content, so one
        // written by an attempt that is later thrown away is harmless.
        // This writes too, outside the transaction, so on a database with a
        // single writer it can lose the wait to another submit's commit. That
        // is the same contention as losing the race inside the transaction.
        let stateRootHash: string;
        try {
          stateRootHash = await submitStateTree(
            ctx.db,
            input.repoId,
            branch.headNumber,
            headRoot,
            edits,
          );
        } catch (error) {
          if (error instanceof TreeCollisionError) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: error.message,
            });
          }
          if (!isSubmitContention(error)) {
            throw error;
          }
          continue;
        }

        try {
          const created = await ctx.db.$transaction(
            async (tx) => {
              // Create the changelist (inherit artifact state from parent)
              const changelist = await tx.changelist.create({
                data: {
                  number: nextNumber,
                  message: input.message,
                  versionIndex: input.versionIndex,
                  parentNumber: branch.headNumber,
                  stateRootHash,
                  fileCount,
                  artifactVersionIndex: parentChangelist.artifactVersionIndex,
                  artifactStateTree:
                    parentChangelist.artifactStateTree as InputJsonValue,
                  repoId: input.repoId,
                  userId: ctx.session.user.id,
                  hasCodeChanges,
                  hasContentChanges,
                },
              });

              // Move the head only if it is still where this attempt found it.
              // An unconditional update here is how a changelist gets dropped
              // from its branch: a second submit that read the same head would
              // overwrite the first one's update with its own.
              const moved = await tx.branch.updateMany({
                where: {
                  id: branch.id,
                  headNumber: branch.headNumber,
                  archivedAt: null,
                },
                data: { headNumber: nextNumber },
              });
              if (moved.count !== 1) {
                throw new SubmitContention(
                  `the head of ${input.branchName} moved`,
                );
              }

              // Resolve / create File rows for the modified paths (for the
              // FileChange log and the fileId wire shim). Batched to avoid DB
              // parameter limits. Inside the transaction, after the changelist
              // insert, so two submits adding the same new path cannot both
              // create a row for it: only one of them gets this far.
              const modifiedFiles: Awaited<
                ReturnType<typeof tx.file.findMany>
              > = [];
              for (let i = 0; i < normalizedPaths.length; i += BATCH_SIZE) {
                const batch = normalizedPaths.slice(i, i + BATCH_SIZE);
                const results = await tx.file.findMany({
                  where: {
                    repoId: input.repoId,
                    path: { in: batch },
                  },
                });
                for (const r of results) modifiedFiles.push(r);
              }

              // Batch-create any new file entries that don't already exist
              const existingPathSet = new Set(modifiedFiles.map((f) => f.path));
              const newFilePaths = [
                ...new Set(
                  input.modifications
                    .filter((mod) => !mod.delete)
                    .map((mod) => mod.path.replaceAll("\\", "/"))
                    .filter((p) => !existingPathSet.has(p)),
                ),
              ];

              if (newFilePaths.length > 0) {
                for (let i = 0; i < newFilePaths.length; i += BATCH_SIZE) {
                  const batch = newFilePaths.slice(i, i + BATCH_SIZE);
                  await tx.file.createMany({
                    data: batch.map((path) => ({
                      repoId: input.repoId,
                      path,
                    })),
                  });
                }

                // Re-fetch to get the newly created file records with their IDs
                for (let i = 0; i < newFilePaths.length; i += BATCH_SIZE) {
                  const batch = newFilePaths.slice(i, i + BATCH_SIZE);
                  const newFiles = await tx.file.findMany({
                    where: {
                      repoId: input.repoId,
                      path: { in: batch },
                    },
                  });
                  for (const f of newFiles) modifiedFiles.push(f);
                }
              }

              // Build a path→file map for O(1) lookups and record fileIds for
              // the log.
              const filesByPath = new Map(
                modifiedFiles.map((f) => [f.path, f]),
              );
              const fileIdsForPaths: Record<string, string | undefined> = {};
              for (const mod of input.modifications) {
                const modPath = mod.path.replaceAll("\\", "/");
                fileIdsForPaths[mod.path] = filesByPath.get(modPath)?.id;
              }

              await tx.fileChange.createMany({
                data: input.modifications
                  .filter((mod) => fileIdsForPaths[mod.path])
                  .map((mod) => {
                    return {
                      repoId: input.repoId,
                      fileId: fileIdsForPaths[mod.path]!,
                      changelistNumber: nextNumber,
                      type: mod.delete
                        ? FileChangeType.DELETE
                        : FileChangeType.MODIFY,
                      oldPath: mod.oldPath
                        ? mod.oldPath.replaceAll("\\", "/")
                        : null,
                    };
                  }),
              });

              // Settle claims for everything this changelist carried.
              //
              // Submitting to the domain root closes the gap between "the
              // change exists somewhere" and "the change reached the root" in
              // this same transaction, so those claims release outright.
              // Submitting to a feature branch parks them as SUBMITTED: still
              // blocking the domain, but reclaimable by anyone on that branch
              // or below it.
              //
              // Paths that were never checked out get a claim created here, at
              // the strength the org's binary-extension set resolves to. This
              // is the only claim-creation point that can fail a submit,
              // because the claim is taken after the work rather than before
              // it. When it does fail, the changelist goes with it.
              await settleClaimsForSubmit(tx, {
                repoId: input.repoId,
                branchName: input.branchName,
                domainBranchName: submitDomainBranchName,
                targetIsDomainRoot: submitDomainBranchName === input.branchName,
                changelistNumber: nextNumber,
                fileIdsForPaths,
                orgBinaryExtensions: repo.org.binaryExtensions,
                keepCheckedOut: input.keepCheckedOut,
                actor: {
                  userId: ctx.session.user.id,
                  workspaceId: input.workspaceId,
                },
              });

              return { id: changelist.id, number: changelist.number };
            },
            // A large submit writes hundreds of thousands of rows; the default
            // five seconds would abort it.
            { maxWait: 60_000, timeout: 15 * 60_000 },
          );

          committed = { ...created, stateRootHash };
        } catch (error) {
          if (!isSubmitContention(error)) {
            throw error;
          }
        }
      }

      if (!committed) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Could not submit to ${input.branchName}: other submits kept landing first. Nothing was changed; submit again.`,
        });
      }

      const changelist = committed;

      // Record write activity for billing (fire-and-forget)
      void recordActivity(ctx.db, {
        userId: ctx.session.user.id,
        orgId: repo.orgId,
        type: "write",
      });

      return {
        id: changelist.id,
        number: changelist.number,
      };
    }),

  getFilePathsChangedBetween: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        /** The older CL number (exclusive: changes IN this CL are NOT included). */
        fromNumber: z.number(),
        /** The newer CL number (inclusive: we start here and walk back). */
        toNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.READ);

      // Walk the parent chain from toNumber back to (but not including) fromNumber
      // and collect all distinct file paths that were changed.
      const clNumbers: number[] = [];
      let currentNumber: number | null = input.toNumber;

      while (currentNumber !== null && currentNumber !== input.fromNumber) {
        clNumbers.push(currentNumber);

        const cl: { parentNumber: number | null } | null =
          await ctx.db.changelist.findUnique({
            where: {
              repoId_number: {
                repoId: input.repoId,
                number: currentNumber,
              },
            },
            select: { parentNumber: true },
          });

        if (!cl) break;
        currentNumber = cl.parentNumber;
      }

      if (clNumbers.length === 0) {
        return { paths: [] };
      }

      // Single query to get all file changes across the collected CLs
      const fileChanges = await ctx.db.fileChange.findMany({
        where: {
          repoId: input.repoId,
          changelistNumber: { in: clNumbers },
        },
        include: {
          file: {
            select: { path: true },
          },
        },
      });

      // De-duplicate paths
      const paths = [...new Set(fileChanges.map((fc) => fc.file.path))];

      return { paths };
    }),
});
