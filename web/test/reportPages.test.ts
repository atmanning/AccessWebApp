import { describe, expect, it } from "vitest";
import type { ReportLayout } from "../../shared/model";
import { reportLayoutSchema } from "../../shared/model";
import { reportFieldsUsed, reportSections, wizardLayout } from "../src/reports/reportLayout";
import { buildBands, paginate, sortRows } from "../src/reports/reportPages";

const columns = ["Dept", "Name", "Salary"];
const rows = [
  ["Sales", "Cy", 300],
  ["IT", "Ann", 100],
  ["Sales", "Bea", 200],
  ["IT", "Dee", 400],
  ["HR", "Eve", 50],
];

const layout = (over: Partial<ReportLayout> = {}): ReportLayout => ({
  page: { size: "letter", margins: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } },
  width: 720,
  sections: { reportHeader: 50, pageHeader: 30, detail: 20, pageFooter: 30, reportFooter: 40 },
  groups: [{ id: "g1", field: "Dept", header: 30, footer: 25 }],
  sorts: [{ field: "Name" }],
  controls: [],
  ...over,
});

describe("designed reports: sections and pages", () => {
  it("sorts by the groups, then the sorts (descending too)", () => {
    expect(sortRows(layout(), columns, rows).map((r) => r[1])).toEqual(["Eve", "Ann", "Dee", "Bea", "Cy"]);
    const desc = layout({ groups: [{ id: "g1", field: "Dept", header: 30, footer: 25, descending: true }], sorts: [{ field: "Salary", descending: true }] });
    expect(sortRows(desc, columns, rows).map((r) => r[1])).toEqual(["Cy", "Bea", "Dee", "Ann", "Eve"]);
  });

  it("prints a header before and a footer after each group, with that group's records for totals", () => {
    const l = layout();
    const bands = buildBands(l, columns, sortRows(l, columns, rows));
    expect(bands.map((b) => b.key)).toEqual([
      "reportHeader",
      "gh:g1", "detail", "gf:g1",
      "gh:g1", "detail", "detail", "gf:g1",
      "gh:g1", "detail", "detail", "gf:g1",
      "reportFooter",
    ]);
    const itFooter = bands[7];
    expect(itFooter.records.map((r) => r[1])).toEqual(["Ann", "Dee"]);
    expect(bands[0].records).toHaveLength(5);
    expect(bands[12].records).toHaveLength(5);
    // Sections without height or hidden aren't printed.
    const noHeader = layout({ groups: [{ id: "g1", field: "Dept", header: 0, footer: 25 }], sectionProps: { reportFooter: { hidden: true } } });
    expect(buildBands(noHeader, columns, sortRows(noHeader, columns, rows)).map((b) => b.key)).not.toContain("gh:g1");
    expect(buildBands(noHeader, columns, rows).map((b) => b.key)).not.toContain("reportFooter");
  });

  it("nests group levels", () => {
    const l = layout({
      groups: [
        { id: "a", field: "Dept", header: 10, footer: 10 },
        { id: "b", field: "Name", header: 10, footer: 0 },
      ],
      sorts: [],
    });
    const keys = buildBands(l, columns, sortRows(l, columns, rows)).map((b) => b.key);
    expect(keys.slice(0, 6)).toEqual(["reportHeader", "gh:a", "gh:b", "detail", "gf:a", "gh:a"]);
  });

  it("splits onto pages: report header first, page header on each page, page footer at the bottom", () => {
    const many = Array.from({ length: 200 }, (_, i) => ["IT", `P${String(i).padStart(3, "0")}`, i]);
    const l = layout();
    const { pages, page } = paginate(l, columns, many);
    expect(page.contentH).toBe(960); // 11in − 1in of margins, at 96 per inch
    expect(pages.length).toBeGreaterThan(3);
    expect(pages[0].bands.slice(0, 2).map((b) => b.key)).toEqual(["reportHeader", "pageHeader"]);
    for (const pg of pages.slice(1)) expect(pg.bands[0]).toMatchObject({ key: "pageHeader", top: 0 });
    for (const pg of pages) {
      const footer = pg.bands[pg.bands.length - 1];
      expect(footer).toMatchObject({ key: "pageFooter", top: 960 - 30 });
      // Nothing runs into the page footer.
      for (const b of pg.bands.slice(0, -1)) expect(b.top + b.h).toBeLessThanOrEqual(930);
    }
    expect(pages.flatMap((p) => p.bands).filter((b) => b.key === "detail")).toHaveLength(200);
    expect(pages[pages.length - 1].bands.some((b) => b.key === "reportFooter")).toBe(true);
  });

  it("never leaves a group header alone at the bottom of a page, and honours Force New Page", () => {
    const many = Array.from({ length: 120 }, (_, i) => [`D${Math.floor(i / 7)}`, `P${i}`, i]);
    const l = layout({ sections: { reportHeader: 0, pageHeader: 0, detail: 40, pageFooter: 0, reportFooter: 0 }, groups: [{ id: "g1", field: "Dept", header: 40, footer: 0 }] });
    for (const pg of paginate(l, columns, many).pages) expect(pg.bands[pg.bands.length - 1].key).not.toBe("gh:g1");
    const each = layout({ sectionProps: { "gh:g1": { forceNewPage: "before" } } });
    const pages = paginate(each, columns, rows).pages;
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.bands.filter((b) => b.key === "gh:g1").length)).toEqual([1, 1, 1]);
  });

  it("builds a Report Wizard layout from a simple report, valid for the schema", () => {
    const fields = [
      { name: "Dept", field: { id: "f1", name: "Dept", type: "ShortText" as const } },
      { name: "Name", field: { id: "f2", name: "Name", type: "ShortText" as const } },
      { name: "Salary", field: { id: "f3", name: "Salary", type: "Currency" as const } },
    ];
    const l = wizardLayout({ id: "r1", name: "Staff", title: "Staff by Department", source: { kind: "table", id: "t1" }, columns: ["Name", "Salary"], groupBy: "Dept" }, fields as never);
    expect(reportLayoutSchema.safeParse(l).success).toBe(true);
    expect(reportSections(l).map((s) => s.label)).toEqual(["Report Header", "Page Header", "Dept Header", "Detail", "Dept Footer", "Page Footer", "Report Footer"]);
    expect(l.controls.find((c) => c.name === "Title")?.caption).toBe("Staff by Department");
    expect(l.controls.some((c) => c.field === "=Sum([Salary])" && c.section === "reportFooter")).toBe(true);
    expect(l.controls.some((c) => c.field?.includes("[Page]") && c.section === "pageFooter")).toBe(true);
    expect(reportFieldsUsed(l).sort()).toEqual(["Dept", "Name", "Page", "Pages", "Salary"]);
  });
});

describe("designed reports and renaming a field", () => {
  it("renames the field in the report's controls, grouping and sorting", async () => {
    const { renameField } = await import("../src/workspace/docOps");
    const table = { id: "t1", name: "Staff", fields: [{ id: "f1", name: "Dept", type: "ShortText" }, { id: "f2", name: "Name", type: "ShortText" }], rows: [] };
    const l = layout({ controls: [{ id: "c1", type: "textbox", name: "Dept", section: "gh:g1", x: 0, y: 0, w: 100, h: 20, field: "Dept" }] });
    const doc = { tables: [table], queries: [], forms: [], relationships: [], reports: [{ id: "r1", name: "R", title: "R", source: { kind: "table", id: "t1" }, columns: ["Name"], layout: { ...l, sorts: [{ field: "Dept" }] } }] };
    renameField(doc as never, table as never, "f1", "Department");
    const r = doc.reports[0].layout;
    expect(r.groups[0].field).toBe("Department");
    expect(r.sorts[0].field).toBe("Department");
    expect(r.controls[0].field).toBe("Department");
  });
});
