import type {
  ConnectionInfo,
  ConnectionInput,
  RemoteRows,
  RemoteForeignKey,
  RemoteTableInfo,
  SqlRunResult,
  LinkAccess,
  ProjectDoc,
  ProjectRecord,
  ProjectSummary,
  SharePermission,
  ShareSettings,
  UserInfo,
  VersionInfo,
} from "../../shared/model";
import type { AiDatabaseRequest, AiDatabaseSpec, AiQueryRequest, AiQuerySpec, AiStatus } from "../../shared/ai";
import type { TemplateId } from "../../shared/templates";
import type { ActivityEntry, AdminOverview, AdminUserDetail, AdminUserRow } from "../../shared/activity";
import type { AdminPlans, AiPlanSettings, BillingStatus, FeatureId } from "../../shared/plans";

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

/** What to tell people when there's no usable answer from the server. */
function statusMessage(status: number, what: string) {
  if (status === 401) return "You've been signed out. Please sign in again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That couldn't be found. It may have been deleted.";
  if (status === 413) return "That's too large to send. Try a smaller file.";
  if (status === 429) return "Too many requests in a short time. Please wait a minute and try again.";
  if (status >= 500) return `The server had a problem with this ${what}. Please try again in a moment.`;
  return `The ${what} didn't work (error ${status}). Please try again.`;
}

/** fetch, with "you're offline" in plain words instead of "Failed to fetch". */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(
      navigator.onLine === false
        ? "You're offline. Check your internet connection, then try again."
        : "Couldn't reach the server. Check your internet connection, or wait a moment while it starts up, then try again.",
      0,
    );
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(url, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Requested-With": "fetch",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // The Usage Policy changed while the app was open: the app asks for agreement (see App.tsx).
  if (res.status === 403 && data.code === "policy") window.dispatchEvent(new Event("accessweb:policy"));
  // An advanced feature their plan doesn't include: the app offers the plans (see App.tsx).
  if (res.status === 402 && data.code === "upgrade") window.dispatchEvent(new CustomEvent("accessweb:upgrade", { detail: data }));
  if (!res.ok) throw new ApiError(data.error ?? statusMessage(res.status, "request"), res.status, data);
  return data as T;
}

async function upload<T>(url: string, file: Blob): Promise<T> {
  if (file.size > 100 * 1024 * 1024) throw new ApiError("That file is larger than 100 MB.", 413);
  const res = await send(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-Requested-With": "fetch", "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? statusMessage(res.status, "upload"), res.status, data);
  return data as T;
}

/** A report someone made public: its link's token. */
export interface PublicReportLink {
  reportId: string;
  token: string;
  updatedAt: string;
}
/** What a public report link shows: the report's settings and only the rows and columns it uses. */
export interface ReportSnapshot {
  v: 1;
  title: string;
  report: Record<string, unknown>;
  columns: string[];
  fields: ({ type: string } | null)[];
  rows: (string | number | boolean | null)[][];
}

export interface AdminActivityFilter {
  user?: string;
  action?: string;
  q?: string;
}
function activityParams(f: AdminActivityFilter, before?: number) {
  const p = new URLSearchParams();
  if (f.user) p.set("user", f.user);
  if (f.action) p.set("action", f.action);
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (before) p.set("before", String(before));
  return p.toString();
}

export const api = {
  me: () => call<{ user: UserInfo | null }>("GET", "/api/auth/me"),
  /** Which build is running: commit and build time. */
  version: () => call<VersionInfo>("GET", "/api/version"),
  login: (email: string, password: string) => call<{ user: UserInfo }>("POST", "/api/auth/login", { email, password }),
  register: (name: string, email: string, password: string, acceptPolicy: boolean) =>
    call<{ user: UserInfo }>("POST", "/api/auth/register", { name, email, password, acceptPolicy }),
  policyInfo: () => call<{ version: string; contact: string | null }>("GET", "/api/auth/policy"),
  acceptPolicy: (version: string) => call<{ user: UserInfo }>("POST", "/api/auth/accept-policy", { version }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout", {}),

  // Site admin page (admins only)
  adminOverview: () => call<AdminOverview>("GET", "/api/admin/overview"),
  adminUsers: (q = "") => call<{ users: AdminUserRow[] }>("GET", `/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  adminUser: (id: string) => call<AdminUserDetail>("GET", `/api/admin/users/${encodeURIComponent(id)}`),
  adminActivity: (f: AdminActivityFilter, before?: number) =>
    call<{ entries: ActivityEntry[]; more: number | null }>("GET", `/api/admin/activity?${activityParams(f, before)}`),
  adminPlans: () => call<AdminPlans>("GET", "/api/admin/plans"),
  adminPlanSettings: (gated: boolean, advanced: FeatureId[], ai?: AiPlanSettings) => call<{ ok: true }>("PUT", "/api/admin/plans/settings", { gated, advanced, ai }),
  adminGrant: (userIds: string[], features: FeatureId[], enable: boolean) => call<{ ok: true; changed: number }>("POST", "/api/admin/plans/grant", { userIds, features, enable }),

  // The Advanced plan (Stripe)
  billingStatus: () => call<BillingStatus>("GET", "/api/billing/status"),
  checkout: (returnTo: string) => call<{ url: string }>("POST", "/api/billing/checkout", { returnTo }),
  confirmCheckout: (sessionId: string) => call<BillingStatus>("POST", "/api/billing/confirm", { sessionId }),
  billingPortal: (returnTo: string) => call<{ url: string }>("POST", "/api/billing/portal", { returnTo }),

  adminSuspend: (id: string, reason: string) => call<{ ok: true }>("POST", `/api/admin/users/${encodeURIComponent(id)}/suspend`, { reason }),
  adminUnsuspend: (id: string) => call<{ ok: true }>("POST", `/api/admin/users/${encodeURIComponent(id)}/unsuspend`, {}),
  adminActivityCsvUrl: (f: AdminActivityFilter) => `/api/admin/activity.csv?${activityParams(f)}`,

  // The AI assistant
  aiStatus: () => call<AiStatus>("GET", "/api/ai/status"),
  aiQuery: (req: AiQueryRequest) => call<{ query: AiQuerySpec; remaining: number; free?: AiStatus["free"] }>("POST", "/api/ai/query", req),
  aiDatabase: (req: AiDatabaseRequest) => call<{ design: AiDatabaseSpec; remaining: number; free?: AiStatus["free"] }>("POST", "/api/ai/database", req),

  listProjects: () => call<{ projects: ProjectSummary[]; shared: ProjectSummary[] }>("GET", "/api/projects"),
  createProject: (name: string, template: TemplateId) =>
    call<{ project: ProjectRecord }>("POST", "/api/projects", { name, template }),
  getProject: (id: string) => call<{ project: ProjectRecord }>("GET", `/api/projects/${id}`),
  saveProject: (id: string, baseRevision: number, changes: { name?: string; doc?: ProjectDoc }) =>
    call<{ project: ProjectSummary }>("PUT", `/api/projects/${id}`, { ...changes, baseRevision }),
  deleteProject: (id: string) => call<{ ok: true; removedOnly: boolean }>("DELETE", `/api/projects/${id}`),
  getRevision: (id: string) =>
    call<{ revision: number; updatedByName: string | null; updatedAt: string }>("GET", `/api/projects/${id}/revision`),
  copyProject: (id: string, name: string) => call<{ project: ProjectRecord }>("POST", `/api/projects/${id}/copy`, { name }),

  getShares: (id: string) => call<ShareSettings>("GET", `/api/projects/${id}/shares`),
  share: (id: string, email: string, permission: SharePermission) =>
    call<ShareSettings>("PUT", `/api/projects/${id}/shares`, { email, permission }),
  unshare: (id: string, userId: string) => call<ShareSettings>("DELETE", `/api/projects/${id}/shares/${userId}`),
  setLinkAccess: (id: string, linkAccess: LinkAccess) => call<ShareSettings>("PUT", `/api/projects/${id}/link-access`, { linkAccess }),
  /** Stores a picture for an Image field; returns its id. */
  uploadImage: (pid: string, picture: Blob) => upload<{ id: string; mime: string; size: number }>(`/api/projects/${pid}/images`, picture),
  /** Copies pictures from another database (pasting or importing objects that have pictures). */
  copyImages: (pid: string, from: string, ids: string[]) => call<{ copied: number }>("POST", `/api/projects/${pid}/images/copy`, { from, ids }),
  setPublicView: (id: string, publicView: boolean) => call<ShareSettings>("PUT", `/api/projects/${id}/public-access`, { publicView }),
  /** A database published for public viewing (no sign-in needed). */
  listPublicReports: (pid: string) => call<{ reports: PublicReportLink[] }>("GET", `/api/projects/${pid}/public-reports`),
  publishReport: (pid: string, reportId: string, snapshot: ReportSnapshot) =>
    call<{ token: string; updatedAt: string }>("PUT", `/api/projects/${pid}/public-reports/${reportId}`, { snapshot }),
  unpublishReport: (pid: string, reportId: string) => call<{ ok: true }>("DELETE", `/api/projects/${pid}/public-reports/${reportId}`),
  getPublicReport: (token: string) => call<{ snapshot: ReportSnapshot; updatedAt: string }>("GET", `/api/public-reports/${encodeURIComponent(token)}`),
  /** On a tag's public page: what the signed-in person may record for that person. */
  publicRecordOptions: (token: string, key: string, rec: string) =>
    call<{ signedIn: boolean; person?: string | null; actions: { id: string; name: string; done: string | null }[] }>(
      "GET",
      `/api/public-reports/${encodeURIComponent(token)}/record?${new URLSearchParams({ key, rec })}`,
    ),
  publicRecord: (token: string, body: { actionId: string; key: string; rec: string; now: string }) =>
    call<{ ok: boolean; person?: string; message: string; already?: boolean }>("POST", `/api/public-reports/${encodeURIComponent(token)}/record`, body),
  getPublicProject: (id: string) => call<{ project: ProjectRecord }>("GET", `/api/public/${id}`),
  getPublicRevision: (id: string) =>
    call<{ revision: number; updatedByName: string | null; updatedAt: string }>("GET", `/api/public/${id}/revision`),

  /** Creates a new database from an Access file. */
  importAccessProject: (file: File, name: string) =>
    upload<{ project: ProjectRecord; warnings: string[] }>(`/api/projects/import-access?name=${encodeURIComponent(name)}`, file),
  /** Reads an Access file's objects without saving them, to merge into the open database. */
  convertAccess: (file: File) => upload<{ doc: ProjectDoc; warnings: string[] }>("/api/projects/convert-access", file),

  // ---- External MySQL connections (per database) ----
  listConnections: (pid: string) => call<{ connections: ConnectionInfo[] }>("GET", `/api/projects/${pid}/connections`),
  createConnection: (pid: string, input: ConnectionInput) =>
    call<{ connection: ConnectionInfo }>("POST", `/api/projects/${pid}/connections`, input),
  updateConnection: (pid: string, cid: string, input: ConnectionInput) =>
    call<{ connection: ConnectionInfo }>("PUT", `/api/projects/${pid}/connections/${cid}`, input),
  deleteConnection: (pid: string, cid: string) => call<{ ok: true }>("DELETE", `/api/projects/${pid}/connections/${cid}`),
  testConnection: (pid: string, settings: ConnectionInput, connectionId?: string) =>
    call<
      | { ok: true; version: string; database: string | null; databases: string[]; ms: number }
      | { ok: false; error: { errno: number | null; sqlState: string | null; message: string } }
    >("POST", `/api/projects/${pid}/connections/test`, { settings, connectionId }),
  remoteForeignKeys: (pid: string, cid: string) =>
    call<{ foreignKeys: RemoteForeignKey[] }>("GET", `/api/projects/${pid}/connections/${cid}/foreign-keys`),
  remoteTables: (pid: string, cid: string) => call<{ tables: RemoteTableInfo[] }>("GET", `/api/projects/${pid}/connections/${cid}/tables`),
  remoteRows: (pid: string, cid: string, table: string, offset: number, limit: number) =>
    call<RemoteRows>("GET", `/api/projects/${pid}/connections/${cid}/tables/${encodeURIComponent(table)}/rows?offset=${offset}&limit=${limit}`),
  runRemoteSql: (pid: string, cid: string, sql: string) => call<SqlRunResult>("POST", `/api/projects/${pid}/connections/${cid}/sql`, { sql }),
  importRemoteTables: (pid: string, cid: string, tables: string[]) =>
    call<{ doc: ProjectDoc; warnings: string[] }>("POST", `/api/projects/${pid}/connections/${cid}/import`, { tables }),

  /** Downloads the .accdb via fetch so server errors can be shown instead of a broken file. */
  async downloadAccdb(id: string, fallbackName: string) {
    const res = await send(`/api/projects/${id}/export.accdb`, { credentials: "same-origin" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(data.error ?? statusMessage(res.status, "export"), res.status);
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `${fallbackName}.accdb`;
    downloadBlob(blob, name);
  },
};

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
