"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BenchmarkTests,
  type BenchmarkTest,
  type Entry,
  type Segment,
} from "@/components/benchmark-bars";

// Shape of website/public/benchmark-results/<ram>gb-ram/timings.<vcs>.json
interface Phases {
  add_all: number | null;
  commit_all: number | null;
  submit_all: number | null;
  pull_elsewhere: number | null;
}

interface Timings {
  vcs: string;
  phases: Phases;
}

type Ram = "16" | "32" | "64";

const RAM_OPTIONS: { value: Ram; label: string }[] = [
  { value: "16", label: "16 GB" },
  { value: "32", label: "32 GB" },
  { value: "64", label: "64 GB" },
];

// Order is just the fetch order; bars are sorted by time below. Checkpoint is
// flagged isUs so it renders in the brand purple, competitors in grey.
const VCS_LIST: { key: string; name: string; isUs?: boolean }[] = [
  { key: "checkpoint", name: "Checkpoint", isUs: true },
  { key: "lore", name: "Lore" },
  { key: "ark", name: "Ark" },
  { key: "perforce", name: "Perforce" },
  { key: "gitea", name: "* Gitea" },
];

function buildEntries(timings: Record<string, Timings>): BenchmarkTest[] {
  const submit: Entry[] = [];
  const pull: Entry[] = [];

  for (const vcs of VCS_LIST) {
    const t = timings[vcs.key];
    if (!t) continue;
    const p = t.phases;

    // Submit (Upload) = add + commit + submit, shown as segments when more
    // than one phase contributed.
    const parts: Segment[] = [
      { label: "Add", seconds: p.add_all ?? 0 },
      { label: "Commit", seconds: p.commit_all ?? 0 },
      { label: "Submit", seconds: p.submit_all ?? 0 },
    ].filter((s) => s.seconds > 0);
    const submitTotal = parts.reduce((sum, s) => sum + s.seconds, 0);
    submit.push({
      name: vcs.name,
      seconds: submitTotal,
      isUs: vcs.isUs,
      segments: parts.length > 1 ? parts : undefined,
    });

    // Pull (Sync) = pull_elsewhere only, as a solid bar.
    pull.push({
      name: vcs.name,
      seconds: p.pull_elsewhere ?? 0,
      isUs: vcs.isUs,
    });
  }

  // Checkpoint always pins to the top; everyone else sorts by time ascending.
  const ordered = (a: Entry, b: Entry) => {
    if (a.isUs !== b.isUs) return a.isUs ? -1 : 1;
    return a.seconds - b.seconds;
  };
  return [
    { label: "Submit (Upload)", entries: submit.sort(ordered) },
    { label: "Pull (Sync)", entries: pull.sort(ordered) },
  ];
}

export default function LanBenchmarks() {
  const [ram, setRam] = useState<Ram>("32");
  const [data, setData] = useState<Record<string, Timings>>({});
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
              `/benchmark-results/${ram}gb-ram/timings.${vcs.key}.json`,
            );
            if (!res.ok) throw new Error(`${vcs.key}: ${res.status}`);
            return [vcs.key, (await res.json()) as Timings] as const;
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
  }, [ram]);

  const tests = useMemo(() => buildEntries(data), [data]);
  const maxSeconds = useMemo(
    () => Math.max(0, ...tests.flatMap((t) => t.entries.map((e) => e.seconds))),
    [tests],
  );

  const hasData = tests.some((t) => t.entries.length > 0);

  return (
    <div className="glass rounded-2xl p-8 relative">
      {/* RAM selector, pinned top-right so it doesn't reflow the header */}
      <div className="absolute top-8 right-8 inline-flex rounded-full glass p-0.5">
        {RAM_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setRam(opt.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
              ram === opt.value
                ? "bg-primary text-white shadow-lg shadow-primary/25"
                : "text-muted hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="mb-6">
        {/* Reserve space only on the title line so it clears the selector;
            the subtitle sits below it and spans the full card width. */}
        <h3 className="text-lg font-semibold mb-1 pr-44">LAN</h3>
        <p className="text-sm text-muted">
          LAN based version control systems • local network server • Jun 2026
        </p>
      </div>

      {status === "error" && !hasData ? (
        <p className="text-sm text-muted py-8 text-center">
          Couldn&apos;t load benchmark data.
        </p>
      ) : (
        <div className={status === "loading" ? "opacity-60" : ""}>
          <BenchmarkTests tests={tests} maxSeconds={maxSeconds} />
        </div>
      )}
    </div>
  );
}
