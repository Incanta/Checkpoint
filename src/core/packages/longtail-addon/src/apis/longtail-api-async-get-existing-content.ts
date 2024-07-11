import { type IKoffiRegisteredCallback, register, unregister } from "koffi";
import { LongtailApi } from "./longtail-api";

export class LongtailApiAsyncGetExistingContent extends LongtailApi {
  public onCompleteHandle: IKoffiRegisteredCallback;

  public constructor() {
    super();

    this.onCompleteHandle = register(
      this,
      this.onComplete,
      "Longtail_AsyncGetExistingContent_OnCompleteFunc*"
    );
  }

  public onComplete(asyncCompleteApi: any, storeIndex: any, err: number): void {
    // do nothing?
    console.log("async get existing content completed");
    this.unregister();
  }

  public unregister(): void {
    unregister(this.onCompleteHandle);
    super.unregister();
  }

  public get(): any {
    return {
      m_API: super.get(),
      OnComplete: this.onCompleteHandle,
    };
  }
}
