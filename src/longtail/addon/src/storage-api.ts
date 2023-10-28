import { IErrorResult } from "./error";
import { Longtail } from "./longtail";
import { NumberPointer, StringPointer, VoidPointer } from "./pointer";

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

export class StorageApi {
  private api: any;

  private constructor(api: any) {
    this.api = api;
  }

  public static CreateFSStorageAPI(): StorageApi {
    const storageApi = Longtail.get().CreateFSStorageAPI();
    return new StorageApi(storageApi);
  }

  public static CreateInMemStorageAPI(): StorageApi {
    const storageApi = Longtail.get().CreateInMemStorageAPI();
    return new StorageApi(storageApi);
  }

  public OpenReadFile(path: string): IStorageApiFileResult {
    const output = new VoidPointer();
    const error = Longtail.get().Storage_OpenReadFile(
      this.api,
      path,
      output.ptr(),
    );
    return { file: output, error };
  }

  public GetSize(file: VoidPointer): IStorageApiSizeResult {
    const output = new NumberPointer();
    const error = Longtail.get().Storage_GetSize(
      this.api,
      file.deref(),
      output.ptr(),
    );
    return { size: output.deref(), error };
  }

  public Read(
    file: VoidPointer,
    offset: number,
    length: number,
  ): IStorageApiReadResult {
    const output = new StringPointer(length);
    const error = Longtail.get().Storage_Read(
      this.api,
      file.deref(),
      offset,
      length,
      output,
    );
    return { contents: output.deref(), error };
  }

  public OpenWriteFile(path: string): IStorageApiFileResult {
    const output = new VoidPointer();
    const error = Longtail.get().Storage_OpenWriteFile(
      this.api,
      path,
      output.ptr(),
    );
    return { file: output, error };
  }

  public Write(
    file: VoidPointer,
    offset: number,
    content: string, // TODO: buffer?
  ): IErrorResult {
    const error = Longtail.get().Storage_Write(
      this.api,
      file.deref(),
      offset,
      content.length,
      content,
    );
    return { error };
  }

  public SetSize(file: VoidPointer, size: number): IErrorResult {
    const error = Longtail.get().Storage_SetSize(this.api, file.deref(), size);
    return { error };
  }

  public SetPermissions(path: string, permissions: number): IErrorResult {
    const error = Longtail.get().Storage_SetPermissions(
      this.api,
      path,
      permissions,
    );
    return { error };
  }

  public GetPermissions(path: string): IStorageApiPermissionsResult {
    const permissions = new NumberPointer();
    const error = Longtail.get().Storage_GetPermissions(
      this.api,
      path,
      permissions.ptr(),
    );
    return { permissions: permissions.deref(), error };
  }

  public CloseFile(file: VoidPointer): void {
    Longtail.get().Storage_CloseFile(this.api, file.deref());
  }

  public CreateDir(path: string): IErrorResult {
    const error = Longtail.get().Storage_CreateDir(this.api, path);
    return { error };
  }

  public RenameFile(sourcePath: string, targetPath: string): IErrorResult {
    const error = Longtail.get().Storage_RenameFile(
      this.api,
      sourcePath,
      targetPath,
    );
    return { error };
  }

  public ConcatPath(rootPath: string, subPath: string): string {
    const output = Longtail.get().Storage_ConcatPath(
      this.api,
      rootPath,
      subPath,
    );
    return output;
  }

  public IsDir(path: string): boolean {
    const exists = Longtail.get().Storage_IsDir(this.api, path);
    return exists !== 0;
  }

  public IsFile(path: string): boolean {
    const exists = Longtail.get().Storage_IsFile(this.api, path);
    return exists !== 0;
  }

  public RemoveDir(path: string): IErrorResult {
    const error = Longtail.get().Storage_RemoveDir(this.api, path);
    return { error };
  }

  public RemoveFile(path: string): IErrorResult {
    const error = Longtail.get().Storage_RemoveFile(this.api, path);
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
