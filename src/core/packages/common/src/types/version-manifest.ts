import { IChangesetManifest } from "./changeset-manifest";

export interface IVersionManifest {
  id: string;
  changeset: IChangesetManifest;
}
