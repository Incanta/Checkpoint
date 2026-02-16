export interface WorkspaceStateFile {
  fileId: string;
  changelist: number;
  hash: string;
  size: number;
  mtime?: number;
}
