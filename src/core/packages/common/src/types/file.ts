export interface IFile {
  type: "add" | "change" | "rename" | "delete";
  path: string;
  name: string;
  size: number;
  modifiedTime: number;
  changedTime: number;
  crc32: string;
  md5: string;

  oldPath?: string;
  oldName?: string;
}
