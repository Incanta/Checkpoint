"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const storage_api_1 = require("./storage-api");
// import koffi from "koffi";
const api = storage_api_1.StorageApi.CreateFSStorageAPI();
const openFileResult = api.OpenReadFile("C:\\temp\\test.txt");
if (openFileResult.error) {
    throw new Error(`OpenReadFile failed with error ${openFileResult.error}`);
}
const sizeResult = api.GetSize(openFileResult.file);
if (sizeResult.error) {
    throw new Error(`GetSize failed with error ${sizeResult.error}`);
}
console.log(`size: ${sizeResult.size}`);
const readResult = api.Read(openFileResult.file, 0, sizeResult.size);
if (readResult.error) {
    throw new Error(`Read failed with error ${readResult.error}`);
}
console.log(`read: ${readResult.contents}`);
//# sourceMappingURL=test.js.map