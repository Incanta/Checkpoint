import { IErrorResult } from "./error";
import { Longtail } from "./longtail";
import { StringPointer, VoidPointer } from "./pointer";

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
    const result = Longtail.get().Hash_GetIdentifier(this.api);
    return result;
  }

  public BeginContext(): IHashApiContextResult {
    const output = new VoidPointer();
    const error = Longtail.get().Hash_BeginContext(this.api, output.ptr());
    return { context: output, error };
  }

  public Hash(context: VoidPointer, length: number, data: string): void {
    Longtail.get().Hash_Hash(this.api, context.deref(), length, data);
  }

  public EndContext(context: VoidPointer): number {
    const result = Longtail.get().Hash_EndContext(this.api, context.deref());
    return result;
  }

  public HashBuffer(length: number, data: string): IHashApiHashResult {
    const output = new StringPointer(length); // not sure if this is correct; perhaps it's less than length?
    const error = Longtail.get().Hash_HashBuffer(
      this.api,
      length,
      data,
      output.ptr(),
    );
    return { hash: output.deref(), error };
  }
}
