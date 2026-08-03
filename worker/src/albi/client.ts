/**
 * Albi (Albiware) API client. Base: https://api.albiware.com/v5
 * Docs: https://albi.readme.io (also exposes /llms.txt with the OpenAPI index).
 *
 * NOTE: header name and exact resource paths should be verified against the
 * docs with a real key. Everything path-shaped lives in ALBI_PATHS so a naming
 * mismatch is a one-line fix; the header name is configurable per org via
 * albi_config.auth_header (default x-api-key).
 */

export const ALBI_BASE = "https://api.albiware.com/v5";

export const ALBI_PATHS = {
  projectsGetAll: "/Projects/GetAll",
  projectById: (id: string) => `/Projects/${id}`,
  projectFinancialKpi: (id: string) => `/Projects/${id}/FinancialKPI`,
  projectPayments: (id: string) => `/Projects/${id}/Payments`,
  projectInvoices: (id: string) => `/Projects/${id}/Invoices`,
  projectExpenses: (id: string) => `/Projects/${id}/Expenses`,
  createNote: "/Projects/CreateNote",
  createActivity: "/Activities/Create",
  webhookCreate: "/Integrations/Webhooks/Create",
  webhookList: "/Integrations/Webhooks/List",
  webhookDelete: "/Integrations/Webhooks/Delete"
} as const;

/** Read-only path prefixes the generic MCP passthrough may GET. */
export const ALBI_READ_PREFIXES = [
  "/Projects",
  "/Contacts",
  "/Organizations",
  "/Tasks",
  "/Activities",
  "/Scheduler",
  "/Staff",
  "/Options",
  "/Timesheet"
];

export type AlbiAuth = { apiKey: string; authHeader?: string | null };

export class AlbiClient {
  constructor(private auth: AlbiAuth) {}

  async request<T = unknown>(
    path: string,
    init?: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> }
  ): Promise<T> {
    const url = new URL(ALBI_BASE + path);
    for (const [k, v] of Object.entries(init?.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), {
      method: init?.method ?? (init?.body ? "POST" : "GET"),
      headers: {
        [this.auth.authHeader || "x-api-key"]: this.auth.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Albi ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>) {
    return this.request<T>(path, { query });
  }
}

/** Normalize the various list envelope shapes an API may return. */
export function listItems(res: any): any[] {
  if (Array.isArray(res)) return res;
  for (const k of ["data", "items", "results", "result", "projects", "records"]) {
    if (Array.isArray(res?.[k])) return res[k];
  }
  return [];
}

/** Best-effort field extraction across possible Albi payload spellings. */
export function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null) return obj[k];
  }
  return null;
}
