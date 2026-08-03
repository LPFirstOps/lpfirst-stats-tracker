import { Layout, ErrorNote, inputClass, cardClass } from "./Layout";
import type { OrgAccess } from "../rbac";

export type AdminCard = {
  org: OrgAccess;
  members: { email: string; role: string }[];
  invites: { email: string; role: string | null; status: string }[];
  albi: { enabled: boolean; lastSyncAt: string | null } | null;
};

export function AdminPage(props: {
  user: { email: string; superadmin: boolean; admin: boolean };
  cards: AdminCard[];
  error?: string;
  invited?: string;
  notice?: string;
}) {
  return (
    <Layout title="Admin" user={props.user}>
      <h1 class="text-2xl font-semibold mb-6">Admin</h1>
      <ErrorNote message={props.error} />
      {props.invited && <p class="text-emerald-400 text-sm mb-3">Invitation sent to {props.invited}.</p>}
      {props.notice && <p class="text-emerald-400 text-sm mb-3">{props.notice}</p>}
      {props.cards.length === 0 && (
        <p class="text-sm text-slate-400">You don't have admin access to any company.</p>
      )}
      <div class="space-y-6">
        {props.cards.map(({ org, members, invites, albi }) => (
          <div class={cardClass}>
            <h2 class="text-lg font-medium mb-3">
              {org.name} <span class="text-xs text-slate-500">({org.role})</span>
            </h2>

            <form method="post" action="/admin/invite" class="flex gap-2 mb-4">
              <input type="hidden" name="organizationId" value={org.id} />
              <input name="email" type="email" required placeholder="email@example.com" class={`${inputClass} flex-1 text-sm`} />
              <select name="role" class="rounded bg-slate-800 border border-slate-700 px-2 py-2 text-sm">
                <option value="member">User</option>
                <option value="admin">Admin</option>
              </select>
              <button class="rounded bg-indigo-600 hover:bg-indigo-500 px-3 py-2 text-sm">Invite</button>
            </form>

            <div class="text-sm text-slate-300">
              {members.length === 0 && invites.length === 0 && <p class="text-slate-500">No members yet.</p>}
              {members.map((m) => (
                <div class="flex justify-between py-1 border-b border-slate-800">
                  <span>{m.email}</span>
                  <span class="text-slate-500">{m.role}</span>
                </div>
              ))}
              {invites.map((i) => (
                <div class="flex justify-between py-1 border-b border-slate-800 text-slate-500">
                  <span>{i.email}</span>
                  <span>invited ({i.role ?? "member"})</span>
                </div>
              ))}
            </div>

            <div class="mt-4 pt-4 border-t border-slate-800">
              <h3 class="text-sm font-medium mb-1">Albi (Albiware)</h3>
              <p class="text-xs text-slate-500 mb-2">
                {albi
                  ? `Connected · last sync ${albi.lastSyncAt ?? "never"}${albi.enabled ? "" : " · disabled"}`
                  : "Not connected — add this company's Albi API key."}
              </p>
              <form method="post" action="/admin/albi" class="flex gap-2 mb-2">
                <input type="hidden" name="organizationId" value={org.id} />
                <input
                  name="apiKey"
                  type="password"
                  required
                  placeholder={albi ? "Replace API key" : "Albi API key"}
                  class={`${inputClass} flex-1 text-sm`}
                />
                <input name="authHeader" type="text" placeholder="x-api-key" class={`${inputClass} w-32 text-sm`} />
                <button class="rounded bg-indigo-600 hover:bg-indigo-500 px-3 py-2 text-sm">Save</button>
              </form>
              {albi && (
                <div class="flex gap-2">
                  <form method="post" action="/admin/albi/sync">
                    <input type="hidden" name="organizationId" value={org.id} />
                    <button class="rounded bg-slate-700 hover:bg-slate-600 px-3 py-2 text-sm">Sync now</button>
                  </form>
                  <form method="post" action="/admin/albi/webhook" class="flex gap-2">
                    <input type="hidden" name="organizationId" value={org.id} />
                    <input name="scopes" type="text" placeholder="scopes (comma, blank = *)" class={`${inputClass} w-48 text-sm`} />
                    <button class="rounded bg-slate-700 hover:bg-slate-600 px-3 py-2 text-sm">Register webhook</button>
                  </form>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Layout>
  );
}
