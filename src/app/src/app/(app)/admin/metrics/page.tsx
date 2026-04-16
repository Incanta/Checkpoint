"use client";

import { useState, useMemo } from "react";
import { api } from "~/trpc/react";
import { Card, PageHeader } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { AdminTabs } from "../_components/admin-tabs";
import { notFound } from "next/navigation";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
);

const RANGE_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "365d", days: 365 },
] as const;

const COLORS = {
  blue: "rgb(59, 130, 246)",
  green: "rgb(34, 197, 94)",
  red: "rgb(239, 68, 68)",
  purple: "rgb(168, 85, 247)",
  amber: "rgb(245, 158, 11)",
  cyan: "rgb(6, 182, 212)",
  blueFill: "rgba(59, 130, 246, 0.1)",
  greenFill: "rgba(34, 197, 94, 0.1)",
  redFill: "rgba(239, 68, 68, 0.1)",
  purpleFill: "rgba(168, 85, 247, 0.1)",
  amberFill: "rgba(245, 158, 11, 0.1)",
  cyanFill: "rgba(6, 182, 212, 0.1)",
};

function formatShortDate(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

const sharedLineOptions: ChartOptions<"line"> = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: {
      position: "bottom",
      labels: {
        usePointStyle: true,
        pointStyle: "circle",
        padding: 16,
        color: "rgb(156, 163, 175)",
        font: { size: 12 },
      },
    },
    tooltip: {
      backgroundColor: "rgb(17, 24, 39)",
      titleColor: "rgb(229, 231, 235)",
      bodyColor: "rgb(229, 231, 235)",
      padding: 10,
      cornerRadius: 6,
      titleFont: { size: 12 },
      bodyFont: { size: 12 },
    },
  },
  scales: {
    x: {
      grid: { display: false },
      ticks: { color: "rgb(107, 114, 128)", font: { size: 11 } },
    },
    y: {
      beginAtZero: true,
      grid: { color: "rgba(107, 114, 128, 0.15)" },
      ticks: {
        color: "rgb(107, 114, 128)",
        font: { size: 11 },
        precision: 0,
      },
    },
  },
};

const sharedBarOptions: ChartOptions<"bar"> = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "rgb(17, 24, 39)",
      titleColor: "rgb(229, 231, 235)",
      bodyColor: "rgb(229, 231, 235)",
      padding: 10,
      cornerRadius: 6,
    },
  },
  scales: {
    x: {
      grid: { display: false },
      ticks: { color: "rgb(107, 114, 128)", font: { size: 11 } },
      title: {
        display: true,
        color: "rgb(107, 114, 128)",
        font: { size: 12 },
      },
    },
    y: {
      beginAtZero: true,
      grid: { color: "rgba(107, 114, 128, 0.15)" },
      ticks: {
        color: "rgb(107, 114, 128)",
        font: { size: 11 },
        precision: 0,
      },
      title: {
        display: true,
        text: "Number of Orgs",
        color: "rgb(107, 114, 128)",
        font: { size: 12 },
      },
    },
  },
};

type MetricsRow = {
  date: Date;
  activeTrials: number;
  activeSubscriptions: number;
  delinquentSubs: number;
  totalUsers: number;
  activeOrgs: number;
  activeRepos: number;
  orgUsersHistogram: unknown;
  reposPerOrgHistogram: unknown;
};

export default function AdminMetricsPage() {
  useDocumentTitle("Admin · Metrics");
  const { data: user, isLoading: userLoading } = api.user.me.useQuery();
  const [rangeDays, setRangeDays] = useState(30);

  const { data: metrics, isLoading } = api.admin.getDailyMetrics.useQuery(
    { from: daysAgo(rangeDays), limit: rangeDays },
    { enabled: !!user?.checkpointAdmin },
  );

  if (!userLoading && !user?.checkpointAdmin) {
    notFound();
  }

  // Reverse so oldest first for charts (API returns desc)
  const rows = useMemo(
    () => (metrics ? [...metrics].reverse() : []) as MetricsRow[],
    [metrics],
  );

  const labels = useMemo(
    () => rows.map((r) => formatShortDate(r.date)),
    [rows],
  );

  const latestRow = rows.length > 0 ? rows[rows.length - 1] : null;

  // Merge all histogram data across the range for the latest snapshot
  const latestOrgUsersHist = latestRow
    ? (latestRow.orgUsersHistogram as Record<string, number> | null)
    : null;
  const latestReposHist = latestRow
    ? (latestRow.reposPerOrgHistogram as Record<string, number> | null)
    : null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Admin" description="Platform metrics over time" />
      <AdminTabs />

      {/* Range selector */}
      <div className="mb-6 flex gap-2">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.days}
            onClick={() => setRangeDays(opt.days)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              rangeDays === opt.days
                ? "bg-[var(--color-accent)] text-white"
                : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-64 animate-pulse rounded-lg bg-[var(--color-bg-secondary)]"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <div className="py-12 text-center text-sm text-[var(--color-text-muted)]">
            No metrics data yet. Metrics are collected daily.
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Summary cards */}
          {latestRow && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                label="Trials"
                value={latestRow.activeTrials}
                color={COLORS.blue}
              />
              <StatCard
                label="Active Subs"
                value={latestRow.activeSubscriptions}
                color={COLORS.green}
              />
              <StatCard
                label="Delinquent"
                value={latestRow.delinquentSubs}
                color={COLORS.red}
              />
              <StatCard
                label="Users"
                value={latestRow.totalUsers}
                color={COLORS.purple}
              />
              <StatCard
                label="Orgs"
                value={latestRow.activeOrgs}
                color={COLORS.amber}
              />
              <StatCard
                label="Repos"
                value={latestRow.activeRepos}
                color={COLORS.cyan}
              />
            </div>
          )}

          {/* Subscriptions chart */}
          <Card>
            <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
              Subscriptions
            </h3>
            <div className="h-64">
              <Line
                data={{
                  labels,
                  datasets: [
                    {
                      label: "Active Trials",
                      data: rows.map((r) => r.activeTrials),
                      borderColor: COLORS.blue,
                      backgroundColor: COLORS.blueFill,
                      fill: true,
                      tension: 0.3,
                      pointRadius: rows.length > 60 ? 0 : 3,
                    },
                    {
                      label: "Active Subscriptions",
                      data: rows.map((r) => r.activeSubscriptions),
                      borderColor: COLORS.green,
                      backgroundColor: COLORS.greenFill,
                      fill: true,
                      tension: 0.3,
                      pointRadius: rows.length > 60 ? 0 : 3,
                    },
                    {
                      label: "Delinquent",
                      data: rows.map((r) => r.delinquentSubs),
                      borderColor: COLORS.red,
                      backgroundColor: COLORS.redFill,
                      fill: true,
                      tension: 0.3,
                      pointRadius: rows.length > 60 ? 0 : 3,
                    },
                  ],
                }}
                options={sharedLineOptions}
              />
            </div>
          </Card>

          {/* Users, Orgs, Repos chart */}
          <Card>
            <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
              Growth
            </h3>
            <div className="h-64">
              <Line
                data={{
                  labels,
                  datasets: [
                    {
                      label: "Users",
                      data: rows.map((r) => r.totalUsers),
                      borderColor: COLORS.purple,
                      backgroundColor: COLORS.purpleFill,
                      fill: true,
                      tension: 0.3,
                      pointRadius: rows.length > 60 ? 0 : 3,
                    },
                    {
                      label: "Active Orgs",
                      data: rows.map((r) => r.activeOrgs),
                      borderColor: COLORS.amber,
                      backgroundColor: COLORS.amberFill,
                      fill: true,
                      tension: 0.3,
                      pointRadius: rows.length > 60 ? 0 : 3,
                    },
                    {
                      label: "Active Repos",
                      data: rows.map((r) => r.activeRepos),
                      borderColor: COLORS.cyan,
                      backgroundColor: COLORS.cyanFill,
                      fill: true,
                      tension: 0.3,
                      pointRadius: rows.length > 60 ? 0 : 3,
                    },
                  ],
                }}
                options={sharedLineOptions}
              />
            </div>
          </Card>

          {/* Histograms — latest snapshot */}
          <div className="grid gap-6 lg:grid-cols-2">
            {latestOrgUsersHist &&
              Object.keys(latestOrgUsersHist).length > 0 && (
                <Card>
                  <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
                    Members per Org (latest)
                  </h3>
                  <div className="h-56">
                    <HistogramChart
                      data={latestOrgUsersHist}
                      xLabel="Members"
                      color={COLORS.amber}
                    />
                  </div>
                </Card>
              )}
            {latestReposHist && Object.keys(latestReposHist).length > 0 && (
              <Card>
                <h3 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">
                  Repos per Org (latest)
                </h3>
                <div className="h-56">
                  <HistogramChart
                    data={latestReposHist}
                    xLabel="Repos"
                    color={COLORS.cyan}
                  />
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <Card>
      <div className="text-2xl font-bold" style={{ color }}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
    </Card>
  );
}

function HistogramChart({
  data,
  xLabel,
  color,
}: {
  data: Record<string, number>;
  xLabel: string;
  color: string;
}) {
  const sortedKeys = Object.keys(data).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10),
  );

  const options = useMemo(
    (): ChartOptions<"bar"> => ({
      ...sharedBarOptions,
      scales: {
        ...sharedBarOptions.scales,
        x: {
          ...sharedBarOptions.scales?.x,
          title: {
            ...((sharedBarOptions.scales?.x as Record<string, unknown>)
              ?.title as Record<string, unknown>),
            text: xLabel,
          },
        },
      },
    }),
    [xLabel],
  );

  return (
    <Bar
      data={{
        labels: sortedKeys,
        datasets: [
          {
            data: sortedKeys.map((k) => data[k]!),
            backgroundColor: color
              .replace("rgb", "rgba")
              .replace(")", ", 0.6)"),
            borderColor: color,
            borderWidth: 1,
            borderRadius: 3,
          },
        ],
      }}
      options={options}
    />
  );
}
