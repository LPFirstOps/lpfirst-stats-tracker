import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization, mcp } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_URL: string;
  BETTER_AUTH_SECRET: string;
  INGEST_TOKEN: string;
  RESEND_API_KEY?: string;
  INVITE_FROM_EMAIL?: string;
};

/**
 * Role model:
 *  - Super admin: user.role === "admin" (Better Auth admin plugin).
 *    Sees every company, can create orgs, invite/promote anywhere.
 *    Seed makes super admins an "owner" member of every org so the
 *    organization plugin's own endpoints work without membership hacks.
 *  - Company admin: member.role === "admin" | "owner" on an org.
 *    Can invite to that org and grant "admin" within it (org plugin default).
 *  - User: member.role === "member". Read-only, cannot invite (org plugin default).
 */
export function createAuth(env: Env) {
  const db = drizzle(env.DB, { schema });

  return betterAuth({
    baseURL: env.BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false
    },
    // Only invited users should exist: sign-up page is not linked publicly and
    // invitation acceptance drives membership. Tighten later with
    // emailAndPassword.disableSignUp + admin-created users if needed.
    plugins: [
      admin(),
      organization({
        allowUserToCreateOrganization: async (user) => user.role === "admin",
        async sendInvitationEmail(data) {
          const url = `${env.BASE_URL}/accept-invitation?id=${data.id}&email=${encodeURIComponent(data.email)}`;
          if (!env.RESEND_API_KEY) {
            console.log(`[invite] ${data.email} -> ${data.organization.name}: ${url}`);
            return;
          }
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: env.INVITE_FROM_EMAIL ?? "stats@lpfirst.com",
              to: data.email,
              subject: `You're invited to ${data.organization.name} on LP First Stats`,
              html: `<p>${data.inviter.user.name} invited you to view ${data.organization.name} stats.</p><p><a href="${url}">Accept invitation</a></p>`
            })
          });
        }
      }),
      // NOTE: better-auth is migrating this into the OAuth Provider plugin
      // (@better-auth/oauth-provider). The mcp plugin still ships and handles
      // OAuth 2.1 + dynamic client registration for MCP clients. Swap when
      // upgrading better-auth majors.
      mcp({
        loginPage: "/login"
      })
    ]
  });
}

export type Auth = ReturnType<typeof createAuth>;
