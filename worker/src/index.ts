import { Hono } from "hono";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, asc, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import { createAuth, type Env } from "./auth";
import { handleIngest, type IngestBody } from "./ingest";
import { handleMcp } from "./mcp";
import { accessibleOrgs, findOrg } from "./rbac";

const app = new Hono<{ Bindings: Env }>();

// --- OAuth discovery (MCP clients hit these root paths directly) -----------
app.get("/.well-known/oauth-authorization-server", (c) =>
  oAuthDiscoveryMetadata(createAuth(c.env))(c.req.raw)
);
app.get("/.well-known/oauth-protected-resource", (c) =>
  oAuthProtectedResourceMetadata(createAuth(c.env))(c.req.raw)
);

// --- Better Auth (sign-in/up, org management, invitations, OAuth/MCP) ------
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

// --- Session helper --------------------------------------------------------
async function getSession(c: any) {
  const auth = createAuth(c.env);
  return auth.api.getSession({ headers: c.req.raw.headers });
}

// --- API -------------------------------------------------------------------

app.get("/api/me", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const db = drizzle(c.env.DB, { schema });
  const companies = await accessibleOrgs(db, session.user.id);
  const { id, name, email, role } = session.user as any;
  return c.json({ user: { id, name, email, role: role ?? "user" }, companies });
});

// Tidy metric rows with filters. Same shape the MCP query_metrics tool returns.
app.get("/api/metrics", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const db = drizzle(c.env.DB, { schema });
  const orgs = await accessibleOrgs(db, session.user.id);

  const q = c.req.query();
  const org = q.company ? findOrg(orgs, q.company) : null;
  if (!org) return c.json({ error: "unknown or inaccessible company" }, 403);

  const conds = [eq(schema.metrics.organizationId, org.id)];
  if (q.source) conds.push(eq(schema.metrics.source, q.source));
  if (q.location) conds.push(eq(schema.metrics.location, q.location));
  if (q.tab) conds.push(eq(schema.metrics.tab, q.tab));
  if (q.type) conds.push(eq(schema.metrics.assignmentType, q.type));
  if (q.from) conds.push(sql`${schema.metrics.date} >= ${q.from}`);
  if (q.to) conds.push(sql`${schema.metrics.date} <= ${q.to}`);

  const rows = await db
    .select()
    .from(schema.metrics)
    .where(and(...conds))
    .orderBy(asc(schema.metrics.date))
    .limit(Math.min(parseInt(q.limit ?? "2000", 10) || 2000, 10000))
    .all();
  return c.json(rows);
});

// Freshness/coverage per source+location for one company.
app.get("/api/summary", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const db = drizzle(c.env.DB, { schema });
  const orgs = await accessibleOrgs(db, session.user.id);
  const org = findOrg(orgs, c.req.query("company") ?? "");
  if (!org) return c.json({ error: "unknown or inaccessible company" }, 403);

  const rows = await db
    .select({
      source: schema.snapshots.source,
      location: schema.snapshots.location,
      latest: sql<string>`max(${schema.snapshots.date})`,
      count: sql<number>`count(*)`
    })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.organizationId, org.id))
    .groupBy(schema.snapshots.source, schema.snapshots.location)
    .all();
  return c.json(rows);
});

/**
 * Reassembles the legacy stats.json `statsData` shape from D1, scoped to the
 * caller's companies, so the existing dashboard can be ported by swapping its
 * decrypt-in-browser block for `fetch("/api/statsdata")`.
 *
 *   aaction  -> root keys (years, dailySnapshots, sedgwick, alacrity)
 *   moyers   -> statsData.moyers
 *   icon     -> statsData.icon.locations[key].dailySnapshots
 */
app.get("/api/statsdata", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const db = drizzle(c.env.DB, { schema });
  const orgs = await accessibleOrgs(db, session.user.id);

  const out: any = { lastUpdated: null };
  const LOC_LABELS: Record<string, string> = {
    rochester: "Rochester",
    rockwood: "Rockwood",
    lansing: "Lansing"
  };

  for (const org of orgs) {
    const rows = await db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.organizationId, org.id))
      .orderBy(asc(schema.snapshots.date))
      .all();

    let target: any;
    if (org.slug === "aaction") target = out;
    else target = out[org.slug] = out[org.slug] ?? {};

    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      if (row.createdAt && (!out.lastUpdated || row.createdAt.toISOString() > out.lastUpdated)) {
        out.lastUpdated = row.createdAt.toISOString();
      }
      if (org.slug === "icon") {
        target.locations = target.locations ?? {};
        const key = row.location || "default";
        target.locations[key] = target.locations[key] ?? { label: LOC_LABELS[key] ?? key, dailySnapshots: [] };
        target.locations[key].dailySnapshots.push(payload);
      } else if (row.source === "cc") {
        if (row.date.length === 4) {
          target.years = target.years ?? {};
          target.years[row.date] = payload;
        } else {
          target.dailySnapshots = target.dailySnapshots ?? [];
          target.dailySnapshots.push(payload);
        }
      } else {
        target[row.source] = target[row.source] ?? { dailySnapshots: [] };
        target[row.source].dailySnapshots.push(payload);
      }
    }
  }
  return c.json(out);
});

// --- Ingest (GitHub Actions scraper -> D1) ---------------------------------
app.post("/api/ingest", async (c) => {
  const authz = c.req.header("authorization") ?? "";
  if (!c.env.INGEST_TOKEN || authz !== `Bearer ${c.env.INGEST_TOKEN}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = (await c.req.json()) as IngestBody;
  const result = await handleIngest(c.env, body);
  return c.json(result, result.ok ? 200 : 400);
});

// --- MCP -------------------------------------------------------------------
app.all("/mcp", handleMcp);

export default app;
