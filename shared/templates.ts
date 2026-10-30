import { emptyProject, type ProjectDoc } from "./model.js";

export const TEMPLATES = {
  blank: { label: "Blank database", description: "Start from scratch with an empty Table1." },
  contacts: { label: "Contacts & Orders", description: "Sample customers and orders with a query, form and report." },
} as const;
export type TemplateId = keyof typeof TEMPLATES;

export function buildTemplate(id: TemplateId): ProjectDoc {
  return id === "contacts" ? contactsTemplate() : blankTemplate();
}

function blankTemplate(): ProjectDoc {
  const doc = emptyProject();
  doc.tables.push({
    id: "t_table1",
    name: "Table1",
    fields: [{ id: "f_id", name: "ID", type: "AutoNumber", primaryKey: true }],
    rows: [],
    nextAutoNumber: 1,
  });
  return doc;
}

function contactsTemplate(): ProjectDoc {
  const customers = [
    ["Ada", "Lovelace", "ada@example.com", "London", "2026-01-12", true],
    ["Grace", "Hopper", "grace@example.com", "Arlington", "2026-02-03", true],
    ["Alan", "Turing", "alan@example.com", "Manchester", "2026-03-21", false],
    ["Katherine", "Johnson", "katherine@example.com", "Hampton", "2026-04-08", true],
    ["Edsger", "Dijkstra", "edsger@example.com", "Austin", "2026-05-17", true],
  ] as const;
  const orders = [
    [1, "2026-06-01", "Analytical engine parts", 1250.0],
    [1, "2026-07-14", "Punch cards (box)", 45.5],
    [2, "2026-06-20", "COBOL manual", 89.99],
    [3, "2026-08-02", "Enigma rotor set", 640.0],
    [4, "2026-08-30", "Slide rule", 32.0],
    [5, "2026-09-11", "Graph paper", 12.75],
    [2, "2026-10-05", "Nanosecond wire", 3.5],
  ] as const;

  return {
    version: 1,
    tables: [
      {
        id: "t_customers",
        name: "Customers",
        description: "People who buy from us",
        fields: [
          { id: "c_id", name: "CustomerID", type: "AutoNumber", primaryKey: true },
          { id: "c_first", name: "FirstName", type: "ShortText", size: 50, required: true },
          { id: "c_last", name: "LastName", type: "ShortText", size: 50, required: true },
          { id: "c_email", name: "Email", type: "ShortText", size: 120, indexed: "YesNoDup" },
          { id: "c_city", name: "City", type: "ShortText", size: 60 },
          { id: "c_since", name: "CustomerSince", type: "DateTime" },
          { id: "c_active", name: "Active", type: "YesNo", defaultValue: "Yes" },
        ],
        rows: customers.map((c, i) => ({
          _id: `r_c${i + 1}`,
          c_id: i + 1,
          c_first: c[0],
          c_last: c[1],
          c_email: c[2],
          c_city: c[3],
          c_since: c[4],
          c_active: c[5],
        })),
        nextAutoNumber: customers.length + 1,
      },
      {
        id: "t_orders",
        name: "Orders",
        fields: [
          { id: "o_id", name: "OrderID", type: "AutoNumber", primaryKey: true },
          { id: "o_cust", name: "CustomerID", type: "Number", numberSize: "Long", required: true, indexed: "YesDup" },
          { id: "o_date", name: "OrderDate", type: "DateTime" },
          { id: "o_item", name: "Item", type: "ShortText", size: 100 },
          { id: "o_amount", name: "Amount", type: "Currency" },
        ],
        rows: orders.map((o, i) => ({
          _id: `r_o${i + 1}`,
          o_id: i + 1,
          o_cust: o[0],
          o_date: o[1],
          o_item: o[2],
          o_amount: o[3],
        })),
        nextAutoNumber: orders.length + 1,
      },
    ],
    relationships: [
      { id: "rel_1", fromTable: "t_customers", fromField: "c_id", toTable: "t_orders", toField: "o_cust", enforce: true },
    ],
    queries: [
      {
        id: "q_active",
        name: "Active Customers",
        mode: "design",
        sql: "SELECT [Customers].[FirstName], [Customers].[LastName], [Customers].[City]\nFROM [Customers]\nWHERE [Customers].[Active] = True\nORDER BY [Customers].[LastName] ASC;",
        design: {
          tables: ["Customers"],
          columns: [
            { table: "Customers", field: "FirstName", show: true, sort: "", criteria: "" },
            { table: "Customers", field: "LastName", show: true, sort: "ASC", criteria: "" },
            { table: "Customers", field: "City", show: true, sort: "", criteria: "" },
            { table: "Customers", field: "Active", show: false, sort: "", criteria: "Yes" },
          ],
        },
      },
      {
        id: "q_totals",
        name: "Sales by Customer",
        mode: "sql",
        sql: "SELECT c.[FirstName] & \" \" & c.[LastName] AS Customer,\n       COUNT(o.[OrderID]) AS Orders,\n       SUM(o.[Amount]) AS Total\nFROM [Customers] AS c\nINNER JOIN [Orders] AS o ON o.[CustomerID] = c.[CustomerID]\nGROUP BY c.[CustomerID], c.[FirstName], c.[LastName]\nORDER BY Total DESC;",
      },
      {
        id: "q_orders_report",
        name: "Order Details",
        mode: "sql",
        sql: "SELECT c.[City], c.[FirstName] & \" \" & c.[LastName] AS Customer,\n       o.[OrderDate], o.[Item], o.[Amount]\nFROM [Customers] AS c\nINNER JOIN [Orders] AS o ON o.[CustomerID] = c.[CustomerID]\nWHERE o.[OrderDate] >= #2026-01-01#;",
      },
    ],
    forms: [
      {
        id: "fm_customers",
        name: "Customer Entry",
        title: "Customers",
        source: { kind: "table", id: "t_customers" },
        columns: ["CustomerID", "FirstName", "LastName", "Email", "City", "CustomerSince", "Active"],
      },
    ],
    reports: [
      {
        id: "rp_orders",
        name: "Orders by City",
        title: "Orders by City",
        source: { kind: "query", id: "q_orders_report" },
        columns: ["City", "Customer", "OrderDate", "Item", "Amount"],
        groupBy: "City",
        sortBy: "OrderDate",
      },
    ],
  } satisfies ProjectDoc as ProjectDoc;
}
