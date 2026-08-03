import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Env } from "../auth";
import { ALBI_PATHS } from "./client";
import { getAlbiConfig, albiClientFor } from "./sync";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Build a human-readable scorecard summary for a company from the latest
 * synced metrics (Sedgwick scores vs state average + CC summary numbers).
 */
export async function buildScorecardText(db: Db, organizationId: string, orgName: string): Promise<string> {
  const lines: string[] = [`${orgName} — carrier scorecard update`];

  // Latest Sedgwick date
  const latestSedgwick = await db
    .select({ date: sql<string>`max(${schema.metrics.date})` })
    .from(schema.metrics)
    .where(and(eq(schema.metrics.organizationId, organizationId), eq(schema.metrics.source, "sedgwick")))
    .get();

  if (latestSedgwick?.date) {
    const rows = await db
      .select()
      .from(schema.metrics)
      .where(
        and(
          eq(schema.metrics.organizationId, organizationId),
          eq(schema.metrics.source, "sedgwick"),
          eq(schema.metrics.date, latestSedgwick.date),
          sql`${schema.metrics.metric} LIKE 'score.%'`
        )
      )
      .all();
    const byType: Record<string, { my?: number | null; state?: number | null }> = {};
    for (const r of rows) {
      const m = r.metric.match(/^score\.(.+)\.(myScore|stateAvg)$/);
      if (!m) continue;
      byType[m[1]] = byType[m[1]] ?? {};
      (byType[m[1]] as any)[m[2] === "myScore" ? "my" : "state"] = r.value;
    }
    const parts = Object.entries(byType).map(([wt, v]) => {
      const delta = v.my != null && v.state != null ? (v.my - v.state >= 0 ? "+" : "") + (v.my - v.state).toFixed(2) : "?";
      return `${wt}: ${v.my ?? "?"} (state ${v.state ?? "?"}, ${delta})`;
    });
    if (parts.length) lines.push(`Sedgwick ${latestSedgwick.date}: ${parts.join("; ")}`);
  }

  // Latest CC summary
  const latestCc = await db
    .select({ date: sql<string>`max(${schema.metrics.date})` })
    .from(schema.metrics)
    .where(
      and(
        eq(schema.metrics.organizationId, organizationId),
        eq(schema.metrics.source, "cc"),
        sql`length(${schema.metrics.date}) = 10`
      )
    )
    .get();

  if (latestCc?.date) {
    const rows = await db
      .select()
      .from(schema.metrics)
      .where(
        and(
          eq(schema.metrics.organizationId, organizationId),
          eq(schema.metrics.source, "cc"),
          eq(schema.metrics.date, latestCc.date),
          sql`${schema.metrics.metric} LIKE 'summary.%'`
        )
      )
      .limit(12)
      .all();
    const parts = rows
      .filter((r) => r.value != null)
      .map((r) => `${r.metric.replace("summary.", "")}: ${r.value}`);
    if (parts.length) lines.push(`ContractorConnection ${latestCc.date}: ${parts.join("; ")}`);
  }

  if (lines.length === 1) lines.push("No scorecard metrics synced yet.");
  return lines.join("\n");
}

/**
 * Push a scorecard summary into Albi — as a project note when a project id is
 * given, otherwise as a CRM activity. Payload field names are best-effort;
 * verify against albi.readme.io on first use.
 */
export async function pushScorecardToAlbi(
  env: Env,
  organizationId: string,
  orgName: string,
  opts: { albiProjectId?: string; text?: string } = {}
) {
  const db = drizzle(env.DB, { schema });
  const cfg = await getAlbiConfig(db, organizationId);
  if (!cfg || !cfg.enabled) return { ok: false as const, error: "Albi not configured for this company" };

  const text = opts.text ?? (await buildScorecardText(db, organizationId, orgName));
  const client = albiClientFor(cfg);

  if (opts.albiProjectId) {
    await client.request(ALBI_PATHS.createNote, {
      body: { projectId: opts.albiProjectId, note: text, text }
    });
    return { ok: true as const, target: `project ${opts.albiProjectId} note`, text };
  }

  await client.request(ALBI_PATHS.createActivity, {
    body: { title: `${orgName} scorecard update`, description: text, note: text, type: "Note" }
  });
  return { ok: true as const, target: "activity", text };
}
