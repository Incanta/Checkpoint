import BenchmarkChart from "@/components/BenchmarkChart";
import LanBenchmarks from "@/components/LanBenchmarks";
import {
  BenchmarkTests,
  type BenchmarkGroup,
} from "@/components/benchmark-bars";

// LAN numbers are data-driven from the benchmark JSON (see LanBenchmarks).
// Cloud has no JSON equivalent yet, so it stays hardcoded here.
const cloudGroup: BenchmarkGroup = {
  category: "Cloud",
  description:
    "Cloud-based version control systems • US West to US East • Apr 2026",
  tests: [
    {
      label: "Submit (Upload)",
      entries: [
        { name: "Checkpoint (R2)", seconds: 1824, isUs: true },
        { name: "Diversion", seconds: 2358 },
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
        { name: "* GitHub", seconds: 6251 },
        { name: "* Azure Repos", seconds: 3438 },
      ],
    },
  ],
};

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
          {/* LAN: data-driven from benchmark JSON, with a RAM selector */}
          <LanBenchmarks />

          {/* Cloud: hardcoded (no JSON dataset yet) */}
          <div className="glass rounded-2xl p-8">
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-1">
                {cloudGroup.category}
              </h3>
              <p className="text-sm text-muted">{cloudGroup.description}</p>
            </div>
            <BenchmarkTests
              tests={cloudGroup.tests}
              maxSeconds={Math.max(
                ...cloudGroup.tests.flatMap((t) =>
                  t.entries.map((e) => e.seconds),
                ),
              )}
            />
          </div>
        </div>

        {/* Resource usage chart */}
        <div className="mt-8">
          <BenchmarkChart />
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
