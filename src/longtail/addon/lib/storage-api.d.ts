import { IErrorResult } from "./error";
import { VoidPointer } from "./pointer";
export interface IStorageApiReadResult extends IErrorResult {
    contents: string;
}
export interface IStorageApiSizeResult extends IErrorResult {
    size: number;
}
export interface IStorageApiFileResult extends IErrorResult {
    file: VoidPointer;
}
export interface IStorageApiPermissionsResult extends IErrorResult {
    permissions: number;
}
export declare class StorageApi {
    private api;
    private constructor();
    static CreateFSStorageAPI(): StorageApi;
    static CreateInMemStorageAPI(): StorageApi;
    OpenReadFile(path: string): IStorageApiFileResult;
    GetSize(file: VoidPointer): IStorageApiSizeResult;
    Read(file: VoidPointer, offset: number, length: number): IStorageApiReadResult;
    OpenWriteFile(path: string): IStorageApiFileResult;
    Write(file: VoidPointer, offset: number, content: string): IErrorResult;
    SetSize(file: VoidPointer, size: number): IErrorResult;
    SetPermissions(path: string, permissions: number): IErrorResult;
    GetPermissions(path: string): IStorageApiPermissionsResult;
    CloseFile(file: VoidPointer): void;
    CreateDir(path: string): IErrorResult;
    RenameFile(sourcePath: string, targetPath: string): IErrorResult;
    ConcatPath(rootPath: string, subPath: string): string;
    IsDir(path: string): boolean;
    IsFile(path: string): boolean;
    RemoveDir(path: string): IErrorResult;
    RemoveFile(path: string): IErrorResult;
    StartFind(): void;
    FindNext(): void;
    CloseFind(): void;
    GetEntryProperties(): void;
    LockFile(): void;
    UnlockFile(): void;
    GetParentPath(): void;
    MapFile(): void;
    UnMapFile(): void;
}
//# sourceMappingURL=storage-api.d.ts.map