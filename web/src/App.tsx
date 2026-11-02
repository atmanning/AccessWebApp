import { useEffect, useRef, useState } from "react";
import { useLayoutAttributes } from "./ui/layout";
import { LayoutPicker } from "./ui/LayoutPicker";
import type { ProjectRecord, ProjectSummary, UserInfo } from "../../shared/model";
import { TEMPLATES, type TemplateId } from "../../shared/templates";
import { api } from "./api";
import { DialogProvider, showImportWarnings, useDialogs } from "./ui/dialogs";
import { AccessIcon, TableIcon } from "./ui/icons";
import { Workspace } from "./workspace/Workspace";
import { validateObjectName } from "./workspace/docOps";
import { emptyProject } from "../../shared/model";

export default function App() {
  return (
    <DialogProvider>
      <Root />
    </DialogProvider>
  );
}

function Root() {
  useLayoutAttributes();
  const [user, setUser] = useState<UserInfo | null | undefined>(undefined);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Not signed in: a database published for public viewing, opened from its link (undefined = still checking).
  const [guestProject, setGuestProject] = useState<ProjectRecord | null | undefined>(undefined);
  const [wantsSignIn, setWantsSignIn] = useState(false);

  useEffect(() => {
    api.me().then((r) => setUser(r.user), () => setUser(null));
  }, []);

  const linkedId = () => new URLSearchParams(location.search).get("db");

  // Signed out with a database link: it opens without an account if its owner published it.
  useEffect(() => {
    if (user !== null) return;
    const id = linkedId();
    if (!id) return setGuestProject(null);
    api.getPublicProject(id).then(
      (r) => {
        setGuestProject(r.project);
        document.title = `${r.project.name} - Access Web`;
      },
      () => setGuestProject(null),
    );
  }, [user]);

  // Keep the open database in the URL so a refresh reopens it.
  useEffect(() => {
    if (!user) return;
    const id = linkedId();
    if (id && !project) {
      api.getProject(id).then(
        (r) => open(r.project),
        async (e) => {
          // Not shared with this account, but maybe published for anyone to view.
          if (e.status === 404) {
            const pub = await api.getPublicProject(id).catch(() => null);
            if (pub) return open(pub.project);
          }
          history.replaceState(null, "", "/");
          setLinkError(
            e.status === 404
              ? "That database doesn't exist or hasn't been shared with you. Ask its owner to share it with the email you signed in with."
              : e.message,
          );
        },
      );
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (p: ProjectRecord | null) => {
    setProject(p);
    history.replaceState(null, "", p ? `/?db=${p.id}` : "/");
    document.title = p ? `${p.name} - Access Web` : "Access Web";
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    open(null);
    setUser(null);
  };

  if (user === undefined || (user === null && guestProject === undefined)) return <div className="splash"><AccessIcon size={48} /></div>;
  if (!user && guestProject && !wantsSignIn) {
    return (
      <Workspace
        key={guestProject.id}
        project={guestProject}
        user={GUEST}
        onClose={() => setWantsSignIn(true)}
        onSignOut={() => setWantsSignIn(true)}
        onOpenProject={() => setWantsSignIn(true)}
      />
    );
  }
  if (!user) return <AuthScreen onSignedIn={setUser} onBack={guestProject ? () => setWantsSignIn(false) : undefined} />;
  if (project) return <Workspace key={project.id} project={project} user={user} onClose={() => open(null)} onSignOut={signOut} onOpenProject={open} />;
  return <Home user={user} onOpen={open} onSignOut={signOut} notice={linkError} onDismissNotice={() => setLinkError(null)} />;
}

/** Shown as the "user" of a public database opened without signing in. */
const GUEST: UserInfo = { id: "", email: "", name: "Guest" };

function AuthScreen({ onSignedIn, onBack }: { onSignedIn: (u: UserInfo) => void; onBack?: () => void }) {
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = mode === "signin" ? await api.login(email, password) : await api.register(name, email, password);
      onSignedIn(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <AccessIcon size={40} />
          <div>
            <div className="auth-product">Access Web</div>
            <div className="muted small">Desktop-style databases in your browser</div>
          </div>
        </div>
        <h1>{mode === "signin" ? "Sign in" : "Create account"}</h1>
        {mode === "register" && (
          <label>
            Name
            <input className="text-input wide" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label>
          Email
          <input className="text-input wide" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            className="text-input wide"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={mode === "register" ? 8 : undefined}
            required
          />
        </label>
        {mode === "register" && <div className="small muted">At least 8 characters.</div>}
        {error && <div className="field-error" role="alert">{error}</div>}
        <button className="primary wide" disabled={busy}>{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</button>
        <div className="auth-switch">
          {mode === "signin" ? "No account? " : "Already have an account? "}
          <button type="button" className="link" onClick={() => { setMode(mode === "signin" ? "register" : "signin"); setError(null); }}>
            {mode === "signin" ? "Create one" : "Sign in"}
          </button>
        </div>
        {onBack && (
          <div className="auth-switch">
            <button type="button" className="link" onClick={onBack}>Back to the database</button>
          </div>
        )}
      </form>
    </div>
  );
}

function Home({
  user,
  onOpen,
  onSignOut,
  notice,
  onDismissNotice,
}: {
  user: UserInfo;
  onOpen: (p: ProjectRecord) => void;
  onSignOut: () => void;
  notice?: string | null;
  onDismissNotice?: () => void;
}) {
  const dialogs = useDialogs();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [shared, setShared] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.listProjects().then(
      (r) => {
        setProjects(r.projects);
        setShared(r.shared);
      },
      (e) => setError(e.message),
    );
  useEffect(() => {
    load();
  }, []);

  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const importFile = async (file: File) => {
    let base = file.name.replace(/\.[^.]+$/, "").replace(/[.!`[\]]/g, "_").trim().slice(0, 60) || "Imported";
    for (let n = 2; projects?.some((p) => p.name.toLowerCase() === base.toLowerCase()); n++) base = `${base.replace(/ \(\d+\)$/, "")} (${n})`;
    const name = await dialogs.prompt("Open Access database", `Import "${file.name}" as a new database named:`, base, (v) =>
      validateObjectName(emptyProject(), "table", v),
    );
    if (!name) return;
    setImporting(true);
    try {
      const r = await api.importAccessProject(file, name);
      onOpen(r.project);
      if (r.warnings.length) showImportWarnings(dialogs, r.warnings);
    } catch (e) {
      dialogs.alert("Open Access database", (e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const create = async (template: TemplateId) => {
    const base = template === "blank" ? "Database" : "Contacts";
    let n = 1;
    while (projects?.some((p) => p.name.toLowerCase() === `${base}${n}`.toLowerCase())) n++;
    const name = await dialogs.prompt(TEMPLATES[template].label, "File Name:", `${base}${n}`, (v) =>
      validateObjectName(emptyProject(), "table", v),
    );
    if (!name) return;
    try {
      const r = await api.createProject(name, template);
      onOpen(r.project);
    } catch (e) {
      dialogs.alert("Access Web", (e as Error).message);
    }
  };

  const open = async (id: string) => {
    try {
      onOpen((await api.getProject(id)).project);
    } catch (e) {
      dialogs.alert("Access Web", (e as Error).message);
    }
  };

  const remove = async (p: ProjectSummary) => {
    const ok =
      p.role === "owner"
        ? await dialogs.confirm("Delete database", `Permanently delete '${p.name}' and all its data? This can't be undone.`, { okLabel: "Delete", danger: true })
        : await dialogs.confirm("Remove from list", `Remove '${p.name}' from Shared with me? ${p.ownerName} can share it with you again.`, { okLabel: "Remove" });
    if (!ok) return;
    await api.deleteProject(p.id).catch((e) => dialogs.alert("Access Web", e.message));
    load();
  };

  const rename = async (p: ProjectSummary) => {
    const name = await dialogs.prompt("Rename", "Database name:", p.name, (v) => validateObjectName(emptyProject(), "table", v));
    if (!name || name === p.name) return;
    await api.saveProject(p.id, p.revision, { name }).catch((e) => dialogs.alert("Access Web", e.message));
    load();
  };

  return (
    <div className="home">
      <nav className="home-nav">
        <div className="home-brand">
          <AccessIcon size={28} /> <span>Access</span>
        </div>
        <button className="active">Home</button>
        <button onClick={() => create("blank")}>New</button>
        <div className="spacer" />
        <div className="home-user">
          <div>{user.name}</div>
          <div className="small">{user.email}</div>
        </div>
        <LayoutPicker className="home-layout" />
        <button onClick={onSignOut}>Sign out</button>
      </nav>
      <main className="home-main">
        <h1>Good {greeting()}, {user.name.split(" ")[0]}</h1>
        {notice && (
          <div className="message-bar home-notice" role="alert">
            {notice}
            <button onClick={onDismissNotice}>OK</button>
          </div>
        )}
        <div className="template-row">
          <button className="template-tile" onClick={() => fileInput.current?.click()} disabled={importing}>
            <div className="template-art access-file">
              <AccessIcon size={56} />
            </div>
            <div className="template-name">{importing ? "Importing…" : "Open Access database"}</div>
            <div className="small muted">Import an .accdb or .mdb file: tables, data, keys, relationships and queries.</div>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".accdb,.mdb,.accde,.mde"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) importFile(f);
            }}
          />
          {(Object.keys(TEMPLATES) as TemplateId[]).map((t) => (
            <button key={t} className="template-tile" onClick={() => create(t)}>
              <div className={`template-art ${t}`}>
                {t === "blank" ? <span className="plus">＋</span> : <TableIcon size={56} />}
              </div>
              <div className="template-name">{TEMPLATES[t].label}</div>
              <div className="small muted">{TEMPLATES[t].description}</div>
            </button>
          ))}
        </div>
        <h2>My databases</h2>
        {error && <div className="field-error">{error}</div>}
        {projects && !projects.length && <p className="muted">You don't have any databases yet. Create one above.</p>}
        {projects && projects.length > 0 && <ProjectTable projects={projects} onOpen={open} onRename={rename} onRemove={remove} />}
        {shared.length > 0 && (
          <>
            <h2>Shared with me</h2>
            <ProjectTable projects={shared} onOpen={open} onRemove={remove} shared />
          </>
        )}
      </main>
    </div>
  );
}

const ROLE_LABEL = { owner: "Owner", edit: "Can edit", view: "Can view" } as const;

function ProjectTable(props: {
  projects: ProjectSummary[];
  shared?: boolean;
  onOpen: (id: string) => void;
  onRename?: (p: ProjectSummary) => void;
  onRemove: (p: ProjectSummary) => void;
}) {
  return (
    <table className="recent-table">
      <thead>
        <tr>
          <th>Name</th>
          {props.shared && <th className="col-minor">Owner</th>}
          {props.shared && <th>Access</th>}
          <th className="col-minor">Tables</th>
          <th className="col-minor">Date modified</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.projects.map((p) => (
          <tr key={p.id} onDoubleClick={() => props.onOpen(p.id)}>
            <td>
              <button className="link recent-name" onClick={() => props.onOpen(p.id)}>
                <AccessIcon size={18} /> {p.name}
              </button>
            </td>
            {props.shared && <td className="col-minor">{p.ownerName}</td>}
            {props.shared && <td><span className={`role-badge ${p.role}`}>{ROLE_LABEL[p.role]}</span></td>}
            <td className="col-minor">{p.tableCount}</td>
            <td className="col-minor">
              {new Date(p.updatedAt).toLocaleString()}
              {p.updatedByName && <span className="muted small"> by {p.updatedByName}</span>}
            </td>
            <td className="recent-actions">
              {props.onRename && <button onClick={() => props.onRename!(p)}>Rename</button>}
              <button onClick={() => props.onRemove(p)}>{p.role === "owner" ? "Delete" : "Remove"}</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
