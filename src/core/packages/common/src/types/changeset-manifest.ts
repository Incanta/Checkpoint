import { IFile } from "./file";

export interface IChangesetManifest {
  message: string;
  files: IFile[];
}
