"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageApi = void 0;
const longtail_1 = require("./longtail");
const pointer_1 = require("./pointer");
class StorageApi {
    api;
    constructor(api) {
        this.api = api;
    }
    static CreateFSStorageAPI() {
        const storageApi = longtail_1.Longtail.get().CreateFSStorageAPI();
        return new StorageApi(storageApi);
    }
    static CreateInMemStorageAPI() {
        const storageApi = longtail_1.Longtail.get().CreateInMemStorageAPI();
        return new StorageApi(storageApi);
    }
    OpenReadFile(path) {
        const output = new pointer_1.VoidPointer();
        const error = longtail_1.Longtail.get().Storage_OpenReadFile(this.api, path, output.ptr());
        return { file: output, error };
    }
    GetSize(file) {
        const output = new pointer_1.NumberPointer();
        const error = longtail_1.Longtail.get().Storage_GetSize(this.api, file.deref(), output.ptr());
        return { size: output.deref(), error };
    }
    Read(file, offset, length) {
        const output = new pointer_1.StringPointer(length);
        const error = longtail_1.Longtail.get().Storage_Read(this.api, file.deref(), offset, length, output);
        return { contents: output.deref(), error };
    }
    OpenWriteFile(path) {
        const output = new pointer_1.VoidPointer();
        const error = longtail_1.Longtail.get().Storage_OpenWriteFile(this.api, path, output.ptr());
        return { file: output, error };
    }
    Write(file, offset, content) {
        const error = longtail_1.Longtail.get().Storage_Write(this.api, file.deref(), offset, content.length, content);
        return { error };
    }
    SetSize(file, size) {
        const error = longtail_1.Longtail.get().Storage_SetSize(this.api, file.deref(), size);
        return { error };
    }
    SetPermissions(path, permissions) {
        const error = longtail_1.Longtail.get().Storage_SetPermissions(this.api, path, permissions);
        return { error };
    }
    GetPermissions(path) {
        const permissions = new pointer_1.NumberPointer();
        const error = longtail_1.Longtail.get().Storage_GetPermissions(this.api, path, permissions.ptr());
        return { permissions: permissions.deref(), error };
    }
    CloseFile(file) {
        longtail_1.Longtail.get().Storage_CloseFile(this.api, file.deref());
    }
    CreateDir(path) {
        const error = longtail_1.Longtail.get().Storage_CreateDir(this.api, path);
        return { error };
    }
    RenameFile(sourcePath, targetPath) {
        const error = longtail_1.Longtail.get().Storage_RenameFile(this.api, sourcePath, targetPath);
        return { error };
    }
    ConcatPath(rootPath, subPath) {
        const output = longtail_1.Longtail.get().Storage_ConcatPath(this.api, rootPath, subPath);
        return output;
    }
    IsDir(path) {
        const exists = longtail_1.Longtail.get().Storage_IsDir(this.api, path);
        return exists !== 0;
    }
    IsFile(path) {
        const exists = longtail_1.Longtail.get().Storage_IsFile(this.api, path);
        return exists !== 0;
    }
    RemoveDir(path) {
        const error = longtail_1.Longtail.get().Storage_RemoveDir(this.api, path);
        return { error };
    }
    RemoveFile(path) {
        const error = longtail_1.Longtail.get().Storage_RemoveFile(this.api, path);
        return { error };
    }
    StartFind() {
        //
    }
    FindNext() {
        //
    }
    CloseFind() {
        //
    }
    GetEntryProperties() {
        //
    }
    LockFile() {
        //
    }
    UnlockFile() {
        //
    }
    GetParentPath() {
        //
    }
    MapFile() {
        //
    }
    UnMapFile() {
        //
    }
}
exports.StorageApi = StorageApi;
//# sourceMappingURL=storage-api.js.map