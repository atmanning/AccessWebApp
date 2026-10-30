import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AccessIcon, CloseIcon } from "./icons";

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button.primary, button");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title} ref={ref} style={{ width: props.width ?? 420 }}>
        <div className="modal-title">
          <span>{props.title}</span>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close">
            <CloseIcon size={12} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-footer">{props.footer}</div>}
      </div>
    </div>
  );
}

type DialogRequest =
  | { kind: "alert"; title: string; message: ReactNode; resolve: (v: void) => void }
  | { kind: "confirm"; title: string; message: ReactNode; okLabel: string; danger?: boolean; resolve: (v: boolean) => void }
  | {
      kind: "prompt";
      title: string;
      message: ReactNode;
      initial: string;
      validate?: (v: string) => string | null;
      resolve: (v: string | null) => void;
    };

export interface DialogApi {
  alert(title: string, message: ReactNode): Promise<void>;
  confirm(title: string, message: ReactNode, opts?: { okLabel?: string; danger?: boolean }): Promise<boolean>;
  prompt(title: string, message: ReactNode, initial?: string, validate?: (v: string) => string | null): Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);
export const useDialogs = () => useContext(DialogContext)!;

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const push = useCallback((r: DialogRequest) => setQueue((q) => [...q, r]), []);
  const api: DialogApi = {
    alert: (title, message) => new Promise((resolve) => push({ kind: "alert", title, message, resolve })),
    confirm: (title, message, opts) =>
      new Promise((resolve) => push({ kind: "confirm", title, message, okLabel: opts?.okLabel ?? "OK", danger: opts?.danger, resolve })),
    prompt: (title, message, initial = "", validate) =>
      new Promise((resolve) => push({ kind: "prompt", title, message, initial, validate, resolve })),
  };
  const current = queue[0];
  const done = () => setQueue((q) => q.slice(1));
  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && <DialogView key={queue.length} req={current} done={done} />}
    </DialogContext.Provider>
  );
}

function DialogView({ req, done }: { req: DialogRequest; done: () => void }) {
  const [value, setValue] = useState(req.kind === "prompt" ? req.initial : "");
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (req.kind === "confirm") req.resolve(false);
    else if (req.kind === "prompt") req.resolve(null);
    else req.resolve();
    done();
  };
  const ok = () => {
    if (req.kind === "prompt") {
      const err = req.validate?.(value) ?? null;
      if (err) {
        setError(err);
        return;
      }
      req.resolve(value.trim());
    } else if (req.kind === "confirm") req.resolve(true);
    else req.resolve();
    done();
  };
  return (
    <Modal
      title={req.title}
      onClose={cancel}
      footer={
        <>
          <button className={req.kind === "confirm" && req.danger ? "danger" : "primary"} onClick={ok}>
            {req.kind === "confirm" ? req.okLabel : "OK"}
          </button>
          {req.kind !== "alert" && <button onClick={cancel}>Cancel</button>}
        </>
      }
    >
      <div className="dialog-message">
        {req.kind !== "prompt" && <AccessIcon size={32} />}
        <div>
          <div>{req.message}</div>
          {req.kind === "prompt" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ok();
              }}
            >
              <input
                className="text-input wide"
                value={value}
                autoFocus
                onFocus={(e) => e.target.select()}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
              />
              {error && <div className="field-error">{error}</div>}
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Lists what an Access import couldn't bring across. */
export function showImportWarnings(dialogs: DialogApi, warnings: string[], heading = "The database was imported, with these notes:") {
  return dialogs.alert(
    "Import notes",
    <div className="import-notes">
      <p>{heading}</p>
      <ul>
        {warnings.slice(0, 50).map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      {warnings.length > 50 && <p className="muted">…and {warnings.length - 50} more.</p>}
    </div>,
  );
}
