"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeHashes = exports.decodeHash = exports.stringify = void 0;
const koffi_1 = require("koffi");
function stringify(obj) {
    return JSON.stringify(obj, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2);
}
exports.stringify = stringify;
function decodeHash(obj, offset = 0) {
    return (0, koffi_1.decode)(obj, offset * 8, "TLongtail_Hash");
}
exports.decodeHash = decodeHash;
function decodeHashes(obj, count) {
    const result = new Array(count);
    for (let i = 0; i < count; i++) {
        result[i] = decodeHash(obj, i);
    }
    return result;
}
exports.decodeHashes = decodeHashes;
//# sourceMappingURL=util.js.map