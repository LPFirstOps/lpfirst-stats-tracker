import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Env } from "./auth";

type MetricRow = {
  tab?: string;
  assignmentType?: string;
  metric: string;
  value?: number | null;
  textValue?: string | null;
};

export type IngestBody = {
  company: string; // org slug: aaction | icon | moyers
  source: string; // cc | sedgwick | alacrity
  location?: string;
  date: string; // YYYY-MM-DD, or YYYY for CC yearly aggregates
  payload: unknown;
  metrics: MetricRow[];
};

const CHUNK = 40;

export async function handleIngest(env: Env, body: IngestBody): Promise<{ ok: boolean; error?: string; inserted?: number }> {
  const db = drizzle(env.DB, { schema });
  const { company, source, date } = body;
  const location = body.location ?? "";

  if (!company || !source || !date) return { ok: false, error: "company, source, date required" };

  const org = await db.select().from(schema.organization).where(eq(schema.organization.slug, company)).get();
  if (!org) return { ok: false, error: `unknown company: ${company}` };

  const now = Date.now();

  // Upsert raw snapshot
  await db
    .insert(schema.snapshots)
    .values({
      organizationId: org.id,
      source,
      location,
      date,
      payload: JSON.stringify(body.payload ?? {}),
      createdAt: new Date(now)
    })
    .onConflictDoUpdate({
      target: [schema.snapshots.organizationId, schema.snapshots.source, schema.snapshots.location, schema.snapshots.date],
      set: { payload: JSON.stringify(body.payload ?? {}), createdAt: new Date(now) }
    });

  // Replace metric rows for this snapshot key
  await db
    .delete(schema.metrics)
    .where(
      and(
        eq(schema.metrics.organizationId, org.id),
        eq(schema.metrics.source, source),
        eq(schema.metrics.location, location),
        eq(schema.metrics.date, date)
      )
    );

  const rows = (body.metrics ?? []).map((m) => ({
    organizationId: org.id,
    source,
    location,
    date,
    tab: m.tab ?? "",
    assignmentType: m.assignmentType ?? "",
    metric: m.metric,
    value: typeof m.value === "number" && Number.isFinite(m.value) ? m.value : null,
    textValue: m.textValue ?? null,
    updatedAt: new Date(now)
  }));

  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(schema.metrics).values(rows.slice(i, i + CHUNK));
  }

  return { ok: true, inserted: rows.length };
}
