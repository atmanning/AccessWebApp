/**
 * The Usage Policy: its text (shared/policy.ts), the public /policy page, and the screen that asks
 * someone to agree before they continue (people who registered before it, or before a new version).
 */
import { useEffect, useState, type ReactNode } from "react";
import type { UserInfo } from "../../../shared/model";
import { POLICY_SECTIONS, POLICY_SUMMARY, POLICY_TITLE, POLICY_VERSION, policyText } from "../../../shared/policy";
import { api } from "../api";
import { AccessIcon } from "../ui/icons";
import "./policy.css";

const SITE = "Access Web";

/** Who to contact, from the server's CONTACT_EMAIL. */
function useContact() {
  const [contact, setContact] = useState<string | null>(null);
  useEffect(() => {
    api.policyInfo().then(
      (r) => setContact(r.contact),
      () => {},
    );
  }, []);
  return contact;
}

/** Text with any email address turned into a mail link. */
function withLinks(s: string): ReactNode {
  const parts = s.split(/([^\s@()]+@[^\s@()]+\.[A-Za-z]{2,})/);
  return parts.map((p, i) => (i % 2 ? <a key={i} href={`mailto:${p}`}>{p}</a> : p));
}

const effective = () => new Date(`${POLICY_VERSION}T12:00:00Z`).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });

export function PolicyText() {
  const contact = useContact();
  const t = (s: string) => withLinks(policyText(s, SITE, contact));
  return (
    <div className="policy-text">
      <p className="policy-effective small muted">Effective {effective()}</p>
      <div className="policy-summary">
        <strong>The short version</strong>
        <ul>
          {POLICY_SUMMARY.map((s) => (
            <li key={s}>{t(s)}</li>
          ))}
        </ul>
      </div>
      {POLICY_SECTIONS.map((sec) => (
        <section key={sec.heading}>
          <h2>{sec.heading}</h2>
          {sec.paragraphs?.map((p) => (
            <p key={p}>{t(p)}</p>
          ))}
          {sec.bullets && (
            <ul>
              {sec.bullets.map((b) => (
                <li key={b}>{t(b)}</li>
              ))}
            </ul>
          )}
          {sec.after?.map((p) => (
            <p key={p}>{t(p)}</p>
          ))}
        </section>
      ))}
    </div>
  );
}

/** /policy: readable by anyone, signed in or not. */
export function PolicyPage() {
  useEffect(() => {
    document.title = `${POLICY_TITLE} - ${SITE}`;
  }, []);
  return (
    <div className="policy-page">
      <header className="policy-head">
        <AccessIcon size={28} />
        <span>{SITE}</span>
        <span className="spacer" />
        <a href="/">Open {SITE}</a>
      </header>
      <main className="policy-main">
        <h1>{POLICY_TITLE}</h1>
        <PolicyText />
      </main>
    </div>
  );
}

/** Asks a signed-in person to agree to the current policy before going on. */
export function PolicyAgreeScreen({ user, onAgreed, onSignOut }: { user: UserInfo; onAgreed: (u: UserInfo) => void; onSignOut: () => void }) {
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agree = async () => {
    setBusy(true);
    setError(null);
    try {
      onAgreed((await api.acceptPolicy(POLICY_VERSION)).user);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="policy-agree" role="dialog" aria-modal="true" aria-labelledby="policy-agree-title">
      <div className="policy-agree-card">
        <div className="policy-agree-top">
          <h1 id="policy-agree-title">Please read and agree to our {POLICY_TITLE}</h1>
          <p className="small muted">
            Hi {user.name || user.email}. To keep using {SITE}, please agree to the policy below. It explains that your data is yours and is never sold, what we record,
            and what isn't allowed.
          </p>
        </div>
        <div className="policy-agree-scroll" tabIndex={0} aria-label={POLICY_TITLE}>
          <PolicyText />
        </div>
        <div className="policy-agree-foot">
          <label className="policy-check">
            <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} /> I have read and agree to the {POLICY_TITLE}
          </label>
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
          <div className="policy-agree-buttons">
            <button className="link" onClick={onSignOut}>
              Sign out
            </button>
            <span className="spacer" />
            <button className="primary" disabled={!ticked || busy} onClick={agree}>
              {busy ? "Please wait…" : "Agree and continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
