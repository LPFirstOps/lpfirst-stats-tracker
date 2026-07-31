import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Better Auth tables (core + admin + organization + mcp/oidc plugins)
// If better-auth is upgraded, re-verify with: npx @better-auth/cli generate
// ---------------------------------------------------------------------------

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  // admin plugin — role === "admin" means SUPER ADMIN (cross-company)
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp_ms" })
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
  activeOrganizationId: text("active_organization_id")
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
});

// organizations === companies (aaction, icon, moyers)
export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  metadata: text("metadata")
});

export const member = sqliteTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"), // member | admin | owner
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const invitation = sqliteTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  inviterId: text("inviter_id").notNull().references(() => user.id, { onDelete: "cascade" })
});

// mcp/oidc provider plugin tables
export const oauthApplication = sqliteTable("oauth_application", {
  id: text("id").primaryKey(),
  name: text("name"),
  icon: text("icon"),
  metadata: text("metadata"),
  clientId: text("client_id").unique(),
  clientSecret: text("client_secret"),
  redirectURLs: text("redirect_u_r_ls"),
  type: text("type"),
  disabled: integer("disabled", { mode: "boolean" }),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
});

export const oauthAccessToken = sqliteTable("oauth_access_token", {
  id: text("id").primaryKey(),
  accessToken: text("access_token").unique(),
  refreshToken: text("refresh_token").unique(),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  clientId: text("client_id"),
  userId: text("user_id"),
  scopes: text("scopes"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
});

export const oauthConsent = sqliteTable("oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id"),
  userId: text("user_id"),
  scopes: text("scopes"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  consentGiven: integer("consent_given", { mode: "boolean" })
});

// ---------------------------------------------------------------------------
// Domain tables
// ---------------------------------------------------------------------------

// Raw scraped snapshots, one row per (company, source, location, date).
// date is "YYYY-MM-DD" for daily snapshots, "YYYY" for CC yearly aggregates.
export const snapshots = sqliteTable(
  "snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // cc | sedgwick | alacrity
    location: text("location").notNull().default(""), // icon: rochester | rockwood | lansing
    date: text("date").notNull(),
    payload: text("payload").notNull(), // original JSON blob
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (t) => [
    uniqueIndex("snapshots_unique").on(t.organizationId, t.source, t.location, t.date),
    index("snapshots_org_source").on(t.organizationId, t.source, t.date)
  ]
);

// Tidy/long metrics extracted from snapshots — the SQL-queryable model.
// metric is a dot-path into the original payload (e.g. "summary.totalAssignments"
// or for CC tabs: tab + assignmentType columns are populated).
export const metrics = sqliteTable(
  "metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    location: text("location").notNull().default(""),
    date: text("date").notNull(),
    tab: text("tab").notNull().default(""), // assignments|avgtip|poms|reinspections|surveys|qafeedback
    assignmentType: text("assignment_type").notNull().default(""),
    metric: text("metric").notNull(),
    value: real("value"),
    textValue: text("text_value"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (t) => [
    uniqueIndex("metrics_unique").on(t.organizationId, t.source, t.location, t.date, t.tab, t.assignmentType, t.metric),
    index("metrics_org_date").on(t.organizationId, t.date),
    index("metrics_lookup").on(t.organizationId, t.source, t.metric, t.date)
  ]
);
