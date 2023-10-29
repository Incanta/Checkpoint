import { IErrorResult } from "./error";
import { VoidPointer } from "./pointer";
export interface IHashApiContextResult extends IErrorResult {
    context: VoidPointer;
}
export interface IHashApiHashResult extends IErrorResult {
    hash: string;
}
export declare class HashApi {
    private api;
    private constructor();
    GetIdentifier(): number;
    BeginContext(): IHashApiContextResult;
    Hash(context: VoidPointer, length: number, data: string): void;
    EndContext(context: VoidPointer): number;
    HashBuffer(length: number, data: string): IHashApiHashResult;
}
//# sourceMappingURL=hash-api.d.ts.map