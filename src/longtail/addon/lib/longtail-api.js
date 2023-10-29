"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LongtailApi = void 0;
const koffi_1 = require("koffi");
class LongtailApi {
    disposeHandle;
    constructor() {
        this.disposeHandle = (0, koffi_1.register)(this, this.dispose, "Longtail_DisposeFunc*");
    }
    dispose(obj) {
        // do nothing?
        this.unregister();
    }
    unregister() {
        (0, koffi_1.unregister)(this.disposeHandle);
    }
    get() {
        return {
            Dispose: this.disposeHandle,
        };
    }
}
exports.LongtailApi = LongtailApi;
//# sourceMappingURL=longtail-api.js.map