import { Layout, cardClass } from "./Layout";
import type { OrgAccess } from "../rbac";

export type SummaryRow = { source: string; location: string; latest: string | null; count: number };

/**
 * DASHBOARD PORT (pending): the real Chart.js dashboard source is
 * index.html.bak (gitignored — not in the repo). To port it into this
 * server-rendered page:
 *
 *  1. Move its <body> markup into this component's JSX.
 *  2. Delete the StatiCrypt decrypt block entirely.
 *  3. Keep its chart <script> as the ONE client-side island. Feed it data by
 *     embedding server-side:
 *       <script
 *         dangerouslySetInnerHTML={{ __html: `const statsData = ${JSON.stringify(statsData)};` }}
 *       />
 *     (or have it fetch("/api/statsdata") on load — same shape, already scoped
 *     to the signed-in user's companies.)
 *
 * Everything downstream (getSnapshotsByPeriod, calculateSummary, Chart.js
 * rendering) works unchanged.
 */
export function DashboardPage(props: {
  user: { email: string; superadmin: boolean; admin: boolean };
  companies: Array<{ org: OrgAccess; summary: SummaryRow[] }>;
}) {
  return (
    <Layout title="LP First Stats" user={props.user}>
      <div class="grid gap-4 md:grid-cols-2">
        {props.companies.map(({ org, summary }) => (
          <div class={cardClass}>
            <h2 class="text-lg font-medium mb-3">{org.name}</h2>
            {summary.length === 0 && <p class="text-sm text-slate-500">No data yet.</p>}
            {summary.map((s) => (
              <div class="flex justify-between text-sm py-1 border-b border-slate-800">
                <span>
                  {s.source}
                  {s.location ? ` · ${s.location}` : ""}
                </span>
                <span class="text-slate-400">
                  {s.count} snapshots · latest {s.latest}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Layout>
  );
}
