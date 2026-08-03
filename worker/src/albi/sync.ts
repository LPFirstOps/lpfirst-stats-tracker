import { drizzle } from "drizzle-orm/d1";
import { and, eq, desc } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Env } from "../auth";
import { AlbiClient, ALBI_PATHS, listItems, pick } from "./client";

const CHUNK = 40;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
// Cap KPI fetches per sync run to stay well inside Workers' subrequest limit.
const MAX_KPI_FETCH = 200;

type Db = ReturnType<typeof drizzle<typeof schema>>;

function flattenKpis(node: any, prefix: string, out: { metric: string; value: number | null; textValue: string | null }[]) {
  if (node == null) return out;
  const t = typeof node;
  if (t === "number") {
    if (Number.isFinite(node)) out.push({ metric: prefix, value: node, textValue: null });
    return out;
  }
  if (t === "boolean") {
    out.push({ metric: prefix, value: node ? 1 : 0, textValue: null });
    return out;
  }
  if (t === "string") {
    const cleaned = (node as string).replace(/[$,%\s,]/g, "");
    const n = cleaned !== "" && !isNaN(cleaned as any) ? parseFloat(cleaned) : null;
    out.push({ metric: prefix, value: n, textValue: node as string });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => flattenKpis(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (t === "object") {
    for (const [k, v] of Object.entries(node)) {
      flattenKpis(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

export async function getAlbiConfig(db: Db, organizationId: string) {
  return db.select().from(schema.albiConfig).where(eq(schema.albiConfig.organizationId, organizationId)).get();
}

export function albiClientFor(cfg: { apiKey: string; authHeader: string | null }) {
  return new AlbiClient({ apiKey: cfg.apiKey, authHeader: cfg.authHeader });
}

async function upsertProject(db: Db, organizationId: string, p: any, now: number): Promise<string | null> {
  const albiId = String(pick(p, "id", "projectId", "albiId") ?? "");
  if (!albiId) return null;
  const addr = pick(p, "address", "projectAddress", "location");
  await db
    .insert(schema.albiProjects)
    .values({
      organizationId,
      albiId,
      name: pick(p, "name", "projectName", "title"),
      status: pick(p, "status", "projectStatus", "statusName"),
      address: typeof addr === "object" ? JSON.stringify(addr) : addr,
      receivedDate: pick(p, "receivedDate", "dateReceived", "createdAt", "createdDate"),
      payload: JSON.stringify(p),
      syncedAt: new Date(now)
    })
    .onConflictDoUpdate({
      target: [schema.albiProjects.organizationId, schema.albiProjects.albiId],
      set: {
        name: pick(p, "name", "projectName", "title"),
        status: pick(p, "status", "projectStatus", "statusName"),
        address: typeof addr === "object" ? JSON.stringify(addr) : addr,
        receivedDate: pick(p, "receivedDate", "dateReceived", "createdAt", "createdDate"),
        payload: JSON.stringify(p),
        syncedAt: new Date(now)
      }
    });
  return albiId;
}

async function syncProjectKpis(db: Db, client: AlbiClient, organizationId: string, albiId: string, now: number) {
  const kpi = await client.get(ALBI_PATHS.projectFinancialKpi(albiId));
  const rows = flattenKpis(kpi, "", []);
  await db
    .delete(schema.albiProjectKpis)
    .where(and(eq(schema.albiProjectKpis.organizationId, organizationId), eq(schema.albiProjectKpis.albiProjectId, albiId)));
  const values = rows.map((r) => ({
    organizationId,
    albiProjectId: albiId,
    metric: r.metric,
    value: r.value,
    textValue: r.textValue,
    syncedAt: new Date(now)
  }));
  for (let i = 0; i < values.length; i += CHUNK) {
    await db.insert(schema.albiProjectKpis).values(values.slice(i, i + CHUNK));
  }
  return values.length;
}

/** Full org sync: all projects, then financial KPIs for the newest N. */
export async function syncAlbiOrg(env: Env, organizationId: string) {
  const db = drizzle(env.DB, { schema });
  const cfg = await getAlbiConfig(db, organizationId);
  if (!cfg || !cfg.enabled) return { ok: false as const, error: "Albi not configured for this company" };

  const client = albiClientFor(cfg);
  const now = Date.now();

  // Page through projects; tolerate APIs that ignore paging params.
  const projects: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.get(ALBI_PATHS.projectsGetAll, { page, pageSize: PAGE_SIZE });
    const items = listItems(res);
    if (!items.length) break;
    if (page > 1 && projects.length && pick(items[0], "id", "projectId") === pick(projects[0], "id", "projectId")) break;
    projects.push(...items);
    if (items.length < PAGE_SIZE) break;
  }

  const ids: string[] = [];
  for (const p of projects) {
    const id = await upsertProject(db, organizationId, p, now);
    if (id) ids.push(id);
  }

  // KPIs for the most recent projects first (bounded per run).
  const recent = await db
    .select({ albiId: schema.albiProjects.albiId })
    .from(schema.albiProjects)
    .where(eq(schema.albiProjects.organizationId, organizationId))
    .orderBy(desc(schema.albiProjects.receivedDate))
    .limit(MAX_KPI_FETCH)
    .all();

  let kpiRows = 0;
  let kpiErrors = 0;
  for (const { albiId } of recent) {
    try {
      kpiRows += await syncProjectKpis(db, client, organizationId, albiId, now);
    } catch (e) {
      kpiErrors++;
      if (kpiErrors <= 3) console.error(`albi kpi sync failed for ${albiId}:`, (e as Error).message);
      if (kpiErrors > 20) break; // endpoint path likely wrong; stop hammering
    }
  }

  await db
    .update(schema.albiConfig)
    .set({ lastSyncAt: new Date(now), updatedAt: new Date(now) })
    .where(eq(schema.albiConfig.organizationId, organizationId));

  return { ok: true as const, projects: ids.length, kpiRows, kpiErrors };
}

/** Refresh one project (webhook-driven). */
export async function syncAlbiProject(env: Env, organizationId: string, albiId: string) {
  const db = drizzle(env.DB, { schema });
  const cfg = await getAlbiConfig(db, organizationId);
  if (!cfg || !cfg.enabled) return { ok: false as const, error: "Albi not configured" };
  const client = albiClientFor(cfg);
  const now = Date.now();
  const p = await client.get(ALBI_PATHS.projectById(albiId));
  const id = await upsertProject(db, organizationId, (p as any)?.data ?? p, now);
  let kpiRows = 0;
  if (id) {
    try {
      kpiRows = await syncProjectKpis(db, client, organizationId, id, now);
    } catch {
      /* KPI endpoint optional */
    }
  }
  return { ok: true as const, albiId: id, kpiRows };
}

/** Cron entrypoint: sync every enabled org sequentially. */
export async function syncAllAlbi(env: Env) {
  const db = drizzle(env.DB, { schema });
  const configs = await db.select().from(schema.albiConfig).where(eq(schema.albiConfig.enabled, true)).all();
  const results: Record<string, unknown> = {};
  for (const cfg of configs) {
    try {
      results[cfg.organizationId] = await syncAlbiOrg(env, cfg.organizationId);
    } catch (e) {
      results[cfg.organizationId] = { ok: false, error: (e as Error).message };
    }
  }
  console.log("albi cron sync:", JSON.stringify(results));
  return results;
}
