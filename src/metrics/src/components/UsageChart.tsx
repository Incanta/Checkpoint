"use client";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
);

export interface UsageChartProps {
  labels: string[];
  instances: number[];
  users: number[];
}

const options: ChartOptions<"line"> = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: { labels: { color: "#8b94a7", usePointStyle: true } },
  },
  scales: {
    x: {
      grid: { color: "#232a39" },
      ticks: { color: "#8b94a7" },
    },
    yInstances: {
      type: "linear",
      position: "left",
      beginAtZero: true,
      grid: { color: "#232a39" },
      ticks: { color: "#8b94a7", precision: 0 },
      title: { display: true, text: "Active instances", color: "#8b94a7" },
    },
    yUsers: {
      type: "linear",
      position: "right",
      beginAtZero: true,
      grid: { drawOnChartArea: false },
      ticks: { color: "#8b94a7", precision: 0 },
      title: { display: true, text: "Users", color: "#8b94a7" },
    },
  },
};

export function UsageChart({ labels, instances, users }: UsageChartProps) {
  const data = {
    labels,
    datasets: [
      {
        label: "Active instances",
        data: instances,
        yAxisID: "yInstances",
        borderColor: "#5b8cff",
        backgroundColor: "rgba(91, 140, 255, 0.15)",
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      },
      {
        label: "Users",
        data: users,
        yAxisID: "yUsers",
        borderColor: "#36d399",
        backgroundColor: "rgba(54, 211, 153, 0.12)",
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      },
    ],
  };

  return (
    <div className="chart-box">
      <Line options={options} data={data} />
    </div>
  );
}
