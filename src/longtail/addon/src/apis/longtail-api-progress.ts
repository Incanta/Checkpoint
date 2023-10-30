import { IKoffiRegisteredCallback, register, unregister } from "koffi";
import { LongtailApi } from "./longtail-api";
import EventEmitter from "events";

export class LongtailApiProgress extends LongtailApi {
  public onProgressHandle: IKoffiRegisteredCallback;

  public progress: EventEmitter;

  private completed: boolean = false;

  public constructor() {
    super();

    this.onProgressHandle = register(
      this,
      this.onProgress,
      "Longtail_Progress_OnProgressFunc*",
    );

    this.progress = new EventEmitter();
  }

  public onProgress(
    progressApi: any,
    totalCount: number,
    doneCount: number,
  ): void {
    this.progress.emit("progress", totalCount, doneCount);

    if (doneCount >= totalCount) {
      this.completed = true;
      this.progress.emit("complete");
      this.unregister();
    }
  }

  public async wait(): Promise<void> {
    if (!this.completed) {
      return new Promise<void>((resolve) => {
        this.progress.on("complete", () => {
          resolve();
        });
      });
    }
  }

  public unregister(): void {
    unregister(this.onProgressHandle);
    super.unregister();
  }

  public get(): any {
    return {
      m_API: super.get(),
      OnProgress: this.onProgressHandle,
    };
  }
}
