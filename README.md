# DB Designer VS

*A database designer for Visual Studio Code.* (Formerly "ERD Viewer".)

Interactive, editable entity-relationship diagrams, with Supabase-style behaviour: draggable tables, FK lines from column to column, and a side-panel table editor. It builds the diagram from either:

- **a folder or set of `.sql` files**: migrations are replayed in natural name order (`00-init.sql`, `01-…`, `10-…`), or
- **a live database**: PostgreSQL, SQL Server, MySQL/MariaDB or a SQLite file.

The diagram works in **PostgreSQL** terms. You can export the full schema as **PostgreSQL, SQL Server (2016–2022 or 2025), MySQL/MariaDB or SQLite**, with each type converted to its closest equivalent. You can also export a PostgreSQL migration containing only the changes you made in the diagram.

## Using it

Click the **DB Designer** icon in the Activity Bar for the sidebar:

- **Diagrams**: open diagrams (● marks unsaved edits) and recently opened ones. The title bar has buttons to open a SQL folder, connect to a database, or start a blank diagram.
- **Database Connections**: your saved connections. Click one to open it as a diagram; the trash icon removes it.
- **SQL Folders in Workspace**: every folder in the workspace that contains `.sql` files (e.g. `db/`, `migrations/`). Click one to open it as a diagram.

Everything is also available from the Command Palette:

| Command (Ctrl+Shift+P → "DB Designer") | |
|---|---|
| **Open ERD from SQL Folder…** | Pick e.g. `MPUDOH-ContractManagementTool/db`. Sub-folders are included; folders starting with `.` and those in `dbDesigner.excludeFolders` are skipped. |
| **Open ERD from SQL Files…** | Pick individual files (applied in name order). |
| Explorer → right-click a folder / `.sql` file → **Open ERD** | Same, from the explorer. Multi-select works. |
| **Open ERD from Database Connection…** | Saved connections live in VS Code Secret Storage. |
| **Remove Saved Connection…** | |
| **New Blank ERD** | Start from an empty PostgreSQL diagram. |
| **Open Shared Diagram (.erd.json)…** | Open a diagram someone shared, or double-click any `*.erd.json` file. |
| **AI: Review Normalisation of Open Diagram** | Opens the AI review panel. Related commands: **AI: Choose Provider…**, **AI: Choose Model…**, **AI: Set API Key (stored encrypted)…**, **AI: Remove Saved API Keys…**. |

Connection string examples:

```
postgres://user:pass@localhost:5432/mydb            (?sslmode=require for hosted / Supabase)
Server=localhost,1433;Database=mydb;User Id=sa;Password=…;Encrypt=true;TrustServerCertificate=true
mssql://user:pass@host:1433/mydb?trustServerCertificate=true
mysql://user:pass@localhost:3306/mydb
```

For live PostgreSQL connections, Supabase's internal schemas (`auth`, `storage`, `realtime`, …) are hidden by default. Use the **Schemas** filter to show them.

### In the diagram

- **Columns** show their type. Icons mark 🔑 primary key, 🔗 foreign key, `#` identity, unique, and ◇/◆ nullable/not-null. Hover a column to see its default and comment.
- **Relations** run from the referenced column (marked **PK**, with a bar for "one") to the referencing column (marked **FK**, with a crow's foot for "many", or a bar when the FK is unique, i.e. 1:1). Hover or select a line to see `child.col → parent.col`, the cardinality, and `ON DELETE`.
- Selecting a table highlights its relations and related columns and dims everything else.
- **Drag** tables to move them. Positions are saved per source. Use **Auto layout** to re-arrange.
- **Find table…** jumps to a table. Press Enter again to cycle through matches.

### Lines and layout

- **Lines: routed** (the default) draws each relationship as an orthogonal path that goes *around* tables instead of under them. The path is found with an A* search over the corridors between tables, with a penalty for bends. Click the button to switch to direct lines. While you drag, the lines attached to the moving tables are drawn directly, and they re-route when you drop.
- **Shape a line by hand**: click a line to select it. Handles appear on it:
  - a bar on each middle segment: drag it to slide that part of the line sideways (snapped to a 10px grid);
  - a dashed dot on the first and last segment: drag it to add a bend;
  - a round dot on each bend you added: drag it to move the bend, or double-click it to remove it.

  The selected line's label also has **⇄ PK side** / **⇄ FK side**, which attach that end to the other side of its table, and **Reset**, which returns the line to automatic routing. A hand-shaped line keeps its bends when tables move, and its ends stay on their columns. Line shapes are saved with the diagram, in `.erd.json` files, the HTML viewer and image exports.
- **Auto layout** spaces tables out with wide corridors so routed lines have room. Groups are kept intact and moved as blocks.

### Groups

Like DB-Designer, you can wrap related tables in coloured groups:

- Select tables (Ctrl/Shift-click, or Shift-drag a box) and click **+ Group** to wrap them. With nothing selected you get an empty group, placed in a free area.
- **Drag the group header** to move the group with all its tables and nested groups. Select a group to resize it with its handles.
- **Drop a table inside a group** to add it; drag it out to remove it. Drop a group inside another to nest it. Nested groups show a dashed border and a SUB tag.
- **Edit** (on the header) renames the group, changes its colour, or deletes it. The tables are kept.
- Groups are saved with the layout, in `.erd.json` files and in the standalone HTML, and they appear in PNG/SVG exports.

### Editing

- The **link** button on a table header opens the relationship dialog with that table as the FK (child) side. You can also drag from a column's dot (visible when you hover a table) to another column. The dialog lets you:
  - choose **many-to-one**, **one-to-one** (the FK column becomes unique), or **many-to-many** (creates a join table with a composite PK and two FKs);
  - pick an existing FK column, or **+ New column…**, which suggests e.g. `user_id` with the referenced column's type;
  - set ON DELETE / ON UPDATE.

  It also offers to make the referenced column UNIQUE when it isn't a key (PostgreSQL requires that), and to change the FK column's type to match.
- **+ Table** adds a table with `id bigint` identity PK and `created_at timestamptz`.
- **+** on a table header adds a column. **✎**, or double-clicking a table or column, opens the editor panel. There you can rename, change type, PK, nullable, unique, identity, default and description, set an FK reference with ON DELETE/UPDATE, reorder or delete columns, and delete the table.
- **Drag from a column's edge dot to another column** to create a foreign key. If one side is a PK/unique column, it becomes the referenced side.
- Select a relation line and press **Delete** to drop that FK.
- **Undo/Redo**: **Ctrl+Z** / **Ctrl+Shift+Z** (Ctrl+Y also redoes; ⌘ on macOS), or the ↶ ↷ toolbar buttons. Undo covers schema edits, moving tables, auto layout, groups (add, rename, recolour, resize, delete) and line shapes. Up to 200 steps; typing in one field within 1.5 s is one step.
- Edits are kept as a draft per source, and survive closing the tab. **Discard edits** reverts to the source. **Reload** re-reads it. SQL-file sources reload automatically when files change, unless you have draft edits.

### Export SQL

**Every export is validated before it is saved**, and the result is written into the file's header:

| Target | How it is checked |
|---|---|
| PostgreSQL | **Executed** in PostgreSQL 17, running in-process via PGlite (WebAssembly). The `uuid-ossp`, `pgcrypto` and `citext` extensions are included. A migration is run on top of the starting schema. PostgreSQL 18 features are emulated and named in the result: `uuidv7()` / `uuidv4()`, and `VIRTUAL` generated columns (checked as stored). Output that needs another extension, such as `vector`, is not executed; the model rules still run. |
| SQLite | **Executed** in SQLite (sql.js), followed by `PRAGMA foreign_key_check` and `integrity_check`. |
| SQL Server, MySQL | Re-read with the parser and compared with the diagram (every table, column, primary key and foreign key), plus syntax balance checks. These engines can't run inside VS Code; CI runs the same exports on real engines (see [Supported engine versions](#supported-engine-versions)). |
| All | Model rules: empty or duplicate names, identifiers over the engine's length limit, FKs to non-key columns or incompatible types, tables without columns, clashing names after schema flattening, and PostgreSQL index-name clashes. |

If anything fails you see the problems (also listed in the **DB Designer** output channel) and can fix them or **Save Anyway**. **Export SQL → Validate SQL (all dialects)** runs the checks for every target without saving.

**Full schema**: choose **PostgreSQL**, **SQL Server** (2016–2022), **SQL Server 2025**, **MySQL / MariaDB** or **SQLite**. If schemas are hidden in the filter, only the visible ones are exported.

Every column type is first normalised to PostgreSQL (so a diagram loaded from SQL Server or MySQL works too), then mapped to the closest type in the target. Anything that can't be represented exactly is converted to the nearest safe form and listed under **Conversion notes** at the end of the file.

| PostgreSQL | SQL Server | MySQL / MariaDB | SQLite |
|---|---|---|---|
| `uuid` | `uniqueidentifier` | `char(36)` | `TEXT` |
| `text` | `nvarchar(max)` (`nvarchar(450)` in keys) | `text` (`varchar(255)` in keys) | `TEXT` |
| `varchar(n)` / `char(n)` | `nvarchar(n)` / `nchar(n)` | `varchar(n)` / `char(n)` | `VARCHAR(n)` / `CHAR(n)` |
| `integer` / `bigint` / `smallint` | `int` / `bigint` / `smallint` | `int` / `bigint` / `smallint` | `INTEGER` |
| `serial`, identity | `IDENTITY(1,1)` | `AUTO_INCREMENT` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `numeric(p,s)` | `decimal(p,s)` (unbounded → `decimal(38,10)`) | `decimal(p,s)` (unbounded → `decimal(65,30)`) | `NUMERIC(p,s)` |
| `boolean` | `bit` | `boolean` (= `tinyint(1)`) | `INTEGER` + `CHECK (x IN (0,1))` |
| `timestamp` / `timestamptz` | `datetime2` / `datetimeoffset` | `datetime(6)` (store UTC) | `DATETIME` (ISO-8601 text) |
| `json` / `jsonb` | `nvarchar(max)` + `ISJSON` check; **2025: `json`** | `json` | `TEXT` + `json_valid` check |
| `vector(n)` (pgvector) | JSON array in `nvarchar(max)`; **2025: `vector(n)`** (up to 1998 dims) | `json` array | `TEXT` JSON array |
| `bytea` | `varbinary(max)` | `longblob` | `BLOB` |
| enum type | `nvarchar` + `CHECK (… IN …)` | `enum(…)` | `TEXT` + `CHECK (… IN …)` |
| arrays | JSON text; **2025: `json`** | `json` | JSON text |
| `interval`, `inet`, `tsvector` | text equivalents (noted) | text equivalents (noted) | `TEXT` |

Defaults are converted too:

| PostgreSQL | SQL Server | MySQL | SQLite |
|---|---|---|---|
| `now()` | `SYSDATETIMEOFFSET()` / `SYSDATETIME()` | `CURRENT_TIMESTAMP(6)` | `CURRENT_TIMESTAMP` |
| `gen_random_uuid()`, `uuidv7()`, `uuidv4()` | `NEWID()` | `(UUID())` | a v4 UUID expression |
| `true` | `1` | `1` | `1` |

The exporter also handles each engine's rules:

- **SQL Server**
  - Text in keys gets a bounded type.
  - A nullable UNIQUE column becomes a filtered unique index, so many NULLs are still allowed as in PostgreSQL.
  - Constraint names are made unique.
  - `ON DELETE CASCADE` / `SET NULL` that would create multiple or cyclic cascade paths, which SQL Server rejects, are downgraded to NO ACTION with a note. So are `SET NULL` / `SET DEFAULT` actions that can't apply because a column is NOT NULL.
- **MySQL**
  - All tables go into the current database. MySQL schemas are separate databases, so the schema name is prefixed only where table names would clash.
  - Expression defaults are used for `text` and `json`.
  - Very wide tables are kept within InnoDB's 65,535-byte row limit.
  - `SET DEFAULT`, which InnoDB doesn't support, becomes NO ACTION.
- **SQLite**
  - Foreign keys are declared inline, and `PRAGMA foreign_keys = ON` is emitted.
  - Schemas are flattened the same way as MySQL.
- **Not converted, with a note**: generated-column expressions and domain `CHECK` constraints. They are dialect-specific.

**Changes only (migration)**: a PostgreSQL `BEGIN … COMMIT` script with the `CREATE`/`ALTER`/`DROP`/`RENAME` statements that turn the source schema into your edited one.

### Share

- **Image: PNG (high-res)**: the whole diagram (every visible table, including off-screen ones), drawn at up to 4× resolution. For example, the 94-table Contract Management schema comes out at about 10,000 × 12,000 px. The PNG is limited by browser canvas size, so for unlimited zoom use SVG.
- **Image: SVG (vector)**: about 0.6 MB for 94 tables. It is real SVG (shapes and text, no embedded HTML), so it opens in browsers, Inkscape, Illustrator and Visio, and you can zoom in indefinitely. Images use a light background by default; tick **Dark image background** to switch.
- **Diagram file (.erd.json)**: schema + layout + schema filter. Double-click it in VS Code to open it in DB Designer, keep editing, and use **Save** to write it back. Commit it next to your migrations or send it to a colleague.
- **Standalone viewer (.html)**: one self-contained file, about 0.5 MB plus your schema. It opens in any browser with no install and no network, and lets the reader pan, zoom, search, filter schemas, re-layout, and download PNG/SVG/.erd.json. Viewing only.

### AI normalisation review

**AI review** asks a language model to check the diagram for 1NF/2NF/3NF/BCNF problems: repeating groups, list-in-a-column, partial and transitive dependencies, duplicated facts, missing FKs and keys, and types like dates or money stored as text. Each suggestion comes with a severity, an explanation, and concrete steps. **Apply to diagram** performs the steps as one undoable edit, and **Export migration** turns everything you applied into SQL. You can review the whole visible diagram or just the selected table and its neighbours, and add a focus ("look at the approvals tables").

Only the schema structure is sent (tables, columns, types, keys), never row data. Use **Provider…** in the review panel or **DB Designer: AI: Choose Provider…** to set up a provider. Use **Model…** or **DB Designer: AI: Choose Model…** to refresh the active provider's model list and save a selection for future reviews.

| Provider (`dbDesigner.ai.provider`) | Needs | Notes |
|---|---|---|
| `vscode` (default) | GitHub Copilot or another VS Code chat-model provider | Lists available VS Code chat models and saves the ID in `dbDesigner.ai.vscodeModel`. |
| `anthropic` | An Anthropic API key (**AI: Set API Key…** or `ANTHROPIC_API_KEY`) | Lists models from the Anthropic API and saves the ID in `dbDesigner.ai.anthropicModel`. Uses structured JSON output and server-side refusal fallbacks where supported. |
| `openai` | **Groq** (default), OpenAI, OpenRouter, LM Studio, or an OpenAI-compatible URL (`dbDesigner.ai.openaiBaseUrl`). For hosted APIs, use **AI: Set API Key…** or the provider's environment variable (`GROQ_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`). | Queries the endpoint's `/models` API and saves the ID in `dbDesigner.ai.openaiModel`. If discovery fails, the warning offers manual ID entry. Requests JSON-schema output where the server supports it. |
| `ollama` | A running [Ollama](https://ollama.com) (`dbDesigner.ai.ollamaUrl`) | Lists installed Ollama models and saves the name in `dbDesigner.ai.ollamaModel`. Small models work but are slow and less reliable. `qwen3.5:4b` gave a correct review of a test schema in about 5 minutes on CPU. |

**API keys entered in DB Designer are encrypted by VS Code Secret Storage.** OpenAI-compatible keys are stored per server origin. Settings store the provider, endpoint URL and model ID.

### Agent tools (Copilot agent mode and other VS Code agents)

The extension registers two language-model tools for chat agents:

- **`#dbSchema`** (`db-designer_getSchema`) returns the open diagram, including unsaved edits, as PostgreSQL DDL or JSON.
- **`#dbApply`** (`db-designer_applyChanges`) applies a list of schema operations to the open diagram. You see the list and confirm before anything changes. The result is an undoable draft that you can export as a migration.

For example, in Copilot chat (agent mode): *"Use #dbSchema and normalise the contracts area to 3NF, then apply it with #dbApply."*

## How SQL files are interpreted

A tolerant DDL parser replays the scripts:

- `CREATE TABLE [IF NOT EXISTS]`, `LIKE`, inline and table constraints
- `ALTER TABLE` add/drop/rename/alter column, add/drop/rename constraint, `RENAME TO`, `SET SCHEMA`
- `DROP TABLE`, `CREATE UNIQUE INDEX`, `COMMENT ON`, `CREATE TYPE … AS ENUM` / `ALTER TYPE … ADD VALUE`, `CREATE DOMAIN`
- `SET search_path`, which resets for each file the way `docker-entrypoint-initdb.d` runs them
- DDL inside `DO $$ … $$` blocks. `IF to_regclass('x') IS [NOT] NULL` guards are evaluated against the schema so far. Other guards (e.g. `IF NOT EXISTS (SELECT … information_schema …)`) are treated as true.
- T-SQL `GO` batches, `[brackets]`, `IDENTITY`, and `WITH CHECK ADD CONSTRAINT`; MySQL backticks and `AUTO_INCREMENT`; SQLite `AUTOINCREMENT`

Functions, triggers, views, DML and grants are ignored. Warnings go to the **DB Designer** output channel and the ⚠ toolbar button.

## Supported engine versions

Every export target is run on real engines in CI on each push. Each run creates the schema, introspects it back, compares it with the diagram, and checks defaults, cascades and constraints with real rows:

| Engine | Oldest tested | Latest tested |
|---|---|---|
| PostgreSQL | 16 | 18 (with pgvector): `uuidv7()`, `VIRTUAL` generated columns, `vector(n)` |
| SQL Server | 2022 (**SQL Server** target) | 2025 (**SQL Server 2025** target: native `json`, `vector(n)`) |
| MySQL | 8.4 | 9 |
| MariaDB | n/a | latest (13.0) |
| SQLite | bundled 3.x (sql.js) | |

Live connections read these versions too: SQL Server 2025 `json` and `vector(n)` columns, PostgreSQL 18 virtual generated columns, and MariaDB's integer display widths (`int(11)` is shown as `int`). PostgreSQL types appear with their usual short names (`timestamptz`, `varchar(n)`).

## Releases

`.github/workflows/build.yml` runs typecheck, tests and an activation smoke test on Linux, Windows and macOS for every push and PR, and packages the VSIX. Pushing to the default branch, or pushing a `vX.Y.Z` tag that matches `package.json`'s version, publishes a GitHub Release `vX.Y.Z` with the `.vsix` attached and generated notes. To release, bump `version` in `package.json`, add a `CHANGELOG.md` entry, and push. Install a release with **Extensions → … → Install from VSIX…**.

## Development

```bash
npm install
npm run build        # dist/extension.js + dist/webview.js/.css
npm test             # parser, exporter, schema-ops/AI parsing, standalone HTML, SQLite introspection
npm run smoke        # activation check: commands, custom editor and LM tools register
npm run package      # → db-designer-vs-<version>.vsix
```

Press **F5** in VS Code to launch an Extension Development Host.

- `test/integration.ts` checks the parser and exporter against a real PostgreSQL. It compares parser output with introspection, re-applies a full export, and applies a generated migration. See the header of the file for usage.
- `test/dialect-integration.ts` runs every exported dialect on real engines: PostgreSQL, SQL Server and MySQL/MariaDB in Docker, and SQLite in-process. Set `MSSQL2025_URL` to also run the SQL Server 2025 target, and `ENGINES=postgres,mysql` to run only some engines. A **latest-features** input covers `uuidv7()`, virtual generated columns, `vector` and `json`; it runs on PostgreSQL only when the server is 18+ with pgvector. It creates the schema, introspects it back, and compares it with the model (tables, columns, nullability, keys, FKs, defaults, declared types, FK actions). It then inserts and deletes rows to check that defaults, cascades and enum/CHECK constraints behave the same. See the header of the file for the connection settings.
- `test/harness/index.html` runs the webview in a normal browser with a stubbed VS Code API. Generate its data with `node dist-test/make-data.js <sql-folder>` after bundling `test/harness/make-data.ts`.

## License

[MIT](LICENSE)
