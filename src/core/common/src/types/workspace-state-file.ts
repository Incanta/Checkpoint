export interface WorkspaceStateFile {
  fileId: string;
  changelist: number;
  md5: string;
  size: number;
  mtime?: number;
}
