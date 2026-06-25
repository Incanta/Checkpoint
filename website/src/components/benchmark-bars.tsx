// Shared bar primitives for the performance section. Pure render helpers (no
// hooks), so both the static Cloud card (server) and the data-driven LAN card
// (client) can use them.

export interface Segment {
  label: string;
  seconds: number;
}

export interface Entry {
  name: string;
  seconds: number;
  isUs?: boolean;
  segments?: Segment[];
}

export interface BenchmarkTest {
  label: string;
  entries: Entry[];
}

export interface BenchmarkGroup {
  category: string;
  description: string;
  tests: BenchmarkTest[];
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h > 0 ? `${h}h` : null, m > 0 ? `${m}m` : null, `${s}s`]
    .filter(Boolean)
    .join(" ");
}

const SEGMENT_COLORS_US = ["bg-primary", "bg-primary-light", "bg-accent"];
const SEGMENT_COLORS = ["bg-white/10", "bg-white/[0.35]", "bg-white/[0.2]"];

export function Bar({ entry, maxSeconds }: { entry: Entry; maxSeconds: number }) {
  const pct = maxSeconds > 0 ? (entry.seconds / maxSeconds) * 100 : 0;
  const colors = entry.isUs ? SEGMENT_COLORS_US : SEGMENT_COLORS;

  return (
    <div className="flex items-center gap-4">
      <span
        className={`w-28 shrink-0 text-sm font-medium text-right ${entry.isUs ? "text-primary-light" : "text-muted"}`}
      >
        {entry.name}
      </span>
      <div className="flex-1">
        <div className="relative h-9 rounded-lg overflow-hidden bg-surface">
          {entry.segments ? (
            /* Segmented bar */
            <div
              className="absolute inset-y-0 left-0 flex rounded-lg overflow-hidden"
              style={{ width: `${pct}%` }}
            >
              {entry.segments.map((seg, i) => {
                const segPct = (seg.seconds / entry.seconds) * 100;
                return (
                  <div
                    key={seg.label}
                    className={`h-full ${colors[i % colors.length]} ${i > 0 ? "border-l border-background/30" : ""}`}
                    style={{ width: `${segPct}%` }}
                    title={`${seg.label}: ${formatTime(seg.seconds)}`}
                  />
                );
              })}
            </div>
          ) : (
            /* Solid bar */
            <div
              className={`absolute inset-y-0 left-0 rounded-lg transition-all duration-700 ${
                entry.isUs
                  ? "bg-gradient-to-r from-primary to-primary-light"
                  : "bg-white/10"
              }`}
              style={{ width: `${pct}%` }}
            />
          )}
          <span className="absolute inset-y-0 flex items-center pl-3 text-sm font-semibold text-foreground">
            {formatTime(entry.seconds)}
          </span>
        </div>
        {/* Segment legend */}
        {entry.segments && (
          <div className="flex gap-3 mt-1.5 pl-1">
            {entry.segments.map((seg, i) => (
              <span
                key={seg.label}
                className="flex items-center gap-1.5 text-[11px] text-muted"
              >
                <span
                  className={`inline-block w-2 h-2 rounded-sm ${colors[i % colors.length]}`}
                />
                {seg.label}: {formatTime(seg.seconds)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function BenchmarkTests({
  tests,
  maxSeconds,
}: {
  tests: BenchmarkTest[];
  maxSeconds: number;
}) {
  return (
    <div className="space-y-6">
      {tests.map((test) => (
        <div key={test.label}>
          <p className="text-xs uppercase tracking-wider text-muted/60 mb-2">
            {test.label}
          </p>
          <div className="space-y-2">
            {test.entries.map((entry) => (
              <Bar key={entry.name} entry={entry} maxSeconds={maxSeconds} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
