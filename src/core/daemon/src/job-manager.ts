import { randomUUID } from "crypto";

export type JobType =
  | "submit"
  | "pull"
  | "clean"
  | "artifact-upload"
  | "build"
  | "generate-project-files"
  | "artifact-apply"
  | "clean-preview"
  | "scheduled-sync";
export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobProgress {
  done: number;
  total: number;
}

export interface JobLogLine {
  seq: number;
  ts: number;
  stream: "out" | "err" | "sys";
  line: string;
}

export type JobStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface JobStepState {
  id: string;
  description: string;
  status: JobStepStatus;
  exitCode?: number;
  durationMs?: number;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  /** Workspace this job runs against, when applicable (enables reattach). */
  workspaceId: string | null;
  steps: string[];
  currentStep: string | null;
  progress: JobProgress | null;
  stepStartedAt: Date | null;
  /** Structured step-level state for build-style jobs. */
  stepStates: JobStepState[] | null;
  /** Ring buffer of recent log lines; full logs may be written to a file. */
  logs: JobLogLine[];
  logSeq: number;
  /** Path to the full log file on disk, when one is written. */
  logFilePath: string | null;
  cancelRequested: boolean;
  result: unknown | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOG_RING_BUFFER_MAX = 4000;

export class JobManager {
  private static instance: JobManager | null = null;
  private jobs = new Map<string, Job>();
  private cancelCallbacks = new Map<string, () => void>();
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

  createJob(type: JobType, workspaceId: string | null = null): Job {
    const job: Job = {
      id: randomUUID(),
      type,
      status: "pending",
      workspaceId,
      steps: [],
      currentStep: null,
      progress: null,
      stepStartedAt: null,
      stepStates: null,
      logs: [],
      logSeq: 0,
      logFilePath: null,
      cancelRequested: false,
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

  setStepStates(jobId: string, stepStates: JobStepState[]): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.stepStates = stepStates;
    job.updatedAt = new Date();
  }

  updateStepState(
    jobId: string,
    stepId: string,
    update: Partial<Omit<JobStepState, "id">>,
  ): void {
    const job = this.jobs.get(jobId);
    const stepState = job?.stepStates?.find((step) => step.id === stepId);
    if (!job || !stepState) return;
    Object.assign(stepState, update);
    job.updatedAt = new Date();
  }

  appendLog(
    jobId: string,
    stream: JobLogLine["stream"],
    line: string,
  ): number | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const seq = job.logSeq++;
    job.logs.push({ seq, ts: Date.now(), stream, line });
    if (job.logs.length > LOG_RING_BUFFER_MAX) {
      job.logs.splice(0, job.logs.length - LOG_RING_BUFFER_MAX);
    }
    job.updatedAt = new Date();
    return seq;
  }

  getLogs(
    jobId: string,
    afterSeq: number,
  ): { lines: JobLogLine[]; nextSeq: number; logFilePath: string | null } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { lines: [], nextSeq: afterSeq, logFilePath: null };
    }
    const lines = job.logs.filter((entry) => entry.seq > afterSeq);
    return {
      lines,
      nextSeq: lines.at(-1)?.seq ?? afterSeq,
      logFilePath: job.logFilePath,
    };
  }

  setLogFilePath(jobId: string, logFilePath: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.logFilePath = logFilePath;
  }

  /**
   * Register a callback invoked when cancellation is requested (e.g. to kill
   * the currently running child process). One callback per job.
   */
  onCancel(jobId: string, callback: () => void): void {
    this.cancelCallbacks.set(jobId, callback);
  }

  /**
   * Request cancellation of a running job. Returns false when the job is
   * unknown or already finished. The runner is responsible for observing
   * `cancelRequested` (or its onCancel callback) and calling cancelJob.
   */
  requestCancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status === "completed" || job.status === "failed") {
      return false;
    }
    job.cancelRequested = true;
    job.updatedAt = new Date();
    this.cancelCallbacks.get(jobId)?.();
    return true;
  }

  completeJob(jobId: string, result: unknown = null): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "completed";
    job.result = result;
    job.updatedAt = new Date();
    this.cancelCallbacks.delete(jobId);
  }

  failJob(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "failed";
    job.error = error;
    job.updatedAt = new Date();
    this.cancelCallbacks.delete(jobId);
  }

  cancelJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "cancelled";
    job.updatedAt = new Date();
    this.cancelCallbacks.delete(jobId);
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  listJobs(filter?: {
    workspaceId?: string;
    types?: JobType[];
    activeOnly?: boolean;
  }): Job[] {
    const jobs: Job[] = [];
    for (const job of this.jobs.values()) {
      if (filter?.workspaceId && job.workspaceId !== filter.workspaceId) {
        continue;
      }
      if (filter?.types && !filter.types.includes(job.type)) {
        continue;
      }
      if (
        filter?.activeOnly &&
        job.status !== "pending" &&
        job.status !== "running"
      ) {
        continue;
      }
      jobs.push(job);
    }
    return jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (
        (job.status === "completed" ||
          job.status === "failed" ||
          job.status === "cancelled") &&
        now - job.updatedAt.getTime() > JOB_TTL_MS
      ) {
        this.jobs.delete(id);
        this.cancelCallbacks.delete(id);
      }
    }
  }
}
