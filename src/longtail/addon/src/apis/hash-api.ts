import { IErrorResult } from "../util/error";
import { Longtail } from "../longtail";
import { StringPointer, VoidPointer } from "../types/pointer";

export interface IHashApiContextResult extends IErrorResult {
  context: VoidPointer;
}

export interface IHashApiHashResult extends IErrorResult {
  hash: string;
}

export class HashApi {
  private api: any;

  private constructor(api: any) {
    this.api = api;
  }

  public GetIdentifier(): number {
    const result = this.api.GetIdentifier(this.api);
    return result;
  }

  public BeginContext(): IHashApiContextResult {
    const output = new VoidPointer();
    const error = this.api.BeginContext(this.api, output.ptr());
    return { context: output, error };
  }

  public Hash(context: VoidPointer, length: number, data: string): void {
    this.api.Hash(this.api, context.deref(), length, data);
  }

  public EndContext(context: VoidPointer): number {
    const result = this.api.EndContext(this.api, context.deref());
    return result;
  }

  public HashBuffer(length: number, data: string): IHashApiHashResult {
    const output = new StringPointer(length); // not sure if this is correct; perhaps it's less than length?
    const error = this.api.HashBuffer(this.api, length, data, output.ptr());
    return { hash: output.deref(), error };
  }
}
