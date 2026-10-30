import type {
  LinkAccess,
  ProjectDoc,
  ProjectRecord,
  ProjectSummary,
  SharePermission,
  ShareSettings,
  UserInfo,
} from "../../shared/model";
import type { TemplateId } from "../../shared/templates";

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Requested-With": "fetch",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data);
  return data as T;
}

async function upload<T>(url: string, file: File): Promise<T> {
  if (file.size > 100 * 1024 * 1024) throw new ApiError("That file is larger than 100 MB.", 413);
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-Requested-With": "fetch", "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Upload failed (${res.status})`, res.status, data);
  return data as T;
}

export const api = {
  me: () => call<{ user: UserInfo | null }>("GET", "/api/auth/me"),
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

  /** Creates a new database from an Access file. */
  importAccessProject: (file: File, name: string) =>
    upload<{ project: ProjectRecord; warnings: string[] }>(`/api/projects/import-access?name=${encodeURIComponent(name)}`, file),
  /** Reads an Access file's objects without saving them, to merge into the open database. */
  convertAccess: (file: File) => upload<{ doc: ProjectDoc; warnings: string[] }>("/api/projects/convert-access", file),

  /** Downloads the .accdb via fetch so server errors can be shown instead of a broken file. */
  async downloadAccdb(id: string, fallbackName: string) {
    const res = await fetch(`/api/projects/${id}/export.accdb`, { credentials: "same-origin" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(data.error ?? `Export failed (${res.status})`, res.status);
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
