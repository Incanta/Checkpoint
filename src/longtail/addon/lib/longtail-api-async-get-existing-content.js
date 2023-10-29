"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LongtailApiAsyncGetExistingContent = void 0;
const koffi_1 = require("koffi");
const longtail_api_1 = require("./longtail-api");
class LongtailApiAsyncGetExistingContent extends longtail_api_1.LongtailApi {
    onCompleteHandle;
    constructor() {
        super();
        this.onCompleteHandle = (0, koffi_1.register)(this, this.onComplete, "Longtail_AsyncGetExistingContent_OnCompleteFunc*");
    }
    onComplete(asyncCompleteApi, storeIndex, err) {
        // do nothing?
        console.log("async get existing content completed");
        this.unregister();
    }
    unregister() {
        (0, koffi_1.unregister)(this.onCompleteHandle);
        super.unregister();
    }
    get() {
        return {
            m_API: super.get(),
            OnComplete: this.onCompleteHandle,
        };
    }
}
exports.LongtailApiAsyncGetExistingContent = LongtailApiAsyncGetExistingContent;
//# sourceMappingURL=longtail-api-async-get-existing-content.js.map