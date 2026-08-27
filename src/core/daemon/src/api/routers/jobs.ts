import { publicProcedure, router } from "../trpc.js";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { JobManager, type Job, type JobType } from "../../job-manager.js";

const JOB_TYPES = [
  "submit",
  "pull",
  "clean",
  "artifact-upload",
  "build",
  "generate-project-files",
  "artifact-apply",
  "clean-preview",
  "scheduled-sync",
] as const satisfies readonly JobType[];

function serializeJob(job: Job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    workspaceId: job.workspaceId,
    steps: job.steps,
    currentStep: job.currentStep,
    progress: job.progress,
    stepStartedAt: job.stepStartedAt,
    stepStates: job.stepStates,
    cancelRequested: job.cancelRequested,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export const jobsRouter = router({
  getStatus: publicProcedure
    .input(
      z.object({
        jobId: z.string(),
      }),
    )
    .query(({ input }) => {
      const job = JobManager.Get().getJob(input.jobId);

      if (!job) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Job ${input.jobId} not found`,
        });
      }

      return serializeJob(job);
    }),

  // List jobs, optionally scoped to a workspace and/or active ones. Lets a
  // restarted UI reattach to running builds and scheduled syncs.
  list: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().optional(),
        types: z.array(z.enum(JOB_TYPES)).optional(),
        activeOnly: z.boolean().optional(),
      }),
    )
    .query(({ input }) => {
      return JobManager.Get()
        .listJobs({
          workspaceId: input.workspaceId,
          types: input.types,
          activeOnly: input.activeOnly,
        })
        .map(serializeJob);
    }),

  // Cursor read of a job's log ring buffer; poll with the last seen seq.
  getLogs: publicProcedure
    .input(
      z.object({
        jobId: z.string(),
        afterSeq: z.number().int().min(-1).default(-1),
      }),
    )
    .query(({ input }) => {
      const job = JobManager.Get().getJob(input.jobId);

      if (!job) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Job ${input.jobId} not found`,
        });
      }

      return JobManager.Get().getLogs(input.jobId, input.afterSeq);
    }),

  cancel: publicProcedure
    .input(
      z.object({
        jobId: z.string(),
      }),
    )
    .mutation(({ input }) => {
      const requested = JobManager.Get().requestCancel(input.jobId);
      return { requested };
    }),
});
