/** A picture in an Image field, full size, with buttons to replace, remove or download it. */
import { useRef, useState } from "react";
import { Modal } from "../ui/dialogs";
import { pictureIn } from "../ui/images";

export function ImageDialog(props: {
  title: string;
  url: string | null;
  canEdit: boolean;
  onPick: (file: File) => Promise<void>;
  onRemove: () => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const pick = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await props.onPick(file);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      width={640}
      footer={
        <>
          {props.canEdit && (
            <button className="primary" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? "Adding…" : props.url ? "Replace picture…" : "Choose picture…"}
            </button>
          )}
          {props.canEdit && props.url && (
            <button disabled={busy} onClick={props.onRemove}>
              Remove
            </button>
          )}
          {props.url && (
            <a className="button-link" href={props.url} download>
              Download
            </a>
          )}
          <span className="spacer" />
          <button onClick={props.onClose}>Close</button>
        </>
      }
    >
      <div
        className={`image-view ${over ? "drop-over" : ""}`}
        onDragOver={(e) => {
          if (!props.canEdit) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (props.canEdit) void pick(pictureIn(e.dataTransfer.files));
        }}
      >
        {props.url ? <img src={props.url} alt={props.title} /> : <div className="muted">No picture{props.canEdit ? ". Choose one, or drop an image file here." : "."}</div>}
      </div>
      {error && <div className="field-error" role="alert">{error}</div>}
      {props.canEdit && <p className="small muted">PNG, JPEG, GIF or WebP. Big photos are made smaller (up to 2400 pixels across) before they're stored.</p>}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = "";
          void pick(f);
        }}
      />
    </Modal>
  );
}
