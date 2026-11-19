/**
 * Access's PivotChart view (Access 2010 and earlier; later versions dropped it): the form keeps
 * two XML documents from Office Web Components, the pivot (which field runs along the bottom,
 * which fields are totalled) and the chart space (the kind of chart, its title). Together they
 * become this app's form chart.
 */
import type { ChartType, FormChart } from "../../shared/model.js";
import { parseXml, type XmlNode } from "./accessMacros.js";

const kids = (n: XmlNode | undefined, tag: string) => (n?.children ?? []).filter((c) => c.tag === tag || c.tag === `x:${tag}`);
const kid = (n: XmlNode | undefined, tag: string) => kids(n, tag)[0];
const text = (n: XmlNode | undefined, tag: string) => kid(n, tag)?.text.trim();
function find(n: XmlNode | undefined, tag: string): XmlNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (c.tag === tag || c.tag === `x:${tag}`) return c;
    const f = find(c, tag);
    if (f) return f;
  }
  return undefined;
}

const OWC_TYPES: Record<string, ChartType> = {
  column: "column",
  columnstacked: "column",
  bar: "bar",
  line: "line",
  linemarkers: "line",
  smoothline: "line",
  scatter: "line",
  area: "area",
  pie: "pie",
  doughnut: "pie",
};

function aggOf(name: string, operator?: string): FormChart["series"][number]["agg"] {
  const s = `${operator ?? ""} ${name}`.toLowerCase();
  return /\bcount\b/.test(s) ? "count" : /\bav(era)?g(e)?\b/.test(s) ? "avg" : /\bmin\b/.test(s) ? "min" : /\bmax\b/.test(s) ? "max" : "sum";
}

/** The chart, from the pivot XML (property 0x0196) and the chart space XML (0x0197); null if they don't say enough. */
export function pivotChart(pivotXml: string | undefined, chartXml: string | undefined, columns: string[]): FormChart | null {
  const pivot = pivotXml ? find(parseXml(pivotXml) ?? undefined, "PivotTable") : undefined;
  const space = chartXml ? find(parseXml(chartXml) ?? undefined, "ChartSpace") : undefined;
  if (!pivot) return null;
  const has = (f: string) => columns.some((c) => c.toLowerCase() === f.toLowerCase());
  const fields = kids(pivot, "PivotField");
  const category = fields.find((f) => text(f, "Orientation") === "Row" && has(text(f, "Name") ?? ""));
  // Totals: the data fields (Sum of Weight → Weight), in their order.
  const operators = new Map(kids(pivot, "PLTotal").map((t) => [text(t, "Name") ?? "", text(t, "Operator")]));
  let data = fields
    .filter((f) => text(f, "Orientation") === "Data" && has(text(f, "ParentField") ?? ""))
    .map((f) => ({ name: text(f, "Name") ?? "", pl: text(f, "PLName") ?? "", field: text(f, "ParentField")!, pos: Number(text(f, "Position") ?? 0) }))
    .sort((a, b) => a.pos - b.pos);
  // The chart may plot only some of them (<Value><Data>Total2</Data>).
  const only = text(kid(space, "Value"), "Data");
  if (only && data.some((d) => d.pl === only)) data = data.filter((d) => d.pl === only);
  if (!data.length) return null;

  const graphs = space ? kids(find(space, "PlotArea"), "Graph") : [];
  const typeOf = (g?: XmlNode): ChartType => OWC_TYPES[(text(g, "Type") ?? "").toLowerCase()] ?? "column";
  // Each graph's value scale: a series on a different one had its own axis in Access.
  const scaleOf = (g?: XmlNode) => kids(g, "Dimension").find((d) => text(d, "Index") === "Value") && text(kids(g, "Dimension").find((d) => text(d, "Index") === "Value"), "ScaleID");
  const firstScale = scaleOf(graphs[0]);
  const type = typeOf(graphs[0]);

  // The chart's own title (not an axis's).
  let title: string | undefined;
  for (const t of space ? kids(space, "Title").concat(kids(find(space, "Chart"), "Title")) : []) {
    const cap = text(kid(t, "Caption"), "Data");
    if (cap) {
      title = cap.replace(/^"|"$/g, "");
      break;
    }
  }

  return {
    type,
    ...(category ? { category: text(category, "Name")! } : {}),
    series: data.slice(0, 8).map((d, i) => {
      const g = graphs[i];
      const own = i > 0 && !!g && !!firstScale && scaleOf(g) !== firstScale;
      return {
        field: d.field,
        agg: aggOf(d.name, operators.get(d.pl)),
        ...(g && i > 0 && typeOf(g) !== type ? { type: typeOf(g) } : {}),
        ...(own ? { ownScale: true } : {}),
        label: labelOf(d.field),
      };
    }),
    ...(title ? { title: title.slice(0, 400) } : {}),
  };
}

/** A readable name for a query's column: SumOfTotalCalories → Total Calories. */
export function labelOf(field: string) {
  const bare = field.replace(/^(SumOf|CountOf|AvgOf|MinOf|MaxOf|FirstOf|LastOf)(?=[A-Z])/, "");
  return bare.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim() || field;
}
