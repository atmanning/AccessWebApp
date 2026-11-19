/**
 * A form shown as a chart of its records (Access's PivotChart view): the records grouped by the
 * category field, each series a field's total per group. Columns, lines and areas share one value
 * scale; a series Access plotted on its own axis gets its own panel underneath instead of a
 * second scale. Hover (or tap) shows a group's values; "Show data" shows them as a table.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CellValue, ChartType, Field, FormChart } from "../../../shared/model";
import { formatValue } from "../engine/values";

/** The categorical colors, in fixed order (validated for color-vision deficiency and contrast). */
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const SURFACE = "#fcfcfb";

interface Group {
  key: string;
  label: string;
  sort: string | number;
  values: (number | null)[];
}

function aggregate(nums: number[], agg: FormChart["series"][number]["agg"], count: number): number | null {
  if (agg === "count") return count;
  if (!nums.length) return null;
  if (agg === "sum") return nums.reduce((a, b) => a + b, 0);
  if (agg === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (agg === "min") return Math.min(...nums);
  return Math.max(...nums);
}

/** The records, grouped and totalled. */
export function chartGroups(chart: FormChart, columns: string[], fields: (Field | undefined)[], rows: CellValue[][]): Group[] {
  const ci = chart.category ? columns.findIndex((c) => c.toLowerCase() === chart.category!.toLowerCase()) : -1;
  const si = chart.series.map((s) => columns.findIndex((c) => c.toLowerCase() === s.field.toLowerCase()));
  const groups = new Map<string, { label: string; sort: string | number; nums: number[][]; counts: number[] }>();
  for (const r of rows) {
    const raw = ci >= 0 ? r[ci] : null;
    const key = raw === null || raw === undefined ? "" : String(raw);
    let g = groups.get(key);
    if (!g) {
      const label = ci < 0 ? "All records" : key === "" ? "(blank)" : formatValue(fields[ci], raw as CellValue);
      const sort = typeof raw === "number" ? raw : key;
      groups.set(key, (g = { label, sort, nums: chart.series.map(() => []), counts: chart.series.map(() => 0) }));
    }
    si.forEach((i, k) => {
      const v = i >= 0 ? r[i] : null;
      if (v === null || v === undefined || v === "") return;
      g!.counts[k]++;
      const n = typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
      if (Number.isFinite(n)) g!.nums[k].push(n);
    });
  }
  const list = [...groups.entries()].map(([key, g]) => ({ key, label: g.label, sort: g.sort, values: chart.series.map((s, k) => aggregate(g.nums[k], s.agg, g.counts[k])) }));
  // Dates, numbers and text in order along the bottom; a pie keeps the records' order.
  if (chart.type !== "pie") list.sort((a, b) => (typeof a.sort === "number" && typeof b.sort === "number" ? a.sort - b.sort : String(a.sort).localeCompare(String(b.sort), undefined, { numeric: true })));
  return list;
}

const fmt = (n: number | null) => (n === null ? "–" : Math.abs(n) >= 1000 || Number.isInteger(n) ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

/** Round tick steps (1, 2, 5 × 10ⁿ) covering lo..hi. */
function ticks(lo: number, hi: number, count = 5) {
  if (lo === hi) [lo, hi] = lo === 0 ? [0, 1] : [Math.min(0, lo), Math.max(0, hi)];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

interface Panel {
  series: number[];
}

export function FormChartView(p: { chart: FormChart; columns: string[]; fields: (Field | undefined)[]; rows: CellValue[][]; title?: string; height?: number }) {
  const { chart } = p;
  const groups = useMemo(() => chartGroups(chart, p.columns, p.fields, p.rows), [chart, p.columns, p.fields, p.rows]);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [boxH, setBoxH] = useState(0);
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setWidth(Math.max(240, el.clientWidth));
      setBoxH(el.parentElement?.clientHeight ?? 0);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    measure();
    return () => ro.disconnect();
  }, []);

  const title = chart.title || p.title;
  const labelOf = (k: number) => chart.series[k].label || chart.series[k].field;
  const head = (
    <div className="fch-head">
      {title && <div className="fch-title">{title}</div>}
      <button type="button" className="fch-toggle" onClick={() => setTable((t) => !t)} aria-pressed={table}>
        {table ? "Show chart" : "Show data"}
      </button>
    </div>
  );

  if (!groups.length)
    return (
      <div className="fch" ref={ref}>
        {head}
        <div className="fch-empty muted">No records to chart.</div>
      </div>
    );

  if (table)
    return (
      <div className="fch" ref={ref}>
        {head}
        <div className="fch-table-wrap">
          <table className="fch-table">
            <thead>
              <tr>
                <th>{chart.category ?? ""}</th>
                {chart.series.map((s, k) => (
                  <th key={k}>{labelOf(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td>{g.label}</td>
                  {g.values.map((v, k) => (
                    <td key={k} className="num">
                      {fmt(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );

  if (chart.type === "pie") return <Pie {...{ chart, groups, width, head, labelOf }} innerRef={ref} />;

  // Panels: the series sharing a scale, then one per series that had its own axis in Access.
  const panels: Panel[] = [{ series: chart.series.map((s, k) => (s.ownScale ? -1 : k)).filter((k) => k >= 0) }];
  chart.series.forEach((s, k) => s.ownScale && panels.push({ series: [k] }));
  // As tall as the space it's given (a subform control), or a comfortable height on its own.
  const total = Math.max(160, (p.height ?? (boxH > 160 ? boxH - 8 : 360)) - 34);
  const panelH = Math.max(120, Math.floor(total / panels.length));

  return (
    <div className="fch" ref={ref} onMouseLeave={() => setHover(null)}>
      {head}
      {panels.map((panel, i) => (
        <PlotPanel
          key={i}
          chart={chart}
          groups={groups}
          series={panel.series}
          width={width}
          height={panelH}
          showX={i === panels.length - 1}
          hover={hover}
          onHover={setHover}
          labelOf={labelOf}
        />
      ))}
    </div>
  );
}

function PlotPanel(p: {
  chart: FormChart;
  groups: Group[];
  series: number[];
  width: number;
  height: number;
  showX: boolean;
  hover: number | null;
  onHover: (i: number | null) => void;
  labelOf: (k: number) => string;
}) {
  const { chart, groups, series } = p;
  const typeOf = (k: number): ChartType => (chart.series[k].type ?? chart.type) === "bar" ? "column" : (chart.series[k].type ?? chart.type);
  const vals = series.flatMap((k) => groups.map((g) => g.values[k]).filter((v): v is number => v !== null));
  const zeroBased = series.some((k) => typeOf(k) !== "line");
  let lo = Math.min(...vals, zeroBased ? 0 : Infinity);
  let hi = Math.max(...vals, zeroBased ? 0 : -Infinity);
  if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
  if (!zeroBased && lo !== hi) {
    const pad = (hi - lo) * 0.08;
    [lo, hi] = [lo - pad, hi + pad];
  }
  const yt = ticks(lo, hi);
  const [y0, y1] = [yt[0], yt[yt.length - 1]];
  const ml = 12 + Math.max(...yt.map((t) => fmt(t).length)) * 7;
  const mr = 12;
  const mt = series.length > 1 ? 30 : 10;
  const mb = p.showX ? 30 : 8;
  const W = p.width;
  const H = p.height;
  const pw = Math.max(40, W - ml - mr);
  const ph = Math.max(40, H - mt - mb);
  const n = groups.length;
  const band = pw / n;
  const x = (i: number) => ml + band * (i + 0.5);
  const y = (v: number) => mt + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  const columns = series.filter((k) => typeOf(k) === "column");
  const colW = Math.max(2, Math.min(36, (band * 0.72 - 2 * (columns.length - 1)) / Math.max(1, columns.length)));
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 74))));
  const markers = n <= 40;

  return (
    <div className="fch-panel" style={{ position: "relative" }}>
      <svg width={W} height={H} role="img" aria-label={series.map(p.labelOf).join(", ")}>
        {/* Grid and value axis: recessive. */}
        {yt.map((t) => (
          <g key={t}>
            <line x1={ml} x2={W - mr} y1={y(t)} y2={y(t)} stroke={t === 0 ? "#b9bcc2" : "#e6e8eb"} strokeWidth={1} />
            <text x={ml - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fch-tick">
              {fmt(t)}
            </text>
          </g>
        ))}
        {p.showX &&
          groups.map((g, i) =>
            i % every === 0 ? (
              <text key={g.key} x={x(i)} y={H - 10} textAnchor="middle" className="fch-tick">
                {g.label.length > 14 ? `${g.label.slice(0, 13)}…` : g.label}
              </text>
            ) : null,
          )}
        {/* Columns (rounded at the data end, 2px apart), then areas, then lines on top. */}
        {columns.map((k, ci) =>
          groups.map((g, i) => {
            const v = g.values[k];
            if (v === null) return null;
            const cx = x(i) - (columns.length * colW + 2 * (columns.length - 1)) / 2 + ci * (colW + 2);
            const top = y(Math.max(0, v));
            const h = Math.max(1, Math.abs(y(v) - y(0)));
            const r = Math.min(4, colW / 2, h);
            const up = v >= 0;
            const d = up
              ? `M${cx},${top + h}V${top + r}Q${cx},${top} ${cx + r},${top}H${cx + colW - r}Q${cx + colW},${top} ${cx + colW},${top + r}V${top + h}Z`
              : `M${cx},${y(0)}V${y(0) + h - r}Q${cx},${y(0) + h} ${cx + r},${y(0) + h}H${cx + colW - r}Q${cx + colW},${y(0) + h} ${cx + colW},${y(0) + h - r}V${y(0)}Z`;
            return <path key={`${k}-${g.key}`} d={d} fill={SERIES_COLORS[k]} opacity={p.hover === null || p.hover === i ? 1 : 0.55} />;
          }),
        )}
        {series
          .filter((k) => typeOf(k) === "area" || typeOf(k) === "line")
          .map((k) => {
            const pts = groups.map((g, i) => (g.values[k] === null ? null : ([x(i), y(g.values[k]!)] as const)));
            const segs: (readonly [number, number])[][] = [];
            let cur: (readonly [number, number])[] = [];
            for (const pt of pts) {
              if (pt) cur.push(pt);
              else if (cur.length) (segs.push(cur), (cur = []));
            }
            if (cur.length) segs.push(cur);
            const color = SERIES_COLORS[k];
            return (
              <g key={k}>
                {typeOf(k) === "area" &&
                  segs.map((s, i) => <path key={i} d={`M${s[0][0]},${y(Math.max(y0, 0))}${s.map(([a, b]) => `L${a},${b}`).join("")}L${s[s.length - 1][0]},${y(Math.max(y0, 0))}Z`} fill={color} opacity={0.18} />)}
                {segs.map((s, i) => (
                  <path key={i} d={s.map(([a, b], j) => `${j ? "L" : "M"}${a},${b}`).join("")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                ))}
                {(markers || p.hover !== null) &&
                  pts.map((pt, i) => (pt && (markers || p.hover === i) ? <circle key={i} cx={pt[0]} cy={pt[1]} r={p.hover === i ? 5 : 4} fill={color} stroke={SURFACE} strokeWidth={2} /> : null))}
              </g>
            );
          })}
        {p.hover !== null && <line x1={x(p.hover)} x2={x(p.hover)} y1={mt} y2={mt + ph} stroke="#8a8f98" strokeWidth={1} strokeDasharray="3 3" pointerEvents="none" />}
        {/* Hit areas: a whole band per group, bigger than the marks. */}
        {groups.map((g, i) => (
          <rect key={g.key} x={ml + band * i} y={mt} width={band} height={ph} fill="transparent" onMouseEnter={() => p.onHover(i)} onClick={() => p.onHover(i)} />
        ))}
      </svg>
      {series.length > 1 && (
        <div className="fch-legend" style={{ left: ml }}>
          {series.map((k) => (
            <span key={k}>
              <i className={typeOf(k) === "column" ? "sw" : "ln"} style={{ background: SERIES_COLORS[k] }} />
              {p.labelOf(k)}
            </span>
          ))}
        </div>
      )}
      {series.length === 1 && (
        <div className="fch-legend" style={{ left: ml }}>
          <span className="muted">{p.labelOf(series[0])}</span>
        </div>
      )}
      {p.hover !== null && groups[p.hover] && (
        <div className="fch-tip" style={{ left: Math.min(Math.max(8, x(p.hover) + 12), W - 180), top: mt + 4 }}>
          <strong>{groups[p.hover].label}</strong>
          {series.map((k) => (
            <div key={k}>
              <i style={{ background: SERIES_COLORS[k] }} />
              {p.labelOf(k)}: <b>{fmt(groups[p.hover!].values[k])}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Pie(p: { chart: FormChart; groups: Group[]; width: number; head: ReactNode; labelOf: (k: number) => string; innerRef: RefObject<HTMLDivElement | null> }) {
  const [hover, setHover] = useState<number | null>(null);
  // Up to 7 slices by size; the rest together as "Other" (colors never repeat).
  const items = p.groups.map((g) => ({ label: g.label, v: Math.max(0, g.values[0] ?? 0) })).filter((x) => x.v > 0);
  items.sort((a, b) => b.v - a.v);
  const slices = items.length > 8 ? [...items.slice(0, 7), { label: "Other", v: items.slice(7).reduce((a, b) => a + b.v, 0) }] : items;
  const total = slices.reduce((a, b) => a + b.v, 0);
  const size = Math.min(260, Math.max(140, p.width * 0.45));
  const r = size / 2 - 4;
  const c = size / 2;
  let a0 = -Math.PI / 2;
  return (
    <div className="fch" ref={p.innerRef}>
      {p.head}
      {!total ? (
        <div className="fch-empty muted">Nothing to chart (the totals are zero).</div>
      ) : (
        <div className="fch-pie">
          <svg width={size} height={size} role="img" aria-label={`${p.labelOf(0)} by ${p.chart.category ?? "group"}`}>
            {slices.map((s, i) => {
              const a1 = a0 + (s.v / total) * Math.PI * 2;
              const large = a1 - a0 > Math.PI ? 1 : 0;
              const d =
                slices.length === 1
                  ? `M${c},${c - r}A${r},${r} 0 1 1 ${c - 0.01},${c - r}Z`
                  : `M${c},${c}L${c + r * Math.cos(a0)},${c + r * Math.sin(a0)}A${r},${r} 0 ${large} 1 ${c + r * Math.cos(a1)},${c + r * Math.sin(a1)}Z`;
              a0 = a1;
              return <path key={s.label} d={d} fill={SERIES_COLORS[i]} stroke={SURFACE} strokeWidth={2} opacity={hover === null || hover === i ? 1 : 0.6} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => setHover(i)} />;
            })}
          </svg>
          {/* The legend carries every slice's value and share, so no slice relies on its color alone. */}
          <ul className="fch-pie-legend">
            {slices.map((s, i) => (
              <li key={s.label} className={hover === i ? "on" : ""} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <i style={{ background: SERIES_COLORS[i] }} />
                <span className="lbl">{s.label}</span>
                <b>{fmt(s.v)}</b>
                <span className="muted">{Math.round((s.v / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
