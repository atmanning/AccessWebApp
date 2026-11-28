/**
 * One report control drawn on paper: in Report View with its value, and in Design View with its
 * source ("Name", "=Sum([Cost])"), as Access shows them.
 */
import type { CSSProperties } from "react";
import { fontStack, type ReportControl } from "../../../shared/model";

export interface ReportCellContent {
  text?: string;
  checked?: boolean;
  imageSrc?: string | null;
  error?: string;
}

/** The control's look: font, alignment, colors, border. Report controls have no border unless set. */
export function reportControlStyle(c: ReportControl, baseFont: number): CSSProperties {
  const s: CSSProperties = {
    fontSize: c.fontSize ?? baseFont,
    fontWeight: c.bold ? 700 : undefined,
    fontStyle: c.italic ? "italic" : undefined,
    textDecoration: c.underline ? "underline" : undefined,
    fontFamily: fontStack(c.font),
    textAlign: c.align,
    color: c.color,
    background: c.backColor,
    borderRadius: c.radius || undefined,
  };
  if (c.type === "rectangle") {
    s.border = `${c.borderWidth ?? 1}px solid ${c.borderColor ?? "#000000"}`;
  } else if (c.type !== "line" && (c.borderWidth ?? 0) > 0) {
    s.border = `${c.borderWidth}px solid ${c.borderColor ?? "#000000"}`;
  }
  return s;
}

export function ReportControlView({ c, baseFont, content, design }: { c: ReportControl; baseFont: number; content?: ReportCellContent; design?: boolean }) {
  const style = reportControlStyle(c, baseFont);
  switch (c.type) {
    case "line": {
      const t = Math.max(1, c.borderWidth ?? 1);
      const color = c.borderColor ?? c.color ?? "#000000";
      // Drawn along the longer side of its box.
      return c.w >= c.h ? (
        <div className="rc rc-line" style={{ borderTop: `${t}px solid ${color}`, height: 0, width: "100%" }} />
      ) : (
        <div className="rc rc-line" style={{ borderLeft: `${t}px solid ${color}`, width: 0, height: "100%" }} />
      );
    }
    case "rectangle":
      return <div className="rc rc-rect" style={style} />;
    case "checkbox": {
      const on = design ? false : !!content?.checked;
      return (
        <div className="rc rc-check" style={style}>
          <span className={`rc-box ${on ? "on" : ""}`} aria-label={on ? "Yes" : "No"}>
            {on ? "✓" : ""}
          </span>
          {c.caption ? <span className="rc-check-text">{c.caption}</span> : null}
        </div>
      );
    }
    case "image":
      if (design || !content?.imageSrc) return <div className={`rc rc-image ${design ? "design" : ""}`} style={style}>{design ? `🖼 ${c.field ?? "Picture"}` : null}</div>;
      return (
        <div className="rc rc-image" style={style}>
          <img src={content.imageSrc} alt="" />
        </div>
      );
    case "label":
      return (
        <div className="rc rc-text" style={style}>
          {c.caption}
        </div>
      );
    default: {
      // Text box: its value, or in Design View its Control Source.
      const text = design ? (c.field ?? "Unbound") : (content?.text ?? "");
      return (
        <div className={`rc rc-text rc-box-text ${design ? "design" : ""} ${content?.error ? "rc-error" : ""}`} style={style} title={content?.error}>
          {text}
        </div>
      );
    }
  }
}
