import { IKoffiRegisteredCallback } from "koffi";
import { LongtailApi } from "./longtail-api";
export declare class LongtailApiAsyncGetExistingContent extends LongtailApi {
    onCompleteHandle: IKoffiRegisteredCallback;
    constructor();
    onComplete(asyncCompleteApi: any, storeIndex: any, err: number): void;
    unregister(): void;
    get(): any;
}
//# sourceMappingURL=longtail-api-async-get-existing-content.d.ts.map