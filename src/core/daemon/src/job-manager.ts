import { randomUUID } from "crypto";

export type JobType = "submit" | "pull";
export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface JobProgress {
  done: number;
  total: number;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  steps: string[];
  currentStep: string | null;
  progress: JobProgress | null;
  stepStartedAt: Date | null;
  result: unknown | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class JobManager {
  private static instance: JobManager | null = null;
  private jobs = new Map<string, Job>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  static Get(): JobManager {
    if (!JobManager.instance) {
      JobManager.instance = new JobManager();
    }
    return JobManager.instance;
  }

  createJob(type: JobType): Job {
    const job: Job = {
      id: randomUUID(),
      type,
      status: "pending",
      steps: [],
      currentStep: null,
      progress: null,
      stepStartedAt: null,
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  updateStep(jobId: string, step: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "running";
    job.currentStep = step;
    job.steps.push(step);
    job.progress = null;
    job.stepStartedAt = new Date();
    job.updatedAt = new Date();
  }

  updateProgress(jobId: string, done: number, total: number): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.progress = { done, total };
    job.updatedAt = new Date();
  }

  completeJob(jobId: string, result: unknown = null): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "completed";
    job.result = result;
    job.updatedAt = new Date();
  }

  failJob(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "failed";
    job.error = error;
    job.updatedAt = new Date();
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (
        (job.status === "completed" || job.status === "failed") &&
        now - job.updatedAt.getTime() > JOB_TTL_MS
      ) {
        this.jobs.delete(id);
      }
    }
  }
}
