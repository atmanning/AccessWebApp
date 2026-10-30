import { useEffect, useState } from "react";
import { SSL_LABELS, SSL_MODES, type ConnectionInfo, type ConnectionInput, type RemoteTableInfo, type SslMode } from "../../../shared/model";
import { api } from "../api";
import { ComboBox } from "../ui/ComboBox";
import { Modal, useDialogs } from "../ui/dialogs";
import { DatabaseServerIcon, LinkedTableIcon, TableIcon } from "../ui/icons";
import { useWorkspace } from "./context";

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; text: string } | { kind: "error"; text: string };

/** New / edit a MySQL connection, with Test Connection before saving. */
export function ConnectionDialog(props: { existing?: ConnectionInfo; onClose: () => void; onSaved: (c: ConnectionInfo) => void }) {
  const ws = useWorkspace();
  const e = props.existing;
  const [name, setName] = useState(e?.name ?? "");
  const [host, setHost] = useState(e?.host ?? "");
  const [port, setPort] = useState(String(e?.port ?? 3306));
  const [database, setDatabase] = useState(e?.database ?? "");
  const [user, setUser] = useState(e?.user ?? "");
  const [password, setPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(!e);
  const [showPassword, setShowPassword] = useState(false);
  const [ssl, setSsl] = useState<SslMode>(e?.ssl ?? "off");
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** A pasted mysql://user:pass@host:port/db fills in the other boxes. */
  const onHost = (v: string) => {
    const m = /^mysqlx?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?]+)(?::(\d+))?(?:\/([^?]*))?/i.exec(v.trim());
    if (!m) return setHost(v);
    setHost(m[3]);
    if (m[4]) setPort(m[4]);
    if (m[1]) setUser(decodeURIComponent(m[1]));
    if (m[2] !== undefined) {
      setPassword(decodeURIComponent(m[2]));
      setPasswordTouched(true);
    }
    if (m[5]) setDatabase(decodeURIComponent(m[5]));
    if (!name) setName(m[5] ? decodeURIComponent(m[5]) : m[3]);
  };

  const input = (): ConnectionInput | null => {
    const p = Number(port);
    if (!host.trim()) return setError("Enter the server address."), null;
    if (!user.trim()) return setError("Enter the user name."), null;
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setError("The port must be a number from 1 to 65535."), null;
    setError(null);
    return {
      name: name.trim() || host.trim(),
      host: host.trim(),
      port: p,
      database: database.trim(),
      user: user.trim(),
      // Untouched when editing = keep the saved password.
      ...(passwordTouched ? { password } : {}),
      ssl,
    };
  };

  const runTest = async () => {
    const i = input();
    if (!i) return;
    setTest({ kind: "testing" });
    try {
      const r = await api.testConnection(ws.projectId, i, e?.id);
      if (r.ok) {
        setTest({
          kind: "ok",
          text: `Connection succeeded. Server ${r.version}${r.database ? `, database ${r.database}` : ", no database selected"} (${r.ms} ms).`,
        });
      } else {
        const err = r.error;
        setTest({ kind: "error", text: `ERROR${err.errno ? ` ${err.errno}` : ""}${err.sqlState ? ` (${err.sqlState})` : ""}: ${err.message}` });
      }
    } catch (x) {
      setTest({ kind: "error", text: (x as Error).message });
    }
  };

  const save = async () => {
    const i = input();
    if (!i) return;
    setSaving(true);
    try {
      const r = e ? await api.updateConnection(ws.projectId, e.id, i) : await api.createConnection(ws.projectId, i);
      props.onSaved(r.connection);
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={e ? `Edit Connection - ${e.name}` : "New MySQL Connection"}
      onClose={props.onClose}
      width={520}
      footer={
        <>
          <button onClick={runTest} disabled={test.kind === "testing"} className="test-connection">
            {test.kind === "testing" ? "Testing…" : "Test Connection"}
          </button>
          <span className="spacer" />
          <button className="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "OK"}</button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <div className="conn-form">
        <label>
          Connection name
          <input className="text-input" value={name} onChange={(x) => setName(x.target.value)} placeholder="e.g. Production shop" maxLength={64} />
        </label>
        <label className="wide">
          Server (address or mysql:// URL)
          <input className="text-input" value={host} onChange={(x) => onHost(x.target.value)} placeholder="db.example.com" autoComplete="off" />
        </label>
        <label className="narrow">
          Port
          <input className="text-input" value={port} onChange={(x) => setPort(x.target.value.replace(/\D/g, ""))} inputMode="numeric" />
        </label>
        <label className="wide">
          Database
          <input className="text-input" value={database} onChange={(x) => setDatabase(x.target.value)} placeholder="Needed to list, link and import tables" />
        </label>
        <label>
          User name
          <input className="text-input" value={user} onChange={(x) => setUser(x.target.value)} autoComplete="off" />
        </label>
        <label>
          Password
          <span className="password-row">
            <input
              className="text-input"
              type={showPassword ? "text" : "password"}
              value={password}
              autoComplete="new-password"
              placeholder={e && !passwordTouched ? (e.hasPassword ? "(saved; type to change)" : "(none)") : ""}
              onChange={(x) => {
                setPassword(x.target.value);
                setPasswordTouched(true);
              }}
            />
            <button type="button" className="show-pw" onClick={() => setShowPassword((v) => !v)}>{showPassword ? "Hide" : "Show"}</button>
          </span>
        </label>
        <label className="wide">
          SSL / TLS
          <ComboBox className="text-input" value={ssl} ariaLabel="SSL" options={SSL_MODES.map((m) => ({ value: m, label: SSL_LABELS[m] }))} onChange={setSsl} />
        </label>
      </div>
      {test.kind === "ok" && <div className="test-result ok" role="status">{test.text}</div>}
      {test.kind === "error" && <pre className="test-result error" role="alert">{test.text}</pre>}
      {error && <div className="field-error">{error}</div>}
      <p className="small muted">
        The password is stored encrypted with this database and is never shown again. Everyone who can edit this database can use the
        connection; people with view access can browse its linked tables.
      </p>
    </Modal>
  );
}

/** External Data > MySQL > Connections: list, add, edit, delete. */
export function ConnectionsManager(props: { onClose: () => void; onOpenConsole: (c: ConnectionInfo) => void }) {
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const [editing, setEditing] = useState<ConnectionInfo | "new" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const list = ws.connections ?? [];
  const current = list.find((c) => c.id === selected) ?? null;

  useEffect(() => {
    if (!list.length && !ws.readOnly) setEditing("new");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (c: ConnectionInfo) => {
    const links = (ws.doc.linkedTables ?? []).filter((t) => t.connectionId === c.id).length;
    if (!(await dialogs.confirm("Delete connection", `Delete the connection '${c.name}'?${links ? ` ${links} linked table(s) that use it will stop working.` : ""}`, { okLabel: "Delete", danger: true }))) return;
    try {
      await api.deleteConnection(ws.projectId, c.id);
      await ws.refreshConnections();
      setSelected(null);
    } catch (e) {
      dialogs.alert("Delete connection", (e as Error).message);
    }
  };

  return (
    <>
      <Modal
        title="MySQL Connections"
        onClose={props.onClose}
        width={560}
        footer={<button className="primary" onClick={props.onClose}>Close</button>}
      >
        <div className="conn-manager">
          <div className="list-box conn-list" role="listbox">
            {list.map((c) => (
              <div
                key={c.id}
                role="option"
                aria-selected={c.id === selected}
                className={`list-item ${c.id === selected ? "selected" : ""}`}
                onClick={() => setSelected(c.id)}
                onDoubleClick={() => !ws.readOnly && setEditing(c)}
              >
                <DatabaseServerIcon />
                <div>
                  <div>{c.name}</div>
                  <div className="small muted">
                    {c.user}@{c.host}:{c.port}
                    {c.database ? `/${c.database}` : ""}
                  </div>
                </div>
              </div>
            ))}
            {!list.length && <div className="muted pad">No connections yet. Click New to connect to a MySQL or MariaDB server.</div>}
          </div>
          <div className="conn-actions">
            <button disabled={ws.readOnly} onClick={() => setEditing("new")}>New…</button>
            <button disabled={!current || ws.readOnly} onClick={() => current && setEditing(current)}>Edit…</button>
            <button disabled={!current || ws.readOnly} onClick={() => current && remove(current)}>Delete</button>
            <button disabled={!current || ws.readOnly} onClick={() => current && props.onOpenConsole(current)}>SQL Console</button>
          </div>
        </div>
      </Modal>
      {editing && (
        <ConnectionDialog
          existing={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={async (c) => {
            setEditing(null);
            await ws.refreshConnections();
            setSelected(c.id);
            ws.setStatus(`Saved connection ${c.name}.`);
          }}
        />
      )}
    </>
  );
}

/** Pick a connection and some of its tables, to link or to import. */
export function RemoteTablesDialog(props: {
  mode: "link" | "import";
  onClose: () => void;
  onDone: (connection: ConnectionInfo, tables: RemoteTableInfo[]) => Promise<void> | void;
  onNewConnection: () => void;
}) {
  const ws = useWorkspace();
  const list = ws.connections ?? [];
  const [cid, setCid] = useState(list[0]?.id ?? "");
  const [tables, setTables] = useState<RemoteTableInfo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connection = list.find((c) => c.id === cid);

  useEffect(() => {
    if (!cid) return;
    setTables(null);
    setPicked(new Set());
    setError(null);
    api.remoteTables(ws.projectId, cid).then(
      (r) => setTables(r.tables),
      (e) => setError((e as Error).message),
    );
  }, [cid, ws.projectId]);

  const verb = props.mode === "link" ? "Link" : "Import";
  const toggle = (n: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <Modal
      title={props.mode === "link" ? "Link Tables - MySQL" : "Import Tables - MySQL"}
      onClose={props.onClose}
      width={520}
      footer={
        <>
          <button
            className="primary"
            disabled={!picked.size || busy || !connection}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onDone(connection!, (tables ?? []).filter((t) => picked.has(t.name)));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? `${verb}ing…` : `${verb} ${picked.size || ""}`.trim()}
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      {!list.length ? (
        <p>
          No MySQL connections yet. <button className="link" onClick={props.onNewConnection}>Create a connection</button> first.
        </p>
      ) : (
        <>
          <label className="conn-pick">
            Connection
            <ComboBox
              className="text-input"
              value={cid}
              ariaLabel="Connection"
              options={list.map((c) => ({ value: c.id, label: `${c.name} (${c.host}${c.database ? `/${c.database}` : ""})` }))}
              onChange={setCid}
            />
          </label>
          <p className="small muted">
            {props.mode === "link"
              ? "Linked tables stay on the MySQL server. You can browse them here and use them in queries (first 10,000 rows)."
              : "Imported tables are copied into this database with their data, keys, indexes and foreign keys (as relationships)."}
          </p>
          <div className="list-box remote-tables">
            {error && <pre className="test-result error">{error}</pre>}
            {!error && !tables && <div className="muted pad">Loading tables…</div>}
            {tables?.map((t) => (
              <label key={t.name} className="list-item check-item">
                <input type="checkbox" checked={picked.has(t.name)} onChange={() => toggle(t.name)} />
                {t.type === "view" ? <LinkedTableIcon /> : <TableIcon />} {t.name}
                <span className="muted small">
                  {t.type === "view" ? "view" : t.rows !== null ? `~${t.rows.toLocaleString()} rows` : ""}
                </span>
              </label>
            ))}
            {tables && !tables.length && <div className="muted pad">This database has no tables.</div>}
          </div>
          {tables && tables.length > 0 && (
            <div className="button-row">
              <button onClick={() => setPicked(new Set(tables.map((t) => t.name)))}>Select All</button>
              <button onClick={() => setPicked(new Set())}>Deselect All</button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
