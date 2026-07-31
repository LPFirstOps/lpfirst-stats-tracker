import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, gte, lte, like, desc, sql } from "drizzle-orm";
import type { Context } from "hono";
import * as schema from "./db/schema";
import { createAuth, type Env } from "./auth";
import { accessibleOrgs, findOrg, type OrgAccess } from "./rbac";

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

  const server = buildServer(db, orgs);
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

function buildServer(db: ReturnType<typeof drizzle<typeof schema>>, orgs: OrgAccess[]) {
  const server = new McpServer({ name: "lpfirst-stats", version: "1.0.0" });

  server.tool(
    "list_companies",
    "List the companies (and your role in each) whose contractor stats you can query.",
    {},
    async () => text(orgs)
  );

  server.tool(
    "list_metrics",
    "List distinct metric names available for a company, optionally filtered by source (cc|sedgwick|alacrity). Use this to discover what query_metrics can return.",
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
    "Query contractor performance metrics as tidy rows (date, source, location, tab, assignment_type, metric, value). Dates are YYYY-MM-DD (Central Time); CC yearly aggregates use YYYY.",
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
    "Get the raw scraped snapshot payload for a company/source/date. Omit date for the most recent.",
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

  return server;
}
