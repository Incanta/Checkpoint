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
  /**
   * When this baseline was recorded, by the workspace filesystem's own clock
   * (ms). A file whose mtime is not older than this, less the coarsest
   * timestamp tick, may have been rewritten in the same tick at the same
   * size, so its size and mtime prove nothing and its content decides (see
   * compareWithBaseline). Absent on entries from older daemons.
   */
  recordedAt?: number;
  /**
   * The file's permission bits (0o644, 0o755) as last pulled or submitted.
   * Absent on entries from older daemons, and where nothing told the daemon
   * (a Windows pull by an addon that does not report modes).
   */
  mode?: number;
}
