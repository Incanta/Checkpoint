/// <reference types="node" />
import { IKoffiRegisteredCallback } from "koffi";
import { LongtailApi } from "./longtail-api";
import EventEmitter from "events";
export declare class LongtailApiProgress extends LongtailApi {
    onProgressHandle: IKoffiRegisteredCallback;
    progress: EventEmitter;
    private completed;
    constructor();
    onProgress(progressApi: any, totalCount: number, doneCount: number): void;
    wait(): Promise<void>;
    unregister(): void;
    get(): any;
}
//# sourceMappingURL=longtail-api-progress.d.ts.map