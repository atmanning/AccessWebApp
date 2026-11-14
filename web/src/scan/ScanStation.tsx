/**
 * Scan station: point a phone's camera at name tags (or type an ID, or use a barcode scanner that
 * types), and each scan does the chosen scan action: logs attendance, marks an achievement…
 * Big green or red feedback for each scan, a list of recent scans with Undo.
 */
import { useEffect, useRef, useState } from "react";
import type { ScanAction } from "../../../shared/model";
import { useWorkspace } from "../workspace/context";
import { newId } from "../workspace/docOps";
import { actionProblem, applyScan, keyFromScan, undoScan, type ScanResult } from "./scanActions";
import { ScanActionEditor } from "./ScanActionEditor";

type Entry = { id: string; at: string; result: ScanResult; action: string; undone?: boolean };

const PICK_KEY = "accessweb.scanAction";

export function ScanStation({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const actions = ws.doc.scanActions ?? [];
  const [actionId, setActionId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(`${PICK_KEY}:${ws.projectId}`);
      if (saved && actions.some((a) => a.id === saved)) return saved;
    } catch {
      /* private mode */
    }
    return actions[0]?.id ?? "";
  });
  const action = actions.find((a) => a.id === actionId);
  const [editing, setEditing] = useState<ScanAction | "new" | null>(actions.length ? null : "new");
  const [log, setLog] = useState<Entry[]>([]);
  const [camera, setCamera] = useState(false);
  const [typed, setTyped] = useState("");
  const last = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  useEffect(() => {
    try {
      if (actionId) localStorage.setItem(`${PICK_KEY}:${ws.projectId}`, actionId);
    } catch {
      /* private mode */
    }
  }, [actionId, ws.projectId]);

  const scan = (text: string, fromCamera = true) => {
    // The camera sees the same tag many times a second: count it once while it stays in view
    // (it counts again after being out of sight for 2 seconds).
    const now = Date.now();
    if (fromCamera) {
      if (text === last.current.text && now - last.current.at < 2000) {
        last.current.at = now;
        return;
      }
      last.current = { text, at: now };
    }
    if (!action) return;
    const key = keyFromScan(text);
    let result: ScanResult = { ok: false, message: "That code isn't a name tag from this database." };
    if (key !== null) {
      if (ws.readOnly) result = { ok: false, message: "You have view-only access, so scans can't be recorded." };
      else ws.update((d) => void (result = applyScan(d, action, key)));
    }
    feedback(result.ok ? "ok" : result.ok === false && "already" in result && result.already ? "same" : "bad");
    setLog((l) => [{ id: newId("s"), at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }), result, action: action.name }, ...l].slice(0, 50));
  };

  const undo = (e: Entry) => {
    if (!e.result.ok) return;
    const u = e.result.undo;
    ws.update((d) => undoScan(d, u));
    setLog((l) => l.map((x) => (x.id === e.id ? { ...x, undone: true } : x)));
  };

  const latest = log[0];
  const problem = action ? actionProblem(ws.doc, action) : null;

  return (
    <div className="scan-station" role="dialog" aria-label="Scan Tags">
      <div className="ss-bar">
        <strong className="ss-title">Scan Tags</strong>
        <select className="ss-pick" aria-label="What a scan does" value={actionId} onChange={(e) => (e.target.value === "__new" ? setEditing("new") : setActionId(e.target.value))}>
          {!actions.length && <option value="">(no scan actions yet)</option>}
          {actions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          <option value="__new">+ New scan action…</option>
        </select>
        {action && (
          <button onClick={() => setEditing(action)} disabled={ws.readOnly}>
            Edit
          </button>
        )}
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>

      {problem && <div className="ss-problem">{problem}</div>}

      <div className="ss-main">
        <div className="ss-camera">
          {camera && action && !problem ? (
            <Camera onCode={scan} onError={(m) => (setCamera(false), setLog((l) => [{ id: newId("s"), at: "", action: "", result: { ok: false, message: m } }, ...l]))} />
          ) : (
            <button className="ss-start primary" disabled={!action || !!problem} onClick={() => setCamera(true)}>
              📷 Start camera
            </button>
          )}
          <form
            className="ss-typed"
            onSubmit={(e) => {
              e.preventDefault();
              if (!typed.trim()) return;
              scan(typed, false);
              setTyped("");
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Or type an ID (a barcode scanner works too)"
              aria-label="Type an ID or scan with a barcode scanner"
              disabled={!action || !!problem}
              inputMode="text"
              autoComplete="off"
            />
            <button type="submit" disabled={!action || !!problem || !typed.trim()}>
              Record
            </button>
          </form>
        </div>

        <div className="ss-side">
          {latest ? (
            <div className={`ss-result ${latest.result.ok ? "ok" : "already" in latest.result && latest.result.already ? "same" : "bad"}`} role="status" aria-live="assertive">
              <div className="ss-mark" aria-hidden="true">{latest.result.ok ? "✓" : "already" in latest.result && latest.result.already ? "↺" : "✗"}</div>
              <div>
                <div className="ss-person">{latest.result.person ?? (latest.result.ok ? "" : "Not recorded")}</div>
                <div className="ss-msg">{latest.result.message}</div>
              </div>
            </div>
          ) : (
            <div className="ss-result idle">
              {action ? (
                <>
                  Ready: <strong>{action.name}</strong>. Start the camera and hold a name tag's QR code in front of it.
                </>
              ) : (
                "Create a scan action to say what each scan records."
              )}
            </div>
          )}
          <ul className="ss-log" aria-label="Recent scans">
            {log.slice(latest ? 1 : 0).length > 0 && <li className="ss-log-head">Earlier</li>}
            {log.slice(1).map((e) => (
              <li key={e.id} className={`${e.result.ok ? "ok" : "bad"} ${e.undone ? "undone" : ""}`}>
                <span className="ss-log-at">{e.at}</span>
                <span className="ss-log-who">{e.result.person ?? "—"}</span>
                <span className="ss-log-what">{e.undone ? "Undone" : e.result.message}</span>
                {e.result.ok && !e.undone && (
                  <button className="link-button" onClick={() => undo(e)}>
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
          {latest?.result.ok && !latest.undone && (
            <button className="ss-undo" onClick={() => undo(latest)}>
              Undo last scan
            </button>
          )}
        </div>
      </div>

      {editing && (
        <ScanActionEditor
          action={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setActionId(id);
            setEditing(null);
          }}
          onDeleted={() => {
            setActionId((ws.doc.scanActions ?? []).find((a) => a.id !== actionId)?.id ?? "");
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** A short beep and buzz: high for recorded, low for a problem. */
function feedback(kind: "ok" | "same" | "bad") {
  try {
    navigator.vibrate?.(kind === "ok" ? 60 : [60, 60, 60]);
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = kind === "ok" ? 880 : kind === "same" ? 520 : 220;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (kind === "ok" ? 0.12 : 0.3));
    o.onended = () => void ctx.close();
  } catch {
    /* no sound */
  }
}

/** The camera, reading QR codes: the browser's own reader when it has one, otherwise jsQR. */
function Camera({ onCode, onError }: { onCode: (text: string) => void; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const handler = useRef(onCode);
  handler.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const canvas = document.createElement("canvas");
    const ctx2d = canvas.getContext("2d", { willReadFrequently: true });

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        return onError("This browser can't use the camera here. The page must be opened over https (your Render address), not http.");
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (e) {
        const name = (e as Error).name;
        return onError(
          name === "NotAllowedError"
            ? "The camera is blocked. Allow camera access for this site in the browser's settings, then press Start camera again."
            : "No camera was found, or another app is using it.",
        );
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});

      type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
      const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      let detector: Detector | null = null;
      try {
        detector = BD ? new BD({ formats: ["qr_code"] }) : null;
      } catch {
        detector = null;
      }
      const jsQR = detector ? null : (await import("jsqr")).default;

      const tick = async () => {
        if (stopped) return;
        try {
          if (v.readyState >= 2 && v.videoWidth) {
            let text: string | null = null;
            if (detector) {
              const found = await detector.detect(v);
              text = found[0]?.rawValue ?? null;
            } else if (jsQR && ctx2d) {
              // A smaller copy is plenty for a QR code, and much faster on phones.
              const scale = Math.min(1, 640 / v.videoWidth);
              canvas.width = Math.round(v.videoWidth * scale);
              canvas.height = Math.round(v.videoHeight * scale);
              ctx2d.drawImage(v, 0, 0, canvas.width, canvas.height);
              const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
            }
            if (text) handler.current(text);
          }
        } catch {
          /* try the next frame */
        }
        timer = setTimeout(tick, 180);
      };
      void tick();
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ss-video-wrap">
      <video ref={video} className="ss-video" playsInline muted aria-label="Camera" />
      <div className="ss-frame" aria-hidden="true" />
    </div>
  );
}
