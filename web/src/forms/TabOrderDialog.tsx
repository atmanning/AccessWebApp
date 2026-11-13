/**
 * Tab Order, like Access's: pick a section, then drag the controls (or use the arrows) into the
 * order Tab and Enter move through them. Auto Order puts them top to bottom, left to right. Each
 * control can also be taken out of the order (Tab Stop), and the form shows the numbers meanwhile.
 */
import { useEffect, useState, type DragEvent } from "react";
import { FORM_SECTIONS, type FormControl, type FormLayout, type FormSection } from "../../../shared/model";
import { Modal } from "../ui/dialogs";
import { CONTROL_LABELS, readingOrder, SECTION_LABELS, sectionTabOrder, takesFocus } from "./formLayout";

export interface TabOrderResult {
  order: Record<FormSection, string[]>;
  /** Controls taken out of the tab order. */
  skip: Set<string>;
}

export function TabOrderDialog(props: {
  layout: FormLayout;
  initialSection: FormSection;
  /** The numbers to show on the form while the dialog is open (control id → position). */
  onDraft: (numbers: Map<string, number> | null) => void;
  onOk: (r: TabOrderResult) => void;
  onClose: () => void;
}) {
  const { layout } = props;
  const [order, setOrder] = useState<Record<FormSection, string[]>>(() => {
    const o = {} as Record<FormSection, string[]>;
    for (const s of FORM_SECTIONS) o[s] = sectionTabOrder(layout, s).map((c) => c.id);
    return o;
  });
  const [skip, setSkip] = useState(() => new Set(layout.controls.filter((c) => c.tabStop === false).map((c) => c.id)));
  const [section, setSection] = useState<FormSection>(props.initialSection);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const byId = new Map(layout.controls.map((c) => [c.id, c]));
  const list = order[section];

  // Numbers on the form: position among the controls Tab stops at, section by section.
  useEffect(() => {
    const numbers = new Map<string, number>();
    for (const s of FORM_SECTIONS) {
      let n = 0;
      for (const id of order[s]) numbers.set(id, skip.has(id) ? 0 : ++n);
    }
    props.onDraft(numbers);
  }, [order, skip]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => props.onDraft(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const setList = (ids: string[]) => setOrder((o) => ({ ...o, [section]: ids }));
  const move = (id: string, to: number) => {
    const from = list.indexOf(id);
    if (from < 0) return;
    const next = list.filter((x) => x !== id);
    next.splice(Math.max(0, Math.min(next.length, to > from ? to - 1 : to)), 0, id);
    setList(next);
  };
  const autoOrder = () => setList(readingOrder(layout.controls.filter((c) => c.section === section && takesFocus(c.type))).map((c) => c.id));

  const describe = (c: FormControl) => {
    const what = CONTROL_LABELS[c.type];
    const src = c.type === "button" ? c.caption : c.field;
    return src && src !== c.name ? `${what} · ${src}` : what;
  };

  const counts = Object.fromEntries(FORM_SECTIONS.map((s) => [s, order[s].length])) as Record<FormSection, number>;

  return (
    <Modal
      title="Tab Order"
      onClose={props.onClose}
      width={560}
      footer={
        <>
          <button onClick={autoOrder} title="Top to bottom, then left to right">
            Auto Order
          </button>
          <span className="spacer" />
          <button className="primary" onClick={() => props.onOk({ order, skip })}>
            OK
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </>
      }
    >
      <div className="to">
        <div className="to-sections" role="radiogroup" aria-label="Section">
          <div className="to-head">Section</div>
          {FORM_SECTIONS.map((s) => (
            <label key={s} className={`to-section ${section === s ? "sel" : ""} ${counts[s] ? "" : "empty"}`}>
              <input
                type="radio"
                name="to-section"
                checked={section === s}
                onChange={() => {
                  setSection(s);
                  setSelected(null);
                }}
              />
              {SECTION_LABELS[s]}
              <span className="to-count">{counts[s]}</span>
            </label>
          ))}
          <p className="small muted to-tip">
            Drag a control up or down, or select it and use the arrows. Numbers show on the form behind this box. Untick <strong>Tab stop</strong> for
            controls Tab should skip.
          </p>
        </div>
        <div className="to-order">
          <div className="to-head">Custom Order</div>
          <div className="to-list" role="listbox" aria-label="Custom Order" onDragOver={(e) => e.preventDefault()}>
            {list.map((id, i) => {
              const c = byId.get(id)!;
              const off = skip.has(id);
              return (
                <div
                  key={id}
                  role="option"
                  aria-selected={selected === id}
                  tabIndex={0}
                  draggable
                  className={`to-row ${selected === id ? "sel" : ""} ${drag?.over === i && drag.id !== id ? "drop-before" : ""} ${off ? "off" : ""}`}
                  onClick={() => setSelected(id)}
                  onDragStart={(e: DragEvent) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", id);
                    setSelected(id);
                    setDrag({ id, over: i });
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    const over = e.clientY > r.top + r.height / 2 ? i + 1 : i;
                    if (drag && drag.over !== over) setDrag({ ...drag, over });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (drag) move(drag.id, drag.over);
                    setDrag(null);
                  }}
                  onDragEnd={() => setDrag(null)}
                  onKeyDown={(e) => {
                    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                      e.preventDefault();
                      move(id, e.key === "ArrowUp" ? i - 1 : i + 2);
                    }
                  }}
                >
                  <span className="to-grip" aria-hidden="true">⋮⋮</span>
                  <span className="to-num">{off ? "–" : list.slice(0, i + 1).filter((x) => !skip.has(x)).length}</span>
                  <span className="to-name">
                    {c.name}
                    <span className="to-what">{describe(c)}</span>
                  </span>
                  <label className="to-stop" title="Tab and Enter stop here" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={!off}
                      aria-label={`${c.name} is a tab stop`}
                      onChange={(e) =>
                        setSkip((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.delete(id);
                          else n.add(id);
                          return n;
                        })
                      }
                    />
                    Tab stop
                  </label>
                </div>
              );
            })}
            {drag && <div className={`to-end ${drag.over === list.length ? "drop-before" : ""}`} onDragOver={(e) => { e.preventDefault(); setDrag({ ...drag, over: list.length }); }} onDrop={(e) => { e.preventDefault(); move(drag.id, list.length); setDrag(null); }} />}
            {!list.length && <div className="to-empty muted">No controls in this section take the focus.</div>}
          </div>
          <div className="to-moves">
            <button disabled={!selected || list.indexOf(selected) <= 0} onClick={() => selected && move(selected, list.indexOf(selected) - 1)} aria-label="Move up" title="Move up (Alt+↑)">
              ▲ Up
            </button>
            <button disabled={!selected || list.indexOf(selected) < 0 || list.indexOf(selected) >= list.length - 1} onClick={() => selected && move(selected, list.indexOf(selected) + 2)} aria-label="Move down" title="Move down (Alt+↓)">
              ▼ Down
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
