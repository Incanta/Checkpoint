import { publicProcedure, router } from "../trpc.js";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { JobManager } from "../../job-manager.js";

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

      return {
        id: job.id,
        type: job.type,
        status: job.status,
        steps: job.steps,
        currentStep: job.currentStep,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    }),
});
