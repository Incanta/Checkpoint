import { IErrorResult } from "../util/error";
import { Longtail } from "../longtail";
import { VoidPointer } from "../types/pointer";

export interface IHashRegistryApiHashApiResult extends IErrorResult {
  hashApi: VoidPointer;
}

export class HashRegistryApi {
  private api: any;

  private constructor(api: any) {
    this.api = api;
  }

  public static CreateFullHashRegistry(): HashRegistryApi {
    const hashRegistryApi = Longtail.get().CreateFullHashRegistry();
    return new HashRegistryApi(hashRegistryApi);
  }

  public GetHashAPI(hashType: number): IHashRegistryApiHashApiResult {
    const output = new VoidPointer();
    const error = Longtail.get().HashRegistry_GetHashAPI(this.api, hashType, [
      output.ptr(),
    ]);
    return { hashApi: output, error };
  }
}
