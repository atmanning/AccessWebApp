/**
 * Site admin page (/admin): who has registered, how much they use the site, and an activity log.
 * It shows database names and sizes, never what's in anyone's tables.
 */
import { useEffect, useMemo, useState } from "react";
import { ACTIVITY_ACTIONS, type ActivityAction, type ActivityEntry, type AdminOverview, type AdminUserDetail, type AdminUserRow } from "../../../shared/activity";
import type { UserInfo } from "../../../shared/model";
import { api, type AdminActivityFilter } from "../api";
import { POLICY_VERSION } from "../../../shared/policy";
import { AccessIcon } from "../ui/icons";
import { AdminPlans } from "./AdminPlans";
import "./admin.css";

type Tab = "overview" | "people" | "plans" | "activity";

export function AdminPage({ user, onExit }: { user: UserInfo; onExit: () => void }) {
  const [tab, setTab] = useState<Tab>(() => (["people", "plans", "activity"].includes(location.hash.slice(1)) ? (location.hash.slice(1) as Tab) : "overview"));
  const [person, setPerson] = useState<string | null>(null);
  const [filter, setFilter] = useState<AdminActivityFilter & { userLabel?: string }>({});

  useEffect(() => {
    history.replaceState(null, "", `/admin${tab === "overview" ? "" : `#${tab}`}`);
  }, [tab]);
  useEffect(() => {
    document.title = "Site admin - Access Web";
  }, []);

  const showActivityFor = (u: { id: string; name: string; email: string }, action?: ActivityAction) => {
    setFilter({ user: u.id, userLabel: u.name || u.email, ...(action ? { action } : {}) });
    setPerson(null);
    setTab("activity");
  };

  return (
    <div className="admin">
      <header className="admin-bar">
        <AccessIcon size={24} />
        <strong>Site admin</strong>
        <nav className="admin-tabs" aria-label="Admin sections">
          {(["overview", "people", "plans", "activity"] as Tab[]).map((t) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              aria-current={tab === t ? "page" : undefined}
              onClick={() => {
                setTab(t);
                if (t === "people") setPerson(null);
              }}
            >
              {t === "overview" ? "Overview" : t === "people" ? "People" : t === "plans" ? "Plans" : "Activity"}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="admin-me small">{user.email}</span>
        <button className="admin-exit" onClick={onExit}>
          My databases
        </button>
      </header>
      <main className="admin-main">
        {tab === "overview" && <Overview onPeople={() => setTab("people")} onActivity={(action) => (setFilter({ action }), setTab("activity"))} />}
        {tab === "people" && (person ? <Person id={person} onBack={() => setPerson(null)} onActivity={showActivityFor} /> : <People onOpen={setPerson} onErrors={(u) => showActivityFor(u, "error")} />)}
        {tab === "plans" && <AdminPlans />}
        {tab === "activity" && <Activity filter={filter} setFilter={setFilter} onPerson={(id) => (setPerson(id), setTab("people"))} />}
      </main>
    </div>
  );
}

// ---- Overview ------------------------------------------------------------------------------

function Overview({ onPeople, onActivity }: { onPeople: () => void; onActivity: (action: ActivityAction) => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.adminOverview().then(setData, (e) => setError(e.message));
  }, []);
  if (error) return <div className="field-error">{error}</div>;
  if (!data) return <Loading />;
  return (
    <>
      <h1>Overview</h1>
      <div className="admin-tiles">
        <Tile label="People registered" value={data.users} note={`${data.newUsers7} new this week · ${data.newUsers30} this month`} onClick={onPeople} />
        <Tile label="Active today" value={data.active1} note={`${data.active7} this week · ${data.active30} this month`} onClick={onPeople} />
        <Tile label="Databases" value={data.databases} note={`${bytes(data.storageBytes)} stored`} />
        <Tile label="Sharing" value={data.shares} note={`people shared with · ${data.publicReports} public report${data.publicReports === 1 ? "" : "s"}`} />
        <Tile label="Server errors" value={data.errors24} note="in the last 24 hours" warn={data.errors24 > 0} onClick={() => onActivity("error")} />
        <Tile label="Failed sign-ins" value={data.failedLogins24} note="in the last 24 hours" warn={data.failedLogins24 >= 20} onClick={() => onActivity("login_failed")} />
      </div>
      <div className="admin-charts">
        <DayBars title="Sign-ups per day" days={data.days.map((d) => ({ day: d.day, n: d.signups }))} />
        <DayBars title="People active per day" days={data.days.map((d) => ({ day: d.day, n: d.active }))} />
      </div>
      <p className="small muted">
        The last 30 days, by UTC date. The activity log keeps {data.logDays} days. It records what people did and sizes, never what's in their tables.
      </p>
    </>
  );
}

function Tile(props: { label: string; value: number; note: string; warn?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <div className="admin-tile-label">{props.label}</div>
      <div className="admin-tile-value">{props.value.toLocaleString()}</div>
      <div className="admin-tile-note small">{props.note}</div>
    </>
  );
  return props.onClick ? (
    <button className={`admin-tile ${props.warn ? "warn" : ""}`} onClick={props.onClick}>
      {body}
    </button>
  ) : (
    <div className={`admin-tile ${props.warn ? "warn" : ""}`}>{body}</div>
  );
}

function DayBars({ title, days }: { title: string; days: { day: string; n: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.n));
  const total = days.reduce((s, d) => s + d.n, 0);
  const W = 300;
  const H = 90;
  const bw = W / days.length;
  return (
    <figure className="admin-chart">
      <figcaption>
        {title} <span className="muted small">· {total.toLocaleString()} in 30 days{max > 1 ? ` · busiest day ${max}` : ""}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title}: ${days.map((d) => `${shortDay(d.day)} ${d.n}`).join(", ")}`}>
        <line x1="0" x2={W} y1={H} y2={H} className="admin-chart-axis" vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const h = d.n ? Math.max(2, (d.n / max) * (H - 4)) : 0;
          return (
            <g key={d.day}>
              <rect x={i * bw + 1} y={H - h} width={bw - 2} height={h} className="admin-chart-bar">
                <title>{`${shortDay(d.day)}: ${d.n}`}</title>
              </rect>
              {/* An invisible column so thin or empty days still show their number on hover. */}
              <rect x={i * bw} y="0" width={bw} height={H} fill="transparent">
                <title>{`${shortDay(d.day)}: ${d.n}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="admin-chart-labels small muted">
        <span>{shortDay(days[0].day)}</span>
        <span>Today</span>
      </div>
    </figure>
  );
}

// ---- People --------------------------------------------------------------------------------

type SortKey = "name" | "createdAt" | "lastSeenAt" | "databases" | "storageBytes" | "actions30";

function People({ onOpen, onErrors }: { onOpen: (id: string) => void; onErrors: (u: AdminUserRow) => void }) {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "lastSeenAt", desc: true });

  useEffect(() => {
    const t = setTimeout(() => api.adminUsers(q.trim()).then((r) => (setUsers(r.users), setError(null)), (e) => setError(e.message)), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);

  const sorted = useMemo(() => {
    if (!users) return null;
    const val = (u: AdminUserRow): string | number => (sort.key === "name" ? (u.name || u.email).toLowerCase() : sort.key === "lastSeenAt" ? (u.lastSeenAt ?? u.createdAt) : u[sort.key]);
    return [...users].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.desc ? -1 : 1);
    });
  }, [users, sort]);

  const th = (key: SortKey, label: string, cls = "") => (
    <th className={cls} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button className="admin-sort" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
        {label}
        {sort.key === key ? (sort.desc ? " ▾" : " ▴") : ""}
      </button>
    </th>
  );

  return (
    <>
      <h1>People {users && <span className="muted admin-count">{users.length.toLocaleString()}</span>}</h1>
      <input className="text-input admin-search" type="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
      {error && <div className="field-error">{error}</div>}
      {!sorted ? (
        <Loading />
      ) : !sorted.length ? (
        <p className="muted">{q ? "No one matches that." : "No one has registered yet."}</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                {th("name", "Person")}
                {th("createdAt", "Joined", "col-minor")}
                {th("lastSeenAt", "Last active")}
                {th("databases", "Databases", "num")}
                {th("storageBytes", "Storage", "num col-minor")}
                {th("actions30", "Actions (30 days)", "num col-minor")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((u) => (
                <tr key={u.id} className="clickable" onClick={() => onOpen(u.id)}>
                  <td>
                    <button className="link admin-person" onClick={(e) => (e.stopPropagation(), onOpen(u.id))}>
                      {u.name || u.email}
                    </button>
                    {u.errors30 > 0 && <ErrorFlag u={u} onClick={() => onErrors(u)} />}
                    {u.admin && <span className="admin-badge">Admin</span>}
                    {u.suspendedAt && <span className="admin-badge suspended">Suspended</span>}
                    <div className="small muted">{u.email}</div>
                  </td>
                  <td className="col-minor" title={fullTime(u.createdAt)}>
                    {shortDate(u.createdAt)}
                  </td>
                  <td title={u.lastSeenAt ? fullTime(u.lastSeenAt) : undefined}>{u.lastSeenAt ? ago(u.lastSeenAt) : <span className="muted">never</span>}</td>
                  <td className="num">
                    {u.databases}
                    {u.sharedWithThem > 0 && <div className="small muted">+{u.sharedWithThem} shared</div>}
                  </td>
                  <td className="num col-minor">{bytes(u.storageBytes)}</td>
                  <td className="num col-minor">{u.actions30.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** A "!" by someone who ran into server errors lately: click to see them. */
function ErrorFlag({ u, onClick }: { u: AdminUserRow; onClick: () => void }) {
  const fresh = !!u.lastErrorAt && (!u.errorsSeenAt || u.lastErrorAt > u.errorsSeenAt);
  const label = `${u.errors30} server error${u.errors30 === 1 ? "" : "s"} in the last 30 days${u.lastErrorAt ? `, the latest ${ago(u.lastErrorAt)}` : ""}${fresh ? " (not looked at yet)" : " (already looked at)"}. Click to see them.`;
  return (
    <button
      className={`admin-error-flag ${fresh ? "fresh" : "seen"}`}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      !
    </button>
  );
}

function Person({ id, onBack, onActivity }: { id: string; onBack: () => void; onActivity: (u: AdminUserDetail, action?: ActivityAction) => void }) {
  const [u, setU] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    api.adminUser(id).then(setU, (e) => setError(e.message));
  }, [id, loaded]);
  return (
    <>
      <button className="link admin-back" onClick={onBack}>
        ‹ All people
      </button>
      {error && <div className="field-error">{error}</div>}
      {!u && !error && <Loading />}
      {u && (
        <>
          <h1>
            {u.name || u.email} {u.errors30 > 0 && <ErrorFlag u={u} onClick={() => onActivity(u, "error")} />}
            {u.admin && <span className="admin-badge">Admin</span>}
            {u.suspendedAt && <span className="admin-badge suspended">Suspended</span>}
          </h1>
          <Suspension u={u} onChanged={() => setLoaded((n) => n + 1)} />
          <dl className="admin-facts">
            <div>
              <dt>Email</dt>
              <dd>{u.email}</dd>
            </div>
            <div>
              <dt>Joined</dt>
              <dd>{fullTime(u.createdAt)}</dd>
            </div>
            <div>
              <dt>Last active</dt>
              <dd>{u.lastSeenAt ? `${ago(u.lastSeenAt)} (${fullTime(u.lastSeenAt)})` : "never"}</dd>
            </div>
            <div>
              <dt>Signed in on</dt>
              <dd>
                {u.signedInDevices} device{u.signedInDevices === 1 ? "" : "s"} or browser{u.signedInDevices === 1 ? "" : "s"}
              </dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd>{bytes(u.storageBytes)}</dd>
            </div>
            <div>
              <dt>Usage Policy</dt>
              <dd>
                {u.policyAcceptedAt ? (
                  <>
                    Agreed {fullTime(u.policyAcceptedAt)}
                    {u.policyVersion !== POLICY_VERSION && <span className="muted"> (an older version; asked again at next visit)</span>}
                  </>
                ) : (
                  <span className="muted">Not yet (asked at their next visit)</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Shared with them</dt>
              <dd>
                {u.sharedWithThem} database{u.sharedWithThem === 1 ? "" : "s"}
              </dd>
            </div>
          </dl>

          <h2>Their databases {<span className="muted admin-count">{u.dbs.length}</span>}</h2>
          {!u.dbs.length ? (
            <p className="muted">None yet.</p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Tables</th>
                    <th className="num">Records</th>
                    <th className="num col-minor">Size</th>
                    <th>Sharing</th>
                    <th className="col-minor">Last changed</th>
                  </tr>
                </thead>
                <tbody>
                  {u.dbs.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td className="num">{d.tables}</td>
                      <td className="num">{d.records.toLocaleString()}</td>
                      <td className="num col-minor">{bytes(d.sizeBytes)}</td>
                      <td className="small">{sharing(d) || <span className="muted">private</span>}</td>
                      <td className="col-minor" title={fullTime(d.updatedAt)}>
                        {ago(d.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>
            Recent activity
            <button className="admin-h-action" onClick={() => onActivity(u)}>
              Search all their activity
            </button>
          </h2>
          <ActivityList entries={u.activity.slice(0, 50)} hidePerson />
        </>
      )}
    </>
  );
}

/** Suspend (ban) an account for misuse, or reinstate it. */
function Suspension({ u, onChanged }: { u: AdminUserDetail; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      setOpen(false);
      setReason("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (u.admin) return null;
  if (u.suspendedAt) {
    return (
      <div className="admin-suspended" role="status">
        <div>
          <strong>Suspended {fullTime(u.suspendedAt)}.</strong> {u.suspendedReason && <>Reason: {u.suspendedReason}</>}
          <div className="small">They can't sign in, and their databases are closed to the people they shared them with and to public links. Nothing has been deleted.</div>
        </div>
        <button disabled={busy} onClick={() => void run(() => api.adminUnsuspend(u.id))}>
          Reinstate account
        </button>
        {error && <div className="field-error">{error}</div>}
      </div>
    );
  }
  if (!open) {
    return (
      <div className="admin-suspend-row">
        <button className="danger" onClick={() => setOpen(true)}>
          Suspend account…
        </button>
      </div>
    );
  }
  return (
    <form
      className="admin-suspend-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.adminSuspend(u.id, reason));
      }}
    >
      <strong>Suspend {u.name || u.email}?</strong>
      <p className="small">
        For misuse under the Usage Policy. They'll be signed out everywhere and won't be able to sign in. Their databases close to the people they shared them with and to
        public links. Nothing is deleted, and you can reinstate the account later. Consider emailing them to say why.
      </p>
      <label className="small">
        Reason (kept with the account and in the activity log)
        <input className="text-input" value={reason} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. Phishing page in a public report" />
      </label>
      {error && <div className="field-error">{error}</div>}
      <div className="admin-suspend-buttons">
        <button type="submit" className="danger" disabled={busy || !reason.trim()}>
          {busy ? "Suspending…" : "Suspend account"}
        </button>
        <button type="button" onClick={() => (setOpen(false), setError(null))}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function sharing(d: AdminUserDetail["dbs"][number]) {
  const parts: string[] = [];
  if (d.sharedWith) parts.push(`${d.sharedWith} ${d.sharedWith === 1 ? "person" : "people"}`);
  if (d.linkAccess !== "none") parts.push(`link (${d.linkAccess})`);
  if (d.publicView) parts.push("public");
  if (d.publicReports) parts.push(`${d.publicReports} public report${d.publicReports === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// ---- Activity ------------------------------------------------------------------------------

function Activity(props: { filter: AdminActivityFilter & { userLabel?: string }; setFilter: (f: AdminActivityFilter & { userLabel?: string }) => void; onPerson: (id: string) => void }) {
  const { filter, setFilter } = props;
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [more, setMore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(filter.q ?? "");
  const [busy, setBusy] = useState(false);
  const [refreshed, setRefreshed] = useState(0);

  // Typing in the search box filters after a short pause.
  useEffect(() => {
    const t = setTimeout(() => text !== (filter.q ?? "") && setFilter({ ...filter, q: text }), 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setEntries(null);
    api.adminActivity(filter).then(
      (r) => {
        setEntries(r.entries);
        setMore(r.more);
        setError(null);
        // Someone's errors are on screen now: their "!" turns pastel until a new one comes.
        if (filter.user && (!filter.action || filter.action === "error") && r.entries.some((x) => x.action === "error")) void api.adminErrorsSeen(filter.user).catch(() => undefined);
      },
      (e) => setError(e.message),
    );
  }, [filter.user, filter.action, filter.q, refreshed]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    if (!more) return;
    setBusy(true);
    try {
      const r = await api.adminActivity(filter, more);
      setEntries((e) => [...(e ?? []), ...r.entries]);
      setMore(r.more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Activity</h1>
      <div className="admin-filters">
        <input className="text-input admin-search" type="search" placeholder="Search person, database, detail or IP" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search activity" />
        <select value={filter.action ?? ""} onChange={(e) => setFilter({ ...filter, action: e.target.value || undefined })} aria-label="Kind of activity">
          <option value="">All kinds of activity</option>
          {(Object.keys(ACTIVITY_ACTIONS) as ActivityAction[]).map((a) => (
            <option key={a} value={a}>
              {ACTIVITY_ACTIONS[a]}
            </option>
          ))}
        </select>
        {filter.user && (
          <span className="ix-chip admin-chip">
            {filter.userLabel ?? "One person"}
            <button aria-label="Show everyone" onClick={() => setFilter({ ...filter, user: undefined, userLabel: undefined })}>
              ×
            </button>
          </span>
        )}
        <span className="spacer" />
        <button onClick={() => setRefreshed((n) => n + 1)}>Refresh</button>
        <a className="button-link" href={api.adminActivityCsvUrl(filter)} download>
          Download CSV
        </a>
      </div>
      {error && <div className="field-error">{error}</div>}
      {!entries ? <Loading /> : <ActivityList entries={entries} onPerson={props.onPerson} />}
      {more && (
        <button className="admin-more" onClick={loadMore} disabled={busy}>
          {busy ? "Loading…" : "Show older"}
        </button>
      )}
    </>
  );
}

function ActivityList({ entries, hidePerson, onPerson }: { entries: ActivityEntry[]; hidePerson?: boolean; onPerson?: (id: string) => void }) {
  if (!entries.length) return <p className="muted">No activity matches.</p>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table admin-activity">
        <thead>
          <tr>
            <th>When</th>
            {!hidePerson && <th>Person</th>}
            <th>What</th>
            <th>Database</th>
            <th className="col-minor">Detail</th>
            <th className="col-minor">IP address</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className={e.action === "error" ? "is-error" : e.action === "login_failed" ? "is-warn" : ""}>
              <td title={e.count > 1 ? `${fullTime(e.firstAt)} – ${fullTime(e.at)}` : fullTime(e.at)} className="admin-when">
                {when(e.at)}
              </td>
              {!hidePerson && (
                <td>
                  {e.userId && onPerson ? (
                    <button className="link" onClick={() => onPerson(e.userId!)}>
                      {e.name || e.email}
                    </button>
                  ) : e.userId ? (
                    e.name || e.email
                  ) : (
                    <span className="muted">{e.action === "login_failed" ? "(not signed in)" : "anyone"}</span>
                  )}
                </td>
              )}
              <td>
                {ACTIVITY_ACTIONS[e.action] ?? e.action}
                {e.count > 1 && <span className="admin-times"> ×{e.count}</span>}
              </td>
              <td>{e.projectName ?? <span className="muted">—</span>}</td>
              <td className="col-minor small admin-detail">{e.detail}</td>
              <td className="col-minor small muted">{e.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Bits ----------------------------------------------------------------------------------

function Loading() {
  return <p className="muted">Loading…</p>;
}

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} day${s < 86400 * 2 ? "" : "s"} ago`;
  return shortDate(iso);
}
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
const fullTime = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric" });
function when(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
