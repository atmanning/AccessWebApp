import { useEffect, useState } from "react";
import type { ProjectRecord, ProjectSummary, UserInfo } from "../../shared/model";
import { TEMPLATES, type TemplateId } from "../../shared/templates";
import { api } from "./api";
import { DialogProvider, useDialogs } from "./ui/dialogs";
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
  const [user, setUser] = useState<UserInfo | null | undefined>(undefined);
  const [project, setProject] = useState<ProjectRecord | null>(null);

  useEffect(() => {
    api.me().then((r) => setUser(r.user), () => setUser(null));
  }, []);

  // Keep the open database in the URL so a refresh reopens it.
  useEffect(() => {
    if (!user) return;
    const id = new URLSearchParams(location.search).get("db");
    if (id && !project) api.getProject(id).then((r) => setProject(r.project), () => history.replaceState(null, "", "/"));
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

  if (user === undefined) return <div className="splash"><AccessIcon size={48} /></div>;
  if (!user) return <AuthScreen onSignedIn={setUser} />;
  if (project) return <Workspace key={project.id} project={project} user={user} onClose={() => open(null)} onSignOut={signOut} />;
  return <Home user={user} onOpen={open} onSignOut={signOut} />;
}

function AuthScreen({ onSignedIn }: { onSignedIn: (u: UserInfo) => void }) {
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
      </form>
    </div>
  );
}

function Home({ user, onOpen, onSignOut }: { user: UserInfo; onOpen: (p: ProjectRecord) => void; onSignOut: () => void }) {
  const dialogs = useDialogs();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listProjects().then((r) => setProjects(r.projects), (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

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
    if (!(await dialogs.confirm("Delete database", `Permanently delete '${p.name}' and all its data? This can't be undone.`, { okLabel: "Delete", danger: true }))) return;
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
        <button onClick={onSignOut}>Sign out</button>
      </nav>
      <main className="home-main">
        <h1>Good {greeting()}, {user.name.split(" ")[0]}</h1>
        <div className="template-row">
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
        <h2>Recent</h2>
        {error && <div className="field-error">{error}</div>}
        {projects && !projects.length && <p className="muted">You don't have any databases yet. Create one above.</p>}
        {projects && projects.length > 0 && (
          <table className="recent-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Tables</th>
                <th>Date modified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} onDoubleClick={() => open(p.id)}>
                  <td>
                    <button className="link recent-name" onClick={() => open(p.id)}>
                      <AccessIcon size={18} /> {p.name}
                    </button>
                  </td>
                  <td>{p.tableCount}</td>
                  <td>{new Date(p.updatedAt).toLocaleString()}</td>
                  <td className="recent-actions">
                    <button onClick={() => rename(p)}>Rename</button>
                    <button onClick={() => remove(p)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
