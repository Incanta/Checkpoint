"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HashRegistryApi = void 0;
const longtail_1 = require("./longtail");
const pointer_1 = require("./pointer");
class HashRegistryApi {
    api;
    constructor(api) {
        this.api = api;
    }
    static CreateFullHashRegistry() {
        const hashRegistryApi = longtail_1.Longtail.get().CreateFullHashRegistry();
        return new HashRegistryApi(hashRegistryApi);
    }
    GetHashAPI(hashType) {
        const output = new pointer_1.VoidPointer();
        const error = longtail_1.Longtail.get().HashRegistry_GetHashAPI(this.api, hashType, [
            output.ptr(),
        ]);
        return { hashApi: output, error };
    }
}
exports.HashRegistryApi = HashRegistryApi;
//# sourceMappingURL=hash-registry-api.js.map