/**
 * Wall-clock breakdown of an operation by stage, emitted as one parseable
 * line (`[<tag>] {...}`) so tooling such as the benchmark harness can tell
 * where time goes and whether it grows with the change or with the repo.
 */
export class StageTimer {
  private readonly stagesMs: Record<string, number> = {};
  private readonly counts: Record<string, number> = {};
  private current = "";
  private started = Date.now();

  /** Ends the current stage (if any) and starts `stage`. */
  public stage(stage: string): void {
    const now = Date.now();
    if (this.current) {
      this.stagesMs[this.current] =
        (this.stagesMs[this.current] ?? 0) + (now - this.started);
    }
    this.current = stage;
    this.started = now;
  }

  /** Records a count alongside the timings (files, passes, bytes). */
  public count(name: string, value: number): void {
    this.counts[name] = value;
  }

  /** Ends the current stage and returns the line's payload. */
  public finish(): { stagesMs: Record<string, number> } & Record<string, unknown> {
    this.stage("");
    return { ...this.counts, stagesMs: this.stagesMs };
  }

  public log(tag: string, log: (line: string) => void = console.log): void {
    log(`[${tag}] ${JSON.stringify(this.finish())}`);
  }
}
