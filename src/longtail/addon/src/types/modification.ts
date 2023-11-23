export enum Operation {
  Add,
  Modify,
  Delete,
}

export interface Modification {
  path: string;
  operation: Operation;
  permissions: number;
  isDirectory: boolean;
}
