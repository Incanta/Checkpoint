interface Segment {
  label: string;
  seconds: number;
}

interface Entry {
  name: string;
  seconds: number;
  isUs?: boolean;
  segments?: Segment[];
}

interface BenchmarkTest {
  label: string;
  entries: Entry[];
}

interface BenchmarkGroup {
  category: string;
  description: string;
  tests: BenchmarkTest[];
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h > 0 ? `${h}h` : null, m > 0 ? `${m}m` : null, `${s}s`]
    .filter(Boolean)
    .join(" ");
}

const benchmarks: BenchmarkGroup[] = [
  {
    category: "LAN",
    description: "LAN based version control systems • local network server",
    tests: [
      {
        label: "Submit (Upload)",
        entries: [
          { name: "Checkpoint", seconds: 859, isUs: true },
          { name: "Lore", seconds: 1527 },
          {
            name: "Perforce",
            seconds: 3198,
            segments: [
              { label: "p4 add", seconds: 1172 },
              { label: "p4 submit", seconds: 2026 },
            ],
          },
          {
            name: "* Gitea",
            seconds: 6007,
            segments: [
              { label: "git add", seconds: 1797 },
              { label: "git commit", seconds: 700 },
              { label: "git push", seconds: 3510 },
            ],
          },
        ],
      },
      {
        label: "Pull (Sync)",
        entries: [
          { name: "Checkpoint", seconds: 512, isUs: true },
          { name: "Lore", seconds: 584 },
          { name: "Perforce", seconds: 621 },
          { name: "* Gitea", seconds: 2350 },
        ],
      },
    ],
  },
  {
    category: "Cloud",
    description: "Cloud-based version control systems • US West to US East",
    tests: [
      {
        label: "Submit (Upload)",
        entries: [
          { name: "Checkpoint (R2)", seconds: 1824, isUs: true },
          { name: "Diversion", seconds: 2358 },
          { name: "Unity Version Control", seconds: 1213 },
          {
            name: "* GitHub",
            seconds: 14030,
            segments: [
              { label: "git add", seconds: 1797 },
              { label: "git commit", seconds: 700 },
              { label: "git push", seconds: 11533 },
            ],
          },
          {
            name: "* Azure Repos",
            seconds: 8632,
            segments: [
              { label: "git add", seconds: 1797 },
              { label: "git commit", seconds: 700 },
              { label: "git push", seconds: 6430 },
            ],
          },
        ],
      },
      {
        label: "Pull (Sync)",
        entries: [
          { name: "Checkpoint (R2)", seconds: 1520, isUs: true },
          { name: "Diversion", seconds: 1470 },
          { name: "Unity Version Control", seconds: 713 },
          { name: "* GitHub", seconds: 6251 },
          { name: "* Azure Repos", seconds: 3438 },
        ],
      },
    ],
  },
];

const SEGMENT_COLORS_US = ["bg-primary", "bg-primary-light", "bg-accent"];

const SEGMENT_COLORS = ["bg-white/10", "bg-white/[0.35]", "bg-white/[0.2]"];

function Bar({ entry, maxSeconds }: { entry: Entry; maxSeconds: number }) {
  const pct = (entry.seconds / maxSeconds) * 100;
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

export default function PerformanceMetrics() {
  return (
    <section id="performance" className="relative py-32 overflow-hidden">
      {/* Divider glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2/3 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        {/* Section header */}
        <div className="text-center mb-16">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary mb-3">
            Performance
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Benchmarked against the industry
          </h2>
          <p className="mx-auto max-w-2xl text-muted text-lg">
            Full submit and sync of the Unreal Engine{" "}
            <a
              href="https://www.fab.com/listings/c05aac82-4c1a-4e42-96b3-be668dc40fca"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-light hover:underline"
            >
              Project Titan
            </a>{" "}
            gameplay template.
            <br />
            ~44 GB across ~190K files
          </p>
        </div>

        {/* Benchmark groups */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {benchmarks.map((group) => {
            const maxSeconds = Math.max(
              ...group.tests.flatMap((t) => t.entries.map((e) => e.seconds)),
            );
            return (
              <div key={group.category} className="glass rounded-2xl p-8">
                <div className="mb-6">
                  <h3 className="text-lg font-semibold mb-1">
                    {group.category}
                  </h3>
                  <p className="text-sm text-muted">{group.description}</p>
                </div>
                <div className="space-y-6">
                  {group.tests.map((test) => (
                    <div key={test.label}>
                      <p className="text-xs uppercase tracking-wider text-muted/60 mb-2">
                        {test.label}
                      </p>
                      <div className="space-y-2">
                        {test.entries.map((entry) => (
                          <Bar
                            key={entry.name}
                            entry={entry}
                            maxSeconds={maxSeconds}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footnote */}
        <p className="mt-8 text-center text-xs text-muted/50">
          Benchmarks performed using Checkpoint CLI. LAN tests used a local
          server. Cloud tests used a US West client connecting to a US East
          storage server with 2 Gbps upload speeds. We could not control where
          the Git servers were for GitHub and Azure Repos, and likely were also
          US West.
          <br />* Git struggled with the large number of small LFS files (due to
          Unreal Engine World Partition), causing very long push/pull times.
        </p>
      </div>
    </section>
  );
}
