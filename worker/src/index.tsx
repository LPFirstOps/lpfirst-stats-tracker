import { Hono } from "hono";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, asc, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import { createAuth, type Env } from "./auth";
import { handleIngest, type IngestBody } from "./ingest";
import { handleMcp } from "./mcp";
import { accessibleOrgs, findOrg, type OrgAccess } from "./rbac";
import { LoginPage } from "./pages/Login";
import { AcceptInvitationPage } from "./pages/AcceptInvitation";
import { AdminPage, type AdminCard } from "./pages/Admin";
import { DashboardPage, type SummaryRow } from "./pages/Dashboard";

const app = new Hono<{ Bindings: Env }>();

// --- helpers ---------------------------------------------------------------

async function getSession(c: any) {
  return createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
}

function setCookiesOf(from: Response): string[] {
  const h = from.headers as any;
  const cookies: string[] = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
  if (!cookies.length) {
    const single = from.headers.get("set-cookie");
    if (single) cookies.push(single);
  }
  return cookies;
}

/** 302 redirect that carries over Set-Cookie headers from an auth response. */
function redirectWith(from: Response | null, to: string) {
  const headers = new Headers({ Location: to });
  if (from) for (const v of setCookiesOf(from)) headers.append("Set-Cookie", v);
  return new Response(null, { status: 302, headers });
}

function errMessage(e: any) {
  return encodeURIComponent(e?.body?.message ?? e?.message ?? "Request failed");
}

/** Turn an auth response's Set-Cookie headers into a Cookie request header. */
function cookieHeaderFrom(res: Response) {
  return setCookiesOf(res)
    .map((v) => v.split(";")[0])
    .join("; ");
}

function pageUser(session: any, orgs: OrgAccess[]) {
  const superadmin = session.user.role === "admin";
  return {
    email: session.user.email as string,
    superadmin,
    admin: superadmin || orgs.some((o) => ["admin", "owner", "superadmin"].includes(o.role))
  };
}

async function summaryFor(d: ReturnType<typeof drizzle<typeof schema>>, orgId: string): Promise<SummaryRow[]> {
  return d
    .select({
      source: schema.snapshots.source,
      location: schema.snapshots.location,
      latest: sql<string>`max(${schema.snapshots.date})`,
      count: sql<number>`count(*)`
    })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.organizationId, orgId))
    .groupBy(schema.snapshots.source, schema.snapshots.location)
    .all();
}

// --- OAuth discovery (MCP clients hit these root paths directly) -----------
app.get("/.well-known/oauth-authorization-server", (c) =>
  oAuthDiscoveryMetadata(createAuth(c.env))(c.req.raw)
);
app.get("/.well-known/oauth-protected-resource", (c) =>
  oAuthProtectedResourceMetadata(createAuth(c.env))(c.req.raw)
);

// --- Better Auth (sign-in/up, org management, invitations, OAuth/MCP) ------
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

// --- Pages (server-rendered, Hono JSX) -------------------------------------

app.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect("/login");
  const d = drizzle(c.env.DB, { schema });
  const orgs = await accessibleOrgs(d, session.user.id);
  const companies: Array<{ org: OrgAccess; summary: SummaryRow[] }> = [];
  for (const org of orgs) {
    companies.push({ org, summary: await summaryFor(d, org.id) });
  }
  return c.html(<DashboardPage user={pageUser(session, orgs)} companies={companies} />);
});

app.get("/login", (c) => {
  const q = c.req.query();
  const mode = q.mode === "signup" ? ("signup" as const) : ("signin" as const);
  // Arriving mid-OAuth (MCP client flow): resume the authorize request after login.
  const search = new URL(c.req.url).search;
  const next = q.next ?? (q.client_id ? `/api/auth/mcp/authorize${search}` : "/");
  return c.html(<LoginPage mode={mode} next={next} error={q.error} />);
});

app.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const next = typeof body.next === "string" && body.next.startsWith("/") ? body.next : "/";
  try {
    const res = await createAuth(c.env).api.signInEmail({
      body: { email: String(body.email ?? ""), password: String(body.password ?? "") },
      headers: c.req.raw.headers,
      asResponse: true
    });
    return redirectWith(res, next);
  } catch (e) {
    return c.redirect(`/login?error=${errMessage(e)}&next=${encodeURIComponent(next)}`);
  }
});

app.post("/signup", async (c) => {
  const body = await c.req.parseBody();
  const next = typeof body.next === "string" && body.next.startsWith("/") ? body.next : "/";
  const email = String(body.email ?? "");
  try {
    const res = await createAuth(c.env).api.signUpEmail({
      body: {
        email,
        password: String(body.password ?? ""),
        name: String(body.name || email.split("@")[0])
      },
      headers: c.req.raw.headers,
      asResponse: true
    });
    return redirectWith(res, next);
  } catch (e) {
    return c.redirect(`/login?mode=signup&error=${errMessage(e)}&next=${encodeURIComponent(next)}`);
  }
});

app.post("/signout", async (c) => {
  try {
    const res = await createAuth(c.env).api.signOut({ headers: c.req.raw.headers, asResponse: true });
    return redirectWith(res, "/login");
  } catch {
    return c.redirect("/login");
  }
});

app.get("/accept-invitation", (c) => {
  const q = c.req.query();
  return c.html(
    <AcceptInvitationPage
      id={q.id ?? ""}
      email={q.email ?? ""}
      mode={q.mode === "signin" ? "signin" : "signup"}
      error={q.error}
    />
  );
});

app.post("/accept-invitation", async (c) => {
  const body = await c.req.parseBody();
  const id = String(body.id ?? "");
  const email = String(body.email ?? "");
  const mode = body.mode === "signin" ? "signin" : "signup";
  const back = `/accept-invitation?id=${encodeURIComponent(id)}&email=${encodeURIComponent(email)}&mode=${mode}`;
  if (!id) return c.redirect(`${back}&error=${encodeURIComponent("Missing invitation id")}`);

  const auth = createAuth(c.env);
  try {
    const password = String(body.password ?? "");
    const authRes =
      mode === "signup"
        ? await auth.api.signUpEmail({
            body: { email, password, name: String(body.name || email.split("@")[0]) },
            asResponse: true
          })
        : await auth.api.signInEmail({ body: { email, password }, asResponse: true });

    // Accept using the fresh session cookie from the auth response.
    await auth.api.acceptInvitation({
      body: { invitationId: id },
      headers: new Headers({ cookie: cookieHeaderFrom(authRes) })
    });
    return redirectWith(authRes, "/");
  } catch (e) {
    return c.redirect(`${back}&error=${errMessage(e)}`);
  }
});

app.get("/admin", async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect("/login");
  const d = drizzle(c.env.DB, { schema });
  const orgs = await accessibleOrgs(d, session.user.id);
  const adminOrgs = orgs.filter((o) => ["admin", "owner", "superadmin"].includes(o.role));

  const cards: AdminCard[] = [];
  for (const org of adminOrgs) {
    const members = await d
      .select({ email: schema.user.email, role: schema.member.role })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(eq(schema.member.organizationId, org.id))
      .all();
    const invites = await d
      .select({ email: schema.invitation.email, role: schema.invitation.role, status: schema.invitation.status })
      .from(schema.invitation)
      .where(and(eq(schema.invitation.organizationId, org.id), eq(schema.invitation.status, "pending")))
      .all();
    cards.push({ org, members, invites });
  }

  const q = c.req.query();
  return c.html(<AdminPage user={pageUser(session, orgs)} cards={cards} error={q.error} invited={q.invited} />);
});

app.post("/admin/invite", async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect("/login");
  const body = await c.req.parseBody();
  try {
    await createAuth(c.env).api.createInvitation({
      body: {
        email: String(body.email ?? ""),
        role: (String(body.role) === "admin" ? "admin" : "member") as "admin" | "member",
        organizationId: String(body.organizationId ?? "")
      },
      headers: c.req.raw.headers
    });
    return c.redirect(`/admin?invited=${encodeURIComponent(String(body.email ?? ""))}`);
  } catch (e) {
    return c.redirect(`/admin?error=${errMessage(e)}`);
  }
});

// --- JSON API (kept for MCP consumers and future clients) -------------------

app.get("/api/me", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const db = drizzle(c.env.DB, { schema });
  const companies = await accessibleOrgs(db, session.user.id);
  const { id, name, email, role } = session.user as any;
  return c.json({ user: { id, name, email, role: role ?? "user" }, companies });
});

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

app.get("/api/summary", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const db = drizzle(c.env.DB, { schema });
  const orgs = await accessibleOrgs(db, session.user.id);
  const org = findOrg(orgs, c.req.query("company") ?? "");
  if (!org) return c.json({ error: "unknown or inaccessible company" }, 403);
  return c.json(await summaryFor(db, org.id));
});

/**
 * Reassembles the legacy stats.json `statsData` shape from D1, scoped to the
 * caller's companies — the data source for the ported dashboard's chart island.
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

// --- Static assets fallback (images etc.) ----------------------------------
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
