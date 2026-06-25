import LanBenchmarks from "@/components/LanBenchmarks";
import BenchmarkChart from "@/components/BenchmarkChart";

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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <LanBenchmarks />
          <BenchmarkChart />
        </div>

        {/* Footnote */}
        <p className="mt-8 text-center text-xs text-muted/50">
          Benchmarks performed using Checkpoint CLI on separate Linux client and
          server machines. You can find the benchmark run on{" "}
          <a
            href="https://github.com/Incanta/Checkpoint/actions/runs/28134934677"
            target="_blank"
          >
            GitHub
          </a>
          .
          <br />* Git struggled with the large number of small LFS files (due to
          Unreal Engine World Partition), causing very long push/pull times.
        </p>
      </div>
    </section>
  );
}
