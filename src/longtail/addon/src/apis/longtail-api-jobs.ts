import {
  IKoffiRegisteredCallback,
  decode,
  encode,
  register,
  sizeof,
  unregister,
} from "koffi";
import { LongtailApi } from "./longtail-api";
import { Longtail } from "../longtail";

export class JobGroup {
  public jobCount: number;

  constructor(jobCount: number) {
    this.jobCount = jobCount;
  }
}

export class LongtailApiJobs extends LongtailApi {
  public getWorkerCountHandle: IKoffiRegisteredCallback;
  public reserveJobsFuncHandle: IKoffiRegisteredCallback;
  public createJobsFuncHandle: IKoffiRegisteredCallback;
  public addDependenciesFuncHandle: IKoffiRegisteredCallback;
  public readyJobsFuncHandle: IKoffiRegisteredCallback;
  public waitForAllJobsFuncHandle: IKoffiRegisteredCallback;
  public resumeJobFuncHandle: IKoffiRegisteredCallback;
  public getMaxBatchCountFuncHandle: IKoffiRegisteredCallback;

  public jobsApi: any;
  public nodeJobsApi: any;

  private longtail: Longtail;

  private groups: JobGroup[] = [];
  private workers: any[] = [];

  public constructor() {
    super();

    this.getWorkerCountHandle = register(
      this,
      this.getWorkerCount,
      "Longtail_Job_GetWorkerCountFunc*",
    );

    this.reserveJobsFuncHandle = register(
      this,
      this.reserveJobs,
      "Longtail_Job_ReserveJobsFunc*",
    );

    this.createJobsFuncHandle = register(
      this,
      this.createJobs,
      "Longtail_Job_CreateJobsFunc*",
    );

    this.addDependenciesFuncHandle = register(
      this,
      this.addDependencies,
      "Longtail_Job_AddDependeciesFunc*", // purposefully misspelled
    );

    this.readyJobsFuncHandle = register(
      this,
      this.readyJobs,
      "Longtail_Job_ReadyJobsFunc*",
    );

    this.waitForAllJobsFuncHandle = register(
      this,
      this.waitForAllJobs,
      "Longtail_Job_WaitForAllJobsFunc*",
    );

    this.resumeJobFuncHandle = register(
      this,
      this.resumeJob,
      "Longtail_Job_ResumeJobFunc*",
    );

    this.getMaxBatchCountFuncHandle = register(
      this,
      this.getMaxBatchCount,
      "Longtail_Job_GetMaxBatchCountFunc*",
    );

    this.longtail = Longtail.get();
    this.jobsApi = this.longtail.Alloc(
      "NodeJSJobAPI",
      sizeof("Longtail_JobAPI"),
    );

    this.nodeJobsApi = this.longtail.MakeJobAPI(
      this.jobsApi,
      super.disposeHandle,
      this.getWorkerCountHandle,
      this.reserveJobsFuncHandle,
      this.createJobsFuncHandle,
      this.addDependenciesFuncHandle,
      this.readyJobsFuncHandle,
      this.waitForAllJobsFuncHandle,
      this.resumeJobFuncHandle,
      this.getMaxBatchCountFuncHandle,
    );
  }

  public getWorkerCount(jobApi: any): number {
    console.log("GetWorkerCount func");
    return 1;
  }

  public reserveJobs(jobApi: any, jobCount: number, outJobGroup: any): number {
    const jobGroup = new JobGroup(jobCount);
    const index = this.groups.push(jobGroup) - 1;
    // outJobGroup = index;
    let val = decode(outJobGroup, "uint32_t");
    encode(outJobGroup, "uint32_t", index);
    val = decode(outJobGroup, "uint32_t");
    console.log(`ReserveJobs func: ${jobCount}`);
    return 0;
  }

  public createJobs(
    jobApi: any,
    jobGroup: any,
    progressApi: any,
    optionalCancelApi: any,
    optionalCancelToken: any,
    jobCount: number,
    jobFuncs: any,
    jobContexts: any,
    jobChannel: number,
    outJobs: any,
  ): number {
    console.log(`CreateJobs func: ${jobCount}`);
    console.log(jobGroup);
    const groupIndex = decode(jobGroup, "uint32_t");
    return 0;
  }

  public addDependencies(
    jobApi: any,
    jobCount: number,
    jobs: any,
    dependencyJobCount: number,
    dependencyJobs: any,
  ): number {
    console.log(`AddDependencies func`);
    return 0;
  }

  public readyJobs(jobApi: any, jobCount: number, jobs: any): number {
    console.log(`ReadyJobs func`);
    return 0;
  }

  public waitForAllJobs(
    jobApi: any,
    jobGroup: any,
    progressApi: any,
    optionalCancelApi: any,
    optionalCancelToken: any,
  ): number {
    console.log(`WaitForAllJobs func`);
    return 0;
  }

  public resumeJob(jobApi: any, jobId: number): number {
    console.log(`ResumeJob func: ${jobId}`);
    return 0;
  }

  getMaxBatchCount(
    jobApi: any,
    outMaxJobBatchCount: any,
    outMaxDependencyBatchCount: any,
  ): number {
    console.log(`GetMaxBatchCount func`);
    return 0;
  }

  public unregister(): void {
    unregister(this.getWorkerCountHandle);
    unregister(this.reserveJobsFuncHandle);
    unregister(this.createJobsFuncHandle);
    unregister(this.addDependenciesFuncHandle);
    unregister(this.readyJobsFuncHandle);
    unregister(this.waitForAllJobsFuncHandle);
    unregister(this.resumeJobFuncHandle);
    unregister(this.getMaxBatchCountFuncHandle);
    super.unregister();
  }

  public get(): any {
    return this.nodeJobsApi;
  }
}
