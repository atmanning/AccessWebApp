/**
 * Full screen: the open form (or report) on its own, without the ribbon, Navigation Pane, tabs
 * and status bar, like an app. A slim bar keeps what's needed: back (closes this one and shows
 * the one opened before), the form's caption, a menu of the database's forms, and the way out.
 */
import { useEffect, useRef, useState } from "react";
import type { ProjectDoc } from "../../../shared/model";

export interface FullScreenBarProps {
  doc: ProjectDoc;
  title: string;
  /** More than one object open: back closes this one. */
  canGoBack: boolean;
  onBack: () => void;
  activeFormId?: string;
  onOpenForm: (id: string) => void;
  onExit: () => void;
  /** Back to the start page (the list of databases). */
  onCloseDatabase?: () => void;
  /** A link that opens this form full screen (to put on a phone's home screen or send to staff). */
  link?: string;
  onCopied: (ok: boolean) => void;
}

/** Forms worth opening on their own: not ones only shown inside other forms (subforms). */
export function appForms(doc: ProjectDoc) {
  const inside = new Set(doc.forms.flatMap((f) => (f.layout?.controls ?? []).map((c) => c.sourceForm).filter(Boolean)));
  return doc.forms.filter((f) => !inside.has(f.id)).sort((a, b) => a.name.localeCompare(b.name));
}

export function FullScreenBar(p: FullScreenBarProps) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);
  const forms = appForms(p.doc);

  return (
    <header className="fs-bar">
      {p.canGoBack ? (
        <button className="fs-btn" onClick={p.onBack} aria-label="Back" title="Back (closes this and shows the one before)">
          ‹
        </button>
      ) : (
        <span className="fs-btn-space" />
      )}
      <div className="fs-title">{p.title}</div>
      <div className="fs-menu-wrap" ref={ref}>
        <button className="fs-btn" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-haspopup="menu" aria-expanded={menu} title="Forms and full screen options">
          ☰
        </button>
        {menu && (
          <div className="fs-menu" role="menu">
            {forms.length > 0 && <div className="fs-menu-head">Forms</div>}
            {forms.map((f) => (
              <button
                key={f.id}
                role="menuitem"
                className={f.id === p.activeFormId ? "on" : ""}
                onClick={() => {
                  setMenu(false);
                  p.onOpenForm(f.id);
                }}
              >
                {f.name}
              </button>
            ))}
            <div className="fs-menu-sep" />
            {p.link && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  navigator.clipboard?.writeText(p.link!).then(
                    () => p.onCopied(true),
                    () => p.onCopied(false),
                  ) ?? p.onCopied(false);
                }}
              >
                Copy a link to this form
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => {
                setMenu(false);
                p.onExit();
              }}
            >
              Exit full screen
            </button>
            {p.onCloseDatabase && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  p.onCloseDatabase!();
                }}
              >
                Close database
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
