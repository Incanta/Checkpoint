"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HashApi = void 0;
const longtail_1 = require("./longtail");
const pointer_1 = require("./pointer");
class HashApi {
    api;
    constructor(api) {
        this.api = api;
    }
    GetIdentifier() {
        const result = longtail_1.Longtail.get().Hash_GetIdentifier(this.api);
        return result;
    }
    BeginContext() {
        const output = new pointer_1.VoidPointer();
        const error = longtail_1.Longtail.get().Hash_BeginContext(this.api, output.ptr());
        return { context: output, error };
    }
    Hash(context, length, data) {
        longtail_1.Longtail.get().Hash_Hash(this.api, context.deref(), length, data);
    }
    EndContext(context) {
        const result = longtail_1.Longtail.get().Hash_EndContext(this.api, context.deref());
        return result;
    }
    HashBuffer(length, data) {
        const output = new pointer_1.StringPointer(length); // not sure if this is correct; perhaps it's less than length?
        const error = longtail_1.Longtail.get().Hash_HashBuffer(this.api, length, data, output.ptr());
        return { hash: output.deref(), error };
    }
}
exports.HashApi = HashApi;
//# sourceMappingURL=hash-api.js.map