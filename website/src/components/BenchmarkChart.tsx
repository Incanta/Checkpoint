"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  type ChartData,
  type ChartOptions,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(
  LinearScale,
  CategoryScale,
  PointElement,
  LineElement,
  Legend,
  Filler,
);

// Each resources.<vcs>.json holds client/server resource samples; see
// website/public/benchmark-results/*/resources.*.json.
interface Sample {
  t: number;
  cpu_pct: number;
  ram_gb: number;
}

interface ResourceData {
  interval_s: number;
  client: Sample[];
  server: Sample[];
}

interface Vcs {
  key: string;
  label: string;
  color: string;
}

const VCS_LIST: Vcs[] = [
  { key: "checkpoint", label: "Checkpoint", color: "#8B3FF9" }, // purple
  { key: "lore", label: "Lore", color: "#22C55E" }, // green
  { key: "ark", label: "Ark", color: "#A0522D" }, // brown
  { key: "perforce", label: "Perforce", color: "#3B82F6" }, // blue
  { key: "gitea", label: "Gitea", color: "#EAB308" }, // yellow
];

type Side = "client" | "server";
type Metric = "cpu" | "ram";

const SIDE_OPTIONS: { value: Side; label: string }[] = [
  { value: "client", label: "Client" },
  { value: "server", label: "Server" },
];

const METRIC_OPTIONS: { value: Metric; label: string }[] = [
  { value: "cpu", label: "CPU" },
  { value: "ram", label: "RAM" },
];

function PillGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-muted/60">
        {label}
      </span>
      <div className="inline-flex rounded-full glass p-1">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
              value === opt.value
                ? "bg-primary text-white shadow-lg shadow-primary/25"
                : "text-muted hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function BenchmarkChart() {
  const [side, setSide] = useState<Side>("client");
  const [metric, setMetric] = useState<Metric>("cpu");

  const [data, setData] = useState<Record<string, ResourceData>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    async function load() {
      try {
        const results = await Promise.all(
          VCS_LIST.map(async (vcs) => {
            const res = await fetch(
              `/benchmark-results/resources.${vcs.key}.json`,
            );
            if (!res.ok) throw new Error(`${vcs.key}: ${res.status}`);
            return [vcs.key, (await res.json()) as ResourceData] as const;
          }),
        );
        if (!cancelled) {
          setData(Object.fromEntries(results));
          setStatus("ready");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const chartData = useMemo<ChartData<"line">>(() => {
    const datasets = VCS_LIST.map((vcs) => {
      const resource = data[vcs.key];
      const samples = resource ? resource[side] : [];
      const first = samples[0]?.t ?? 0;
      const last = samples[samples.length - 1]?.t ?? 0;
      const span = last - first;

      const points = samples.map((s) => ({
        // Normalize elapsed time to 0-100% so VCS runs of different durations
        // line up on the same X axis.
        x: span > 0 ? ((s.t - first) / span) * 100 : 0,
        y: metric === "cpu" ? s.cpu_pct : s.ram_gb,
      }));

      return {
        label: vcs.label,
        data: points,
        borderColor: vcs.color,
        backgroundColor: vcs.color,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.3,
      };
    });

    return { datasets };
  }, [data, side, metric]);

  const options = useMemo<ChartOptions<"line">>(() => {
    const axisColor = "#8B8B9E";
    const gridColor = "rgba(255, 255, 255, 0.08)";
    return {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: 100,
          title: {
            display: true,
            text: "Operation progress (% of time)",
            color: axisColor,
          },
          ticks: {
            color: axisColor,
            callback: (value) => `${value}%`,
          },
          grid: { color: gridColor },
        },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: metric === "cpu" ? "CPU usage (%)" : "RAM usage (GB)",
            color: axisColor,
          },
          ticks: { color: axisColor },
          grid: { color: gridColor },
        },
      },
      plugins: {
        legend: {
          labels: { color: "#ededed", usePointStyle: true, boxWidth: 8 },
        },
        // Series are sampled independently and don't line up on the X axis,
        // so a hover tooltip would be misleading. Disabled intentionally.
        tooltip: { enabled: false },
      },
    };
  }, [metric]);

  return (
    <div className="glass rounded-2xl p-6 sm:p-8">
      <div className="mb-6 text-center">
        <h3 className="text-lg font-semibold mb-1">Resource usage over time</h3>
        <p className="text-sm text-muted">
          CPU and memory consumption during submit (normalized)
        </p>
      </div>
      {/* Selectors */}
      <div className="flex flex-wrap items-start justify-center gap-6 mb-8 mt-1">
        <PillGroup
          label="Machine"
          options={SIDE_OPTIONS}
          value={side}
          onChange={setSide}
        />
        <PillGroup
          label="Metric"
          options={METRIC_OPTIONS}
          value={metric}
          onChange={setMetric}
        />
      </div>

      {/* Chart */}
      <div className="relative h-[360px] sm:h-[440px]">
        {status === "error" ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            Couldn&apos;t load benchmark data.
          </div>
        ) : (
          <>
            <Line data={chartData} options={options} />
            {status === "loading" && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/40 backdrop-blur-sm rounded-xl">
                <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
