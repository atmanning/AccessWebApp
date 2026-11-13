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
import type { TemplateId } from "../../shared/templates";

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

export const api = {
  me: () => call<{ user: UserInfo | null }>("GET", "/api/auth/me"),
  /** Which build is running: commit and build time. */
  version: () => call<VersionInfo>("GET", "/api/version"),
  login: (email: string, password: string) => call<{ user: UserInfo }>("POST", "/api/auth/login", { email, password }),
  register: (name: string, email: string, password: string) =>
    call<{ user: UserInfo }>("POST", "/api/auth/register", { name, email, password }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout", {}),

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
