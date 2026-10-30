import { useEffect, useState } from "react";
import type { LinkAccess, SharePermission, ShareSettings, UserInfo } from "../../../shared/model";
import { api } from "../api";
import { Modal } from "../ui/dialogs";

/** Owner-only: share with registered people by email, and set "anyone with the link" access. */
export function ShareDialog(props: { projectId: string; projectName: string; owner: UserInfo; onClose: () => void }) {
  const [settings, setSettings] = useState<ShareSettings | null>(null);
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<SharePermission>("edit");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/?db=${props.projectId}`;

  useEffect(() => {
    api.getShares(props.projectId).then(setSettings, (e) => setError(e.message));
  }, [props.projectId]);

  const run = async (fn: () => Promise<ShareSettings>) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    if (await run(() => api.share(props.projectId, email.trim(), permission))) setEmail("");
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy automatically. Select the link and copy it.");
    }
  };

  return (
    <Modal title={`Share "${props.projectName}"`} onClose={props.onClose} width={520} footer={<button className="primary" onClick={props.onClose}>Done</button>}>
      <div className="share-dialog">
        <form className="share-add" onSubmit={add}>
          <input
            className="text-input"
            type="email"
            placeholder="Email of a registered user"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email to share with"
          />
          <select value={permission} onChange={(e) => setPermission(e.target.value as SharePermission)} aria-label="Permission">
            <option value="edit">Can edit</option>
            <option value="view">Can view</option>
          </select>
          <button className="primary" disabled={busy || !email.trim()}>Share</button>
        </form>
        {error && <div className="field-error" role="alert">{error}</div>}

        <h3>People with access</h3>
        <ul className="share-list">
          <li>
            <div className="share-person">
              <div>{props.owner.name} (you)</div>
              <div className="small muted">{props.owner.email}</div>
            </div>
            <span className="share-owner">Owner</span>
          </li>
          {settings?.shares.map((s) => (
            <li key={s.userId}>
              <div className="share-person">
                <div>{s.name}</div>
                <div className="small muted">{s.email}</div>
              </div>
              <select
                value={s.permission}
                disabled={busy}
                aria-label={`Access for ${s.name}`}
                onChange={(e) => {
                  const v = e.target.value;
                  run(() => (v === "remove" ? api.unshare(props.projectId, s.userId) : api.share(props.projectId, s.email, v as SharePermission)));
                }}
              >
                <option value="edit">Can edit</option>
                <option value="view">Can view</option>
                <option value="remove">Remove access</option>
              </select>
            </li>
          ))}
          {!settings && !error && <li className="muted">Loading…</li>}
        </ul>

        <h3>General access</h3>
        <div className="share-link">
          <select
            value={settings?.linkAccess ?? "none"}
            disabled={busy || !settings}
            aria-label="General access"
            onChange={(e) => run(() => api.setLinkAccess(props.projectId, e.target.value as LinkAccess))}
          >
            <option value="none">Restricted: only people added above</option>
            <option value="view">Anyone with an account who has the link can view</option>
            <option value="edit">Anyone with an account who has the link can edit</option>
          </select>
        </div>
        <div className="share-url">
          <input className="text-input" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Link to this database" />
          <button onClick={copyLink}>{copied ? "Copied" : "Copy link"}</button>
        </div>
        <p className="small muted">
          People you add see this database under Shared with me. Editors can change everything in it; only you can share, rename or
          delete it. Anyone with access can export it or save their own copy.
        </p>
      </div>
    </Modal>
  );
}
