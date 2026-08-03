import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, gte, lte, like, desc, sql } from "drizzle-orm";
import type { Context } from "hono";
import * as schema from "./db/schema";
import { createAuth, type Env } from "./auth";
import { accessibleOrgs, findOrg, type OrgAccess } from "./rbac";
import { ALBI_PATHS, ALBI_READ_PREFIXES } from "./albi/client";
import { getAlbiConfig, albiClientFor } from "./albi/sync";
import { pushScorecardToAlbi } from "./albi/push";

function unauthorized(baseUrl: string) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized" }, id: null }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
      }
    }
  );
}

export async function handleMcp(c: Context<{ Bindings: Env }>) {
  const auth = createAuth(c.env);
  const session = await auth.api.getMcpSession({ headers: c.req.raw.headers });
  if (!session) return unauthorized(c.env.BASE_URL);

  const db = drizzle(c.env.DB, { schema });
  const orgs = await accessibleOrgs(db, session.userId);

  const server = buildServer(db, orgs, c.env);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
}

function requireOrg(orgs: OrgAccess[], slug: string): OrgAccess {
  const org = findOrg(orgs, slug);
  if (!org) {
    throw new Error(
      `No access to company \"${slug}\". Accessible: ${orgs.map((o) => o.slug).join(", ") || "(none)"}`
    );
  }
  return org;
}

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function albiFor(db: Db, orgId: string) {
  const cfg = await getAlbiConfig(db, orgId);
  if (!cfg || !cfg.enabled) {
    throw new Error("Albi is not configured for this company. An admin can add an API key at /admin.");
  }
  return albiClientFor(cfg);
}

function buildServer(db: Db, orgs: OrgAccess[], env: Env) {
  const server = new McpServer({ name: "lpfirst-stats", version: "1.0.0" });

  // --- Scorecard tools ------------------------------------------------------

  server.tool(
    "list_companies",
    "List the companies (and your role in each) whose contractor stats you can query.",
    {},
    async () => text(orgs)
  );

  server.tool(
    "list_metrics",
    "List distinct scorecard metric names available for a company, optionally filtered by source (cc|sedgwick|alacrity). Use this to discover what query_metrics can return.",
    {
      company: z.string().describe("Company slug, e.g. aaction, icon, moyers"),
      source: z.string().optional()
    },
    async ({ company, source }) => {
      const org = requireOrg(orgs, company);
      const conds = [eq(schema.metrics.organizationId, org.id)];
      if (source) conds.push(eq(schema.metrics.source, source));
      const rows = await db
        .selectDistinct({
          source: schema.metrics.source,
          location: schema.metrics.location,
          tab: schema.metrics.tab,
          metric: schema.metrics.metric
        })
        .from(schema.metrics)
        .where(and(...conds))
        .all();
      return text(rows);
    }
  );

  server.tool(
    "query_metrics",
    "Query carrier scorecard metrics (ContractorConnection/Sedgwick/Alacrity) as tidy rows (date, source, location, tab, assignment_type, metric, value). Dates are YYYY-MM-DD (Central Time); CC yearly aggregates use YYYY.",
    {
      company: z.string().describe("Company slug"),
      source: z.string().optional().describe("cc | sedgwick | alacrity"),
      location: z.string().optional().describe("Icon only: rochester | rockwood | lansing"),
      tab: z.string().optional().describe("CC only: assignments|avgtip|poms|reinspections|surveys|qafeedback"),
      assignment_type: z.string().optional(),
      metric_like: z.string().optional().describe("SQL LIKE pattern on metric name, e.g. %totalAssignments%"),
      from: z.string().optional().describe("Min date inclusive"),
      to: z.string().optional().describe("Max date inclusive"),
      limit: z.number().int().min(1).max(2000).optional()
    },
    async ({ company, source, location, tab, assignment_type, metric_like, from, to, limit }) => {
      const org = requireOrg(orgs, company);
      const conds = [eq(schema.metrics.organizationId, org.id)];
      if (source) conds.push(eq(schema.metrics.source, source));
      if (location) conds.push(eq(schema.metrics.location, location));
      if (tab) conds.push(eq(schema.metrics.tab, tab));
      if (assignment_type) conds.push(eq(schema.metrics.assignmentType, assignment_type));
      if (metric_like) conds.push(like(schema.metrics.metric, metric_like));
      if (from) conds.push(gte(schema.metrics.date, from));
      if (to) conds.push(lte(schema.metrics.date, to));

      const rows = await db
        .select({
          date: schema.metrics.date,
          source: schema.metrics.source,
          location: schema.metrics.location,
          tab: schema.metrics.tab,
          assignment_type: schema.metrics.assignmentType,
          metric: schema.metrics.metric,
          value: schema.metrics.value,
          text_value: schema.metrics.textValue
        })
        .from(schema.metrics)
        .where(and(...conds))
        .orderBy(desc(schema.metrics.date))
        .limit(limit ?? 500)
        .all();
      return text(rows);
    }
  );

  server.tool(
    "get_snapshot",
    "Get the raw scraped scorecard snapshot payload for a company/source/date. Omit date for the most recent.",
    {
      company: z.string(),
      source: z.string().describe("cc | sedgwick | alacrity"),
      location: z.string().optional(),
      date: z.string().optional().describe("YYYY-MM-DD; omit for latest")
    },
    async ({ company, source, location, date }) => {
      const org = requireOrg(orgs, company);
      const conds = [
        eq(schema.snapshots.organizationId, org.id),
        eq(schema.snapshots.source, source),
        eq(schema.snapshots.location, location ?? "")
      ];
      if (date) conds.push(eq(schema.snapshots.date, date));
      const row = await db
        .select()
        .from(schema.snapshots)
        .where(and(...conds))
        .orderBy(desc(schema.snapshots.date))
        .limit(1)
        .get();
      if (!row) return text({ error: "no snapshot found" });
      return text({ date: row.date, source: row.source, location: row.location, payload: JSON.parse(row.payload) });
    }
  );

  server.tool(
    "company_summary",
    "Latest snapshot dates and row counts per source/location for a company — a quick freshness/coverage check.",
    { company: z.string() },
    async ({ company }) => {
      const org = requireOrg(orgs, company);
      const rows = await db
        .select({
          source: schema.snapshots.source,
          location: schema.snapshots.location,
          latest: sql<string>`max(${schema.snapshots.date})`,
          snapshots: sql<number>`count(*)`
        })
        .from(schema.snapshots)
        .where(eq(schema.snapshots.organizationId, org.id))
        .groupBy(schema.snapshots.source, schema.snapshots.location)
        .all();
      return text(rows);
    }
  );

  // --- Albi (Albiware) tools ------------------------------------------------

  server.tool(
    "albi_projects",
    "Query synced Albi (Albiware) projects for a company from the local database. Fast and joinable with scorecard data. Use albi_sync_status to check freshness; use albi_project_live for real-time detail.",
    {
      company: z.string().describe("Company slug"),
      status: z.string().optional().describe("Filter by project status"),
      name_like: z.string().optional().describe("SQL LIKE pattern on project name"),
      limit: z.number().int().min(1).max(500).optional()
    },
    async ({ company, status, name_like, limit }) => {
      const org = requireOrg(orgs, company);
      const conds = [eq(schema.albiProjects.organizationId, org.id)];
      if (status) conds.push(eq(schema.albiProjects.status, status));
      if (name_like) conds.push(like(schema.albiProjects.name, name_like));
      const rows = await db
        .select({
          albi_id: schema.albiProjects.albiId,
          name: schema.albiProjects.name,
          status: schema.albiProjects.status,
          address: schema.albiProjects.address,
          received_date: schema.albiProjects.receivedDate,
          synced_at: schema.albiProjects.syncedAt
        })
        .from(schema.albiProjects)
        .where(and(...conds))
        .orderBy(desc(schema.albiProjects.receivedDate))
        .limit(limit ?? 100)
        .all();
      return text(rows);
    }
  );

  server.tool(
    "albi_project_kpis",
    "Query synced Albi financial KPIs as tidy rows (albi_project_id, metric, value). Joinable with query_metrics scorecard data for performance-vs-financials analysis.",
    {
      company: z.string(),
      albi_project_id: z.string().optional().describe("Limit to one project"),
      metric_like: z.string().optional().describe("SQL LIKE pattern, e.g. %revenue% or %margin%"),
      limit: z.number().int().min(1).max(2000).optional()
    },
    async ({ company, albi_project_id, metric_like, limit }) => {
      const org = requireOrg(orgs, company);
      const conds = [eq(schema.albiProjectKpis.organizationId, org.id)];
      if (albi_project_id) conds.push(eq(schema.albiProjectKpis.albiProjectId, albi_project_id));
      if (metric_like) conds.push(like(schema.albiProjectKpis.metric, metric_like));
      const rows = await db
        .select({
          albi_project_id: schema.albiProjectKpis.albiProjectId,
          metric: schema.albiProjectKpis.metric,
          value: schema.albiProjectKpis.value,
          text_value: schema.albiProjectKpis.textValue
        })
        .from(schema.albiProjectKpis)
        .where(and(...conds))
        .limit(limit ?? 500)
        .all();
      return text(rows);
    }
  );

  server.tool(
    "albi_project_live",
    "Fetch one Albi project LIVE from the Albi API (real-time), optionally including payments, invoices, and expenses.",
    {
      company: z.string(),
      albi_project_id: z.string(),
      include: z.array(z.enum(["payments", "invoices", "expenses", "kpi"])).optional()
    },
    async ({ company, albi_project_id, include }) => {
      const org = requireOrg(orgs, company);
      const client = await albiFor(db, org.id);
      const out: Record<string, unknown> = {
        project: await client.get(ALBI_PATHS.projectById(albi_project_id))
      };
      for (const inc of include ?? []) {
        const path =
          inc === "payments"
            ? ALBI_PATHS.projectPayments(albi_project_id)
            : inc === "invoices"
              ? ALBI_PATHS.projectInvoices(albi_project_id)
              : inc === "expenses"
                ? ALBI_PATHS.projectExpenses(albi_project_id)
                : ALBI_PATHS.projectFinancialKpi(albi_project_id);
        try {
          out[inc] = await client.get(path);
        } catch (e) {
          out[inc] = { error: (e as Error).message };
        }
      }
      return text(out);
    }
  );

  server.tool(
    "albi_get",
    `Generic LIVE read-only GET against the Albi API for a company. Path must start with one of: ${ALBI_READ_PREFIXES.join(", ")}. Optional query params. Use for anything the dedicated tools don't cover (contacts, tasks, scheduler, options, staff, timesheets).`,
    {
      company: z.string(),
      path: z.string().describe("e.g. /Contacts/GetAll or /Projects/{id}/Payments"),
      query: z.record(z.string()).optional()
    },
    async ({ company, path, query }) => {
      const org = requireOrg(orgs, company);
      if (!path.startsWith("/") || !ALBI_READ_PREFIXES.some((p) => path.startsWith(p))) {
        throw new Error(`Path must start with one of: ${ALBI_READ_PREFIXES.join(", ")}`);
      }
      const client = await albiFor(db, org.id);
      return text(await client.get(path, query));
    }
  );

  server.tool(
    "albi_sync_status",
    "Albi sync freshness for a company: last sync time, project count, KPI row count.",
    { company: z.string() },
    async ({ company }) => {
      const org = requireOrg(orgs, company);
      const cfg = await getAlbiConfig(db, org.id);
      const projects = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.albiProjects)
        .where(eq(schema.albiProjects.organizationId, org.id))
        .get();
      const kpis = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.albiProjectKpis)
        .where(eq(schema.albiProjectKpis.organizationId, org.id))
        .get();
      return text({
        configured: !!cfg,
        enabled: cfg?.enabled ?? false,
        last_sync_at: cfg?.lastSyncAt ?? null,
        projects: projects?.n ?? 0,
        kpi_rows: kpis?.n ?? 0
      });
    }
  );

  server.tool(
    "albi_push_scorecard",
    "WRITE: push a carrier scorecard summary into Albi — as a note on a specific project (pass albi_project_id) or as a CRM activity. Auto-builds the summary from the latest synced Sedgwick/CC metrics unless custom text is given. Requires company admin or super admin role.",
    {
      company: z.string(),
      albi_project_id: z.string().optional(),
      text: z.string().optional().describe("Custom message; omit to auto-build from latest metrics")
    },
    async ({ company, albi_project_id, text: customText }) => {
      const org = requireOrg(orgs, company);
      if (!["admin", "owner", "superadmin"].includes(org.role)) {
        throw new Error("Pushing to Albi requires a company admin or super admin role.");
      }
      const result = await pushScorecardToAlbi(env, org.id, org.name, {
        albiProjectId: albi_project_id,
        text: customText
      });
      return text(result);
    }
  );

  return server;
}
