export interface Modification {
  delete: boolean;
  path: string;
  oldPath?: string;
}
