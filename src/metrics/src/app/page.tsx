import { getDashboardData } from "~/lib/aggregate";
import { UsageChart } from "~/components/UsageChart";

// Always render fresh from the database.
export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export default async function DashboardPage() {
  const data = await getDashboardData(new Date());
  const { instances, totals, weekly } = data;

  return (
    <main className="wrap">
      <div className="header">
        <h1>Checkpoint Telemetry</h1>
        <p>
          Anonymous usage reported weekly by self-hosted Checkpoint instances.
        </p>
      </div>

      <section className="cards">
        <div className="card">
          <div className="label">Instances</div>
          <div className="value">{formatNumber(totals.instances)}</div>
        </div>
        <div className="card">
          <div className="label">Organizations</div>
          <div className="value">{formatNumber(totals.orgs)}</div>
        </div>
        <div className="card">
          <div className="label">Repositories</div>
          <div className="value">{formatNumber(totals.repos)}</div>
        </div>
        <div className="card">
          <div className="label">Users</div>
          <div className="value">{formatNumber(totals.users)}</div>
        </div>
      </section>

      <section className="panel">
        <h2>Last 12 weeks</h2>
        <UsageChart
          labels={weekly.map((w) => w.label)}
          instances={weekly.map((w) => w.activeInstances)}
          users={weekly.map((w) => w.users)}
        />
      </section>

      <section className="panel">
        <h2>Instances</h2>
        {instances.length === 0 ? (
          <p className="empty">No reports received yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Instance</th>
                <th className="num">Orgs</th>
                <th className="num">Repos</th>
                <th className="num">Users</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((i) => (
                <tr key={i.instanceId}>
                  <td className="mono">{shortId(i.instanceId)}</td>
                  <td className="num">{formatNumber(i.orgCount)}</td>
                  <td className="num">{formatNumber(i.repoCount)}</td>
                  <td className="num">{formatNumber(i.userCount)}</td>
                  <td>{formatDate(i.lastReportedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
