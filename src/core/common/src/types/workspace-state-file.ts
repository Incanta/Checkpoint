export interface WorkspaceStateFile {
  fileId: string;
  changelist: number;
  md5: string;
  size: number;
  mtime?: number;
  /**
   * The feature branch this file's content came from, when it came from one.
   *
   * Absent means the domain root, which is where every file came from before
   * multi-branch workspaces existed. That is what makes the v2 to v3 state
   * migration a no-op: today's files all came from the branch the workspace was
   * on, and that branch becomes its domain root.
   *
   * Mirrors `FileClaim.branchName` on the server. The two are the same fact
   * stored twice; the server wins on disagreement.
   */
  branch?: string;
}
