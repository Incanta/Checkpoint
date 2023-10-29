"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LongtailApiProgress = void 0;
const koffi_1 = require("koffi");
const longtail_api_1 = require("./longtail-api");
const events_1 = __importDefault(require("events"));
class LongtailApiProgress extends longtail_api_1.LongtailApi {
    onProgressHandle;
    progress;
    completed = false;
    constructor() {
        super();
        this.onProgressHandle = (0, koffi_1.register)(this, this.onProgress, "Longtail_Progress_OnProgressFunc*");
        this.progress = new events_1.default();
    }
    onProgress(progressApi, totalCount, doneCount) {
        console.log(`Finished ${doneCount} of ${totalCount} - ${(doneCount / totalCount) * 100}%`);
        this.progress.emit("progress", totalCount, doneCount);
        if (doneCount >= totalCount) {
            this.completed = true;
            this.progress.emit("complete");
            this.unregister();
        }
    }
    async wait() {
        if (!this.completed) {
            return new Promise((resolve) => {
                this.progress.on("complete", () => {
                    resolve();
                });
            });
        }
    }
    unregister() {
        (0, koffi_1.unregister)(this.onProgressHandle);
        super.unregister();
    }
    get() {
        return {
            m_API: super.get(),
            OnProgress: this.onProgressHandle,
        };
    }
}
exports.LongtailApiProgress = LongtailApiProgress;
//# sourceMappingURL=longtail-api-progress.js.map