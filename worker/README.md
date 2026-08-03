# LP First Stats — Cloudflare Worker

Node app on Cloudflare Workers replacing the StatiCrypt static dashboard.
Hono with server-rendered JSX pages (Laravel-style MPA: forms POST, server
redirects, no client-side framework) + Better Auth (auth, companies,
invitations, MCP OAuth) + Drizzle ORM + D1. Scrapers stay in GitHub Actions
and push snapshots to `POST /api/ingest`.

## Architecture

- `src/pages/` — JSX components rendered server-side (`c.html(<Page/>)`).
  Shared `Layout.tsx`. No client JS anywhere except the (pending) chart
  island on the dashboard.
- Forms are plain `<form method="post">` → Hono route → 302 redirect.
  Auth routes proxy to Better Auth's server API and forward Set-Cookie.
- `/api/*` JSON endpoints remain for MCP tools and future consumers.
- `src/albi/` — Albi (Albiware) integration: client, sync engine, write-back.
- `public/` — static assets only (images), served via catch-all fallback.

## Permission model

| Role | How | Can |
|---|---|---|
| User | org `member` | Read stats for their companies only. Cannot invite. |
| Company admin | org `admin` / `owner` | Everything a user can, plus invite users/admins to **their** companies, manage that company's Albi connection. |
| Super admin | `user.role = 'admin'` (admin plugin) | All companies, invite/promote anywhere, create orgs. |

Companies are Better Auth organizations: `aaction`, `icon`, `moyers`.

## First deploy

```bash
cd worker
npm install
npx wrangler d1 create lpfirst-stats        # paste database_id into wrangler.jsonc
npm run db:migrate:remote                   # creates tables + seeds the 3 companies
npx wrangler secret put BETTER_AUTH_SECRET  # openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN        # openssl rand -hex 32
npx wrangler secret put RESEND_API_KEY      # optional — invites log to console without it
npm run deploy
```

Set `BASE_URL` in `wrangler.jsonc` to the deployed URL (workers.dev or custom
domain) and redeploy — OAuth issuer/redirect URLs derive from it.

**Bootstrap yourself:** sign up at `/login`, then:

```bash
npx wrangler d1 execute lpfirst-stats --remote --command \
  "UPDATE user SET role='admin' WHERE email='you@example.com'"
npx wrangler d1 execute lpfirst-stats --remote --command \
  "INSERT INTO member (id, organization_id, user_id, role, created_at) \
   SELECT 'mem_' || o.slug, o.id, u.id, 'owner', CAST(strftime('%s','now') AS INTEGER)*1000 \
   FROM organization o, user u WHERE u.email='you@example.com'"
```

## Historical migration

From the repo root (needs `STATICRYPT_PASSWORD` in `.env`):

```bash
npm run decrypt
WORKER_URL=https://... INGEST_TOKEN=... node scripts/sync-to-d1.js --all
npm run encrypt:data
```

Then add `WORKER_URL` and `INGEST_TOKEN` as GitHub Actions secrets — the daily
workflow already has a "Sync to D1" step that no-ops until they exist.

## Albi (Albiware) integration

Per-company integration with Albi's REST API (`api.albiware.com/v5`, docs at
albi.readme.io). Each company connects its own tenant.

**Setup (per company, from `/admin`):**

1. Paste the company's Albi API key (auth header defaults to `x-api-key`;
   override in the second field if the tenant expects something else).
2. **Sync now** — pulls all projects + financial KPIs into D1
   (`albi_projects` + tidy `albi_project_kpis`, joinable with scorecard
   `metrics`). A nightly cron (07:30 UTC, after the scrape) re-syncs
   automatically.
3. **Register webhook** — creates an Albi webhook pointing at
   `BASE_URL/api/webhooks/albi/{slug}/{INGEST_TOKEN}`. Events are logged to
   `albi_events` and the affected project is re-synced in real time.

**Write-back:** scorecard summaries (latest Sedgwick scores vs state average +
CC summary) can be pushed into Albi as a project note or CRM activity — via
the `albi_push_scorecard` MCP tool (admin roles only).

⚠️ Albi's exact resource paths and payload field names should be verified
against albi.readme.io on first use with a real key — they're centralized in
`src/albi/client.ts` (`ALBI_PATHS`) so any mismatch is a one-line fix.

## MCP

Endpoint: `https://<base-url>/mcp` (streamable HTTP). OAuth 2.1 with dynamic
client registration via the Better Auth MCP plugin — add it to Claude as a
custom connector with just the URL; the browser login flow handles the rest.
All tools are scoped to the companies the authenticated user belongs to.

**Scorecard tools:**

- `list_companies` — accessible companies + role
- `list_metrics` — discover metric names per company/source
- `query_metrics` — tidy rows filtered by source/location/tab/type/date range
- `get_snapshot` — raw scraped payload for a date (or latest)
- `company_summary` — freshness/coverage check

**Albi tools:**

- `albi_projects` — synced projects (fast, joinable)
- `albi_project_kpis` — synced financial KPIs (tidy; join with `query_metrics`
  for performance-vs-financials analysis)
- `albi_project_live` — real-time project detail + payments/invoices/expenses
- `albi_get` — generic read-only live GET (contacts, tasks, scheduler, …)
- `albi_sync_status` — sync freshness
- `albi_push_scorecard` — WRITE: push scorecard summary as project note /
  CRM activity (admin roles only)

## Data model

- `snapshots` — raw scraped payload per (company, source, location, date).
  CC yearly aggregates use `date='YYYY'`; Icon locations use `location`.
- `metrics` — tidy long format: (company, source, location, date, tab,
  assignment_type, metric, value, text_value). Metric names are dot-paths into
  the original payload. This is what SQL/MCP queries hit.
- `albi_config` / `albi_projects` / `albi_project_kpis` / `albi_events` —
  Albi credentials, synced projects, tidy financial KPIs, webhook log.
- Everything else is Better Auth (user/session/account/verification,
  organization/member/invitation, oauth_*).

## Dashboard port (TODO)

`src/pages/Dashboard.tsx` is a server-rendered placeholder. The real dashboard
source is `index.html.bak` (gitignored — not in the repo). Port its markup into
the component and keep its Chart.js script as the single client-side island,
fed by embedded `statsData` or `fetch("/api/statsdata")` — instructions are in
the component's doc comment.

## Cutover checklist

1. Deploy worker, run migrations, bootstrap super admin
2. `sync-to-d1.js --all` historical migration; spot-check `/api/summary`
3. Add `WORKER_URL` + `INGEST_TOKEN` GH secrets; verify next daily run syncs
4. Port dashboard from `index.html.bak`; invite the team
5. Connect Claude to `/mcp`; connect Albi keys at `/admin`
6. Remove StatiCrypt steps from the workflow, retire GitHub Pages

## Notes

- Better Auth's `mcp` plugin is being folded into their OAuth Provider plugin;
  swap on the next better-auth major (same helper names).
- Schema was hand-written to match better-auth v1.3; after upgrading, verify
  with `npm run auth:generate` and diff against `src/db/schema.ts`.
