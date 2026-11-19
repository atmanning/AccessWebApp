import { describe, expect, it } from "vitest";
import type { FormControl } from "../../shared/model";
import { phoneRows } from "../src/forms/phoneLayout";

let n = 0;
const ctl = (type: FormControl["type"], x: number, y: number, w: number, h: number, extra: Partial<FormControl> = {}): FormControl =>
  ({ id: `c${++n}`, name: `c${n}`, type, section: "header", x, y, w, h, ...extra }) as FormControl;
const PIC = "img_" + "a".repeat(32);

describe("phone layout", () => {
  it("puts labels above their boxes, a check box's label beside it, and button pictures inside the buttons", () => {
    const title = ctl("label", 10, 5, 300, 40, { caption: "Asset List", fontSize: 40 });
    const lbl = ctl("label", 10, 60, 80, 20, { caption: "Item" });
    const box = ctl("textbox", 100, 60, 200, 22, { field: "Item" });
    const chk = ctl("checkbox", 10, 100, 16, 16, { field: "Retired" });
    const chkLbl = ctl("label", 30, 98, 120, 20, { caption: "Show Retired" });
    const icon = ctl("image", 412, 140, 20, 20, { picture: PIC });
    const btn = ctl("button", 410, 136, 120, 28, { caption: "New Asset" });
    const btn2 = ctl("button", 540, 136, 120, 28, { caption: "E-mail" });
    const rows = phoneRows([btn2, icon, btn, chkLbl, chk, box, lbl, title]);
    expect(rows.map((r) => r.kind)).toEqual(["block", "block", "block", "buttons"]);
    const [t, b, c, bs] = rows as [any, any, any, any];
    expect(t.item.c.caption).toBe("Asset List");
    expect(t.item.c.fontSize).toBe(26);
    expect(b.item.c).toMatchObject({ id: box.id, label: "Item", labelPos: "top" });
    expect(c.item.c).toMatchObject({ id: chk.id, caption: "Show Retired" });
    expect(bs.items.map((i: any) => i.c.id)).toEqual([btn.id, btn2.id]);
    expect(bs.items[0].c.picture).toBe(PIC);
  });

  it("keeps a search box and its picture-only buttons on one line; drops lines and empty invisible buttons", () => {
    const search = ctl("textbox", 400, 10, 150, 22);
    const goPic = ctl("image", 552, 10, 22, 22, { picture: PIC });
    const go = ctl("button", 552, 10, 22, 22, { transparent: true, caption: "Go" });
    const lonely = ctl("button", 600, 10, 22, 22, { transparent: true });
    const line = ctl("line", 0, 40, 700, 1);
    const rows = phoneRows([search, goPic, go, lonely, line]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("inline");
    const items = (rows[0] as { items: { c: FormControl }[] }).items.map((i) => i.c);
    expect(items.map((c) => c.id)).toEqual([search.id, go.id]);
    expect(items[1]).toMatchObject({ transparent: false, caption: "", picture: PIC });
  });

  it("leaves out controls marked not for phones", () => {
    expect(phoneRows([ctl("textbox", 0, 0, 100, 20, { phoneHidden: true })])).toEqual([]);
  });
});
