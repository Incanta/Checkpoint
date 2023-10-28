import { IKoffiRegisteredCallback, register, unregister } from "koffi";

export class LongtailApi {
  public disposeHandle: IKoffiRegisteredCallback;

  public constructor() {
    this.disposeHandle = register(this, this.dispose, "Longtail_DisposeFunc*");
  }

  public dispose(obj: any): void {
    // do nothing?

    this.unregister();
  }

  public unregister(): void {
    unregister(this.disposeHandle);
  }

  public get(): any {
    return {
      Dispose: this.disposeHandle,
    };
  }
}
