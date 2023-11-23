import { IErrorResult } from "../util/error";
import { Longtail } from "../longtail";
import { BufferPointer, NumberPointer, VoidPointer } from "./pointer";
import { decode } from "koffi";

export interface IStorageApiReadResult extends IErrorResult {
  contents: Uint8Array;
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

export class StorageApi {
  private api: any;
  private decodedApi: any;

  private constructor(api: any) {
    this.api = api;
    this.decodedApi = decode(api, "Longtail_StorageAPI");
    this.decodedApi.OpenReadFile = decode(
      this.decodedApi.OpenReadFile,
      "Longtail_Storage_OpenReadFile",
    );
    this.decodedApi.GetSize = decode(
      this.decodedApi.GetSize,
      "Longtail_Storage_GetSize",
    );
    this.decodedApi.Read = decode(
      this.decodedApi.Read,
      "Longtail_Storage_Read",
    );
    this.decodedApi.OpenWriteFile = decode(
      this.decodedApi.OpenWriteFile,
      "Longtail_Storage_OpenWriteFile",
    );
    this.decodedApi.Write = decode(
      this.decodedApi.Write,
      "Longtail_Storage_Write",
    );
    this.decodedApi.SetSize = decode(
      this.decodedApi.SetSize,
      "Longtail_Storage_SetSize",
    );
    this.decodedApi.SetPermissions = decode(
      this.decodedApi.SetPermissions,
      "Longtail_Storage_SetPermissions",
    );
    this.decodedApi.GetPermissions = decode(
      this.decodedApi.GetPermissions,
      "Longtail_Storage_GetPermissions",
    );
    this.decodedApi.CloseFile = decode(
      this.decodedApi.CloseFile,
      "Longtail_Storage_CloseFile",
    );
    this.decodedApi.CreateDir = decode(
      this.decodedApi.CreateDir,
      "Longtail_Storage_CreateDir",
    );
    this.decodedApi.RenameFile = decode(
      this.decodedApi.RenameFile,
      "Longtail_Storage_RenameFile",
    );
    this.decodedApi.ConcatPath = decode(
      this.decodedApi.ConcatPath,
      "Longtail_Storage_ConcatPath",
    );
    this.decodedApi.IsDir = decode(
      this.decodedApi.IsDir,
      "Longtail_Storage_IsDir",
    );
    this.decodedApi.IsFile = decode(
      this.decodedApi.IsFile,
      "Longtail_Storage_IsFile",
    );
    this.decodedApi.RemoveDir = decode(
      this.decodedApi.RemoveDir,
      "Longtail_Storage_RemoveDir",
    );
    this.decodedApi.RemoveFile = decode(
      this.decodedApi.RemoveFile,
      "Longtail_Storage_RemoveFile",
    );
    this.decodedApi.StartFind = decode(
      this.decodedApi.StartFind,
      "Longtail_Storage_StartFind",
    );
    this.decodedApi.FindNext = decode(
      this.decodedApi.FindNext,
      "Longtail_Storage_FindNext",
    );
    this.decodedApi.CloseFind = decode(
      this.decodedApi.CloseFind,
      "Longtail_Storage_CloseFind",
    );
    this.decodedApi.GetEntryProperties = decode(
      this.decodedApi.GetEntryProperties,
      "Longtail_Storage_GetEntryProperties",
    );
    this.decodedApi.LockFile = decode(
      this.decodedApi.LockFile,
      "Longtail_Storage_LockFile",
    );
    this.decodedApi.UnlockFile = decode(
      this.decodedApi.UnlockFile,
      "Longtail_Storage_UnlockFile",
    );
    this.decodedApi.GetParentPath = decode(
      this.decodedApi.GetParentPath,
      "Longtail_Storage_GetParentPath",
    );
    this.decodedApi.MapFile = decode(
      this.decodedApi.MapFile,
      "Longtail_Storage_MapFile",
    );
    this.decodedApi.UnMapFile = decode(
      this.decodedApi.UnMapFile,
      "Longtail_Storage_UnmapFile",
    );
  }

  public static CreateFSStorageAPI(): StorageApi {
    const storageApi = Longtail.get().CreateFSStorageAPI();
    return new StorageApi(storageApi);
  }

  public static CreateInMemStorageAPI(): StorageApi {
    const storageApi = Longtail.get().CreateInMemStorageAPI();
    return new StorageApi(storageApi);
  }

  public get(): any {
    return this.api;
  }

  public OpenReadFile(path: string): IStorageApiFileResult {
    const output = new VoidPointer();
    const error = this.decodedApi.OpenReadFile(this.api, path, output.ptr());
    return { file: output, error };
  }

  public GetSize(file: VoidPointer): IStorageApiSizeResult {
    const output = new NumberPointer();
    const error = this.decodedApi.GetSize(this.api, file.deref(), output.ptr());
    return { size: output.deref(), error };
  }

  public Read(
    file: VoidPointer,
    offset: number,
    length: number,
  ): IStorageApiReadResult {
    const output = new BufferPointer(length);
    const error = this.decodedApi.Read(
      this.api,
      file.deref(),
      offset,
      length,
      output.ptr(),
    );
    return { contents: output.deref(), error };
  }

  public OpenWriteFile(path: string): IStorageApiFileResult {
    const output = new VoidPointer();
    const error = this.decodedApi.OpenWriteFile(this.api, path, output.ptr());
    return { file: output, error };
  }

  public Write(
    file: VoidPointer,
    offset: number,
    content: string, // TODO: buffer?
  ): IErrorResult {
    const error = this.decodedApi.Write(
      this.api,
      file.deref(),
      offset,
      content.length,
      content,
    );
    return { error };
  }

  public SetSize(file: VoidPointer, size: number): IErrorResult {
    const error = this.decodedApi.SetSize(this.api, file.deref(), size);
    return { error };
  }

  public SetPermissions(path: string, permissions: number): IErrorResult {
    const error = this.decodedApi.SetPermissions(this.api, path, permissions);
    return { error };
  }

  public GetPermissions(path: string): IStorageApiPermissionsResult {
    const permissions = new NumberPointer();
    const error = this.decodedApi.GetPermissions(
      this.api,
      path,
      permissions.ptr(),
    );
    return { permissions: permissions.deref(), error };
  }

  public CloseFile(file: VoidPointer): void {
    this.decodedApi.CloseFile(this.api, file.deref());
  }

  public CreateDir(path: string): IErrorResult {
    const error = this.decodedApi.CreateDir(this.api, path);
    return { error };
  }

  public RenameFile(sourcePath: string, targetPath: string): IErrorResult {
    const error = this.decodedApi.RenameFile(this.api, sourcePath, targetPath);
    return { error };
  }

  public ConcatPath(rootPath: string, subPath: string): string {
    const output = this.decodedApi.ConcatPath(this.api, rootPath, subPath);
    return output;
  }

  public IsDir(path: string): boolean {
    // @ts-ignore
    const exists = this.decodedApi.IsDir(this.api, path);
    return exists !== 0;
  }

  public IsFile(path: string): boolean {
    const exists = this.decodedApi.IsFile(this.api, path);
    return exists !== 0;
  }

  public RemoveDir(path: string): IErrorResult {
    const error = this.decodedApi.RemoveDir(this.api, path);
    return { error };
  }

  public RemoveFile(path: string): IErrorResult {
    const error = this.decodedApi.RemoveFile(this.api, path);
    return { error };
  }

  public StartFind(): void {
    //
  }

  public FindNext(): void {
    //
  }

  public CloseFind(): void {
    //
  }

  public GetEntryProperties(): void {
    //
  }

  public LockFile(): void {
    //
  }

  public UnlockFile(): void {
    //
  }

  public GetParentPath(): void {
    //
  }

  public MapFile(): void {
    //
  }

  public UnMapFile(): void {
    //
  }
}
