# Access Web

A browser-based look-alike of Microsoft Access. People register, build databases (tables, queries,
forms, reports, relationships), and everything saves to their account. Any database can be
downloaded as a real Microsoft Access **.accdb** file.

![Ribbon, navigation pane, datasheet and status bar modelled on Access](docs/screenshot-datasheet.png)

## What's in it

| Access feature | Here |
| --- | --- |
| Backstage / start screen | Templates (Blank, Contacts & Orders), recent databases, rename, delete |
| Ribbon | File, Home, Create, External Data, Database Tools, plus contextual *Table Design* / *Query Design* tabs |
| Navigation Pane | All Access Objects grouped by type, search, double-click to open, right-click Open / Design View / Rename / Delete, F11 to collapse |
| Tables — Datasheet View | Inline editing, keyboard navigation (arrows, Tab, Enter, F2, Esc), new-record row with `*`, record navigator, search filter, sort, column resize, multi-row delete |
| Tables — Design View | Field Name / Data Type / Description grid, Field Properties pane (Field Size, Default Value, Required, Indexed), Primary Key, Insert/Delete Rows, safe type conversion |
| Data types | AutoNumber, Short Text, Long Text, Number (Byte/Integer/Long/Single/Double), Currency, Date/Time, Yes/No |
| Validation | Types, field sizes, primary keys, *No Duplicates* indexes, required-field reminders, referential integrity |
| Queries | Design grid (Show Table, Field/Table/Sort/Show/Criteria, automatic joins from relationships), SQL View, Datasheet results, queries can use other queries |
| Forms | Single-record form with record navigator; edits write back to the table |
| Reports | Grouped, sorted print layout with group and grand totals; Print |
| Relationships | Draggable table boxes, drag a field onto another to relate, Enforce Referential Integrity, 1–∞ lines |
| External Data | Import CSV/text into a new table (type detection), export a table/query to CSV, **export the database to .accdb** |
| Undo / Redo | Ctrl+Z / Ctrl+Y across all edits; Ctrl+S saves (it also autosaves) |

Queries accept Access SQL: `[Bracketed names]`, `"text"`, `#12/31/2026#` dates, `&` concatenation,
`Like "A*"` wildcards, `Yes`/`No`, and functions such as `IIf`, `Nz`, `Left`, `Right`, `Mid`, `Len`,
`UCase`, `LCase`, `Year`, `Month`, `Day`, `Now`, `Date`, `CStr`, `CInt`, `CDbl`, `Val`.

## Why this stack

The brief was "the most supportable code base", so every choice is a mainstream default with a
large hiring pool and long-term support:

- **TypeScript everywhere** for the app — **React 19 + Vite** in the browser, **Node.js 22 LTS + Express 5** on the
  server — so one team in one language owns the UI, the API and the shared data model (`shared/model.ts`, validated
  with **Zod** on both sides).
- **SQLite** (via `better-sqlite3`) stores users, sessions and projects. One file, zero administration, easy backups.
  `server/src/db.ts` is the only place that touches it, so moving to PostgreSQL later is a contained change.
- **SQLite compiled to WebAssembly** (`sql.js`) runs each user's queries **in their browser**. Untrusted SQL never
  executes on the server.
- **Jackcess (Java)** writes the `.accdb` file. It is the only mature, open-source library that can *create* Access
  databases; nothing comparable exists for Node, Python or .NET on Linux. It is isolated in a ~250-line command-line
  program (`exporter/`) that the server runs per export — no Java framework, no shared state.

## Running it

### Docker (recommended)

```bash
docker compose up --build
# open http://localhost:3000
```

Data lives in the `access-web-data` volume (`/data/access-web.db`). Back it up by copying that file
(SQLite's `.backup` command is safest while running).

### Render.com

The repository includes a Render Blueprint (`render.yaml`). In Render: **New → Blueprint**, connect this GitHub
repository, and click **Apply**. Render builds the Dockerfile, attaches a 1 GB persistent disk at `/data` for the
SQLite database, serves the site over HTTPS, and redeploys on every push to the default branch.

A persistent disk needs a paid instance; on the free instance type the database would be erased on each deploy.
The disk also limits the service to one instance and means each deploy has a few seconds of downtime.

### Local development

Requires Node.js 22+, Java 21+ and Maven 3.9+.

```bash
npm install
npm run build:exporter     # builds exporter/target/access-exporter.jar
npm run dev                # API on :3001, web app with hot reload on http://localhost:5173
```

Production build without Docker:

```bash
npm run build && npm run build:exporter
NODE_ENV=production SECURE_COOKIES=false PORT=3000 npm start
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` (`3000` in Docker) | HTTP port |
| `DATA_DIR` | `./data` | Where `access-web.db` is stored |
| `SECURE_COOKIES` | `true` when `NODE_ENV=production` | Mark the session cookie Secure and add `upgrade-insecure-requests`. Set `false` only if you're not using HTTPS. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so client IPs (used for login rate limiting) are correct |
| `JAVA_BIN` | `java` | Java executable used for exports |
| `EXPORTER_JAR` | `exporter/target/access-exporter.jar` | Path to the exporter |
| `EXPORT_TIMEOUT_MS` | `60000` | Per-export time limit |
| `EXPORT_CONCURRENCY` | `2` | Exports that may run at once |
| `EXPORT_MAX_HEAP` | `512m` | Java heap per export; use `256m` on a 512 MB machine |
| `STATIC_DIR` | `web/dist` | Built web app to serve |

## Exporting to Access

**External Data → Access** (or **File → Export to Access**) downloads `<database>.accdb` in the Access 2016
format, which opens in Access 2007 and later.

Included: every table with its fields, data types, field sizes, descriptions, default values, Required, primary keys,
indexes, AutoNumber values (IDs are preserved), all data, and relationships including Enforce Referential Integrity.

Not included, because no open library can write them: saved query objects, forms and reports. Instead,
every saved query's SQL is written to a table named **`_SavedQueries`** — paste each into a new query in
Access's SQL View to recreate it. (The SQL you write here is Access SQL, so it usually works unchanged.)

Two safety nets keep exports from failing: a field marked *Required* that still has blank values is exported
without the Required flag, and a relationship whose data doesn't satisfy integrity is exported without
enforcement.

## Security notes

- Passwords are hashed with scrypt (Node's built-in `crypto`); sessions are random 256-bit tokens stored as SHA-256
  hashes, in an `HttpOnly`, `SameSite=Lax` cookie that lasts 30 days.
- Every project query is scoped to the signed-in user; other users' databases return 404.
- CSRF: state-changing requests must be JSON or carry `X-Requested-With`, which cross-site forms can't send.
- Login and registration are rate-limited per IP; Helmet sets a strict Content Security Policy.
- Saves use optimistic concurrency (`revision`), so two open windows can't silently overwrite each other — the
  second one is told to reload.
- Users' SQL runs only in their own browser, against their own data.

## Project layout

```
shared/        Data model + Zod schemas and templates, used by both server and web
server/        Express API: auth, projects, export (TypeScript)
  src/db.ts        SQLite connection and migrations
  src/auth.ts      Registration, login, sessions
  src/projects.ts  Project CRUD and the .accdb download
  src/export.ts    Converts a project to the exporter's JSON and runs Java
  test/            API tests (Vitest + Supertest), including a real export read back with mdb-reader
web/           React app (TypeScript)
  src/engine/      Access-SQL translator, in-browser SQLite query runner, value parsing/formatting
  src/workspace/   Shell: ribbon, navigation pane, tabs, autosave, undo, CSV import
  src/views/       Datasheet, Table Design, Query Design/SQL, Forms, Reports, Relationships
  test/            Query engine tests
exporter/      Java CLI using Jackcess: JSON on stdin -> .accdb
```

## Tests

```bash
npm test          # server API tests (needs Java + the built exporter for the export test) and web engine tests
npm run typecheck
```

## Extending

- **New field type:** add it to `FIELD_TYPES` in `shared/model.ts`, then handle it in `web/src/engine/values.ts`
  (parse/format), `web/src/engine/engine.ts` (`sqliteType`) and `AccessExporter.java` (`writeTable`/`convert`).
- **Database migrations:** append to `MIGRATIONS` in `server/src/db.ts`; never edit an entry that has shipped.
- **Changing the project document shape:** bump `version` in `projectDocSchema` and convert old documents when loading.

## Known limitations

- Queries are read-only SELECT queries (no update/append/delete or crosstab queries yet), and query results can't be
  edited in place.
- Forms and reports are generated layouts (choose fields, order, grouping) rather than free-form drag-and-drop designers.
- No macros, VBA, attachments, lookup fields, or multi-value fields.
- Each database is stored as one JSON document; this is comfortable up to tens of thousands of records per database.
  Bigger datasets would call for storing rows in their own table.
- Importing existing `.accdb`/`.mdb` files isn't built yet (the `mdb-reader` package used in the tests would make it
  straightforward).
