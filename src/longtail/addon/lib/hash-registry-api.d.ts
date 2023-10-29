import { IErrorResult } from "./error";
import { VoidPointer } from "./pointer";
export interface IHashRegistryApiHashApiResult extends IErrorResult {
    hashApi: VoidPointer;
}
export declare class HashRegistryApi {
    private api;
    private constructor();
    static CreateFullHashRegistry(): HashRegistryApi;
    GetHashAPI(hashType: number): IHashRegistryApiHashApiResult;
}
//# sourceMappingURL=hash-registry-api.d.ts.map