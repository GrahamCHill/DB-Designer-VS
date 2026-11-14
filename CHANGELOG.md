# Changelog

## 0.5.1

- **AI model discovery.** Choose from the models available through Groq, other OpenAI-compatible endpoints, Anthropic, Ollama, and VS Code. The extension saves the selected model for future normalisation reviews.
- **API key management.** Groq and other OpenAI-compatible providers can retry discovery with a replacement key after an authentication failure. Keys entered in DB Designer are encrypted through VS Code Secret Storage.

## 0.5.0

- **Shape relationship lines by hand.** Select a line to get handles. Slide its segments, add bends and move them (snapped to a grid), or double-click a bend to remove it. **⇄ PK side** / **⇄ FK side** move an end to the other side of its table, and **Reset** returns the line to automatic routing. Line shapes are saved with the diagram, in `.erd.json`, the HTML viewer and image exports.
- **Undo/redo for everything**: Ctrl+Z, Ctrl+Shift+Z (or Ctrl+Y; ⌘ on macOS). This now covers moving tables, auto layout, groups and line shapes, as well as schema edits.
- **+ Relation removed from the toolbar.** Each table header now has a link button that opens the relationship dialog for that table. Dragging between column dots still works.
- **Latest engine versions.**
  - New **SQL Server 2025** export target, with native `json` and `vector(n)`.
  - PostgreSQL 18 support: `uuidv7()`/`uuidv4()` defaults and `VIRTUAL` generated columns are parsed, exported, and emulated during PGlite validation.
  - pgvector `vector(n)` maps to the closest type in every target.
  - The parser accepts MariaDB `VECTOR INDEX`.
  - Live connections read SQL Server 2025 `vector(n)`, PostgreSQL generated columns, and MariaDB's integer display widths.
  - PostgreSQL types are shown with their short names (`timestamptz`, `varchar(n)`).
  - Verified on PostgreSQL 16 and 18 (+pgvector), SQL Server 2022 and 2025, MySQL 8.4 and 9.7, MariaDB 13.0 and SQLite. CI now runs a matrix of the oldest and latest versions.
- Database connections are strictly read-only. PostgreSQL uses a read-only session and transaction, verified before reading. MySQL uses `START TRANSACTION READ ONLY`. SQL Server reads inside a transaction that is always rolled back.

## 0.4.0: DB Designer VS

- **Renamed to DB Designer VS.** Command IDs and settings moved from `erdViewer.*` to `dbDesigner.*`. `.erd.json` files from earlier versions still open.
- **Validated SQL export.** Every export is checked before saving. PostgreSQL output is executed in PostgreSQL 17 (PGlite, in-process), and migrations are executed on top of the starting schema. SQLite output is executed in SQLite. SQL Server and MySQL output is re-read and compared with the diagram. Model rules run for every dialect. A new **Validate SQL (all dialects)** command reports on all four targets.
- **Groq / OpenAI-compatible AI provider**, with presets for Groq, OpenAI, OpenRouter, LM Studio, or a custom URL, and a model picker. **API keys are stored encrypted** in VS Code Secret Storage (the OS keychain).
- **Routed relationship lines** that go around tables instead of under them, using an A* search on a sparse orthogonal grid. Toggle with **Lines: routed / direct**. Auto layout leaves wider corridors.
- **Table groups**, as in DB-Designer: coloured, resizable and nestable groups. Dragging a header moves the group with its tables. Groups are saved and exported.
- The AI review now tolerates common variations in how models describe operations.
- Removed the ✨ icon from **AI review**.

## 0.3.0

- **Export to SQL Server, MySQL/MariaDB and SQLite** alongside PostgreSQL. Types and defaults are converted to the closest equivalents. The exporter also handles each engine's rules: SQL Server cascade-path and key-size limits, nullable unique columns, unique constraint names, MySQL row-size and default rules, and SQLite inline foreign keys. Every lossy conversion is listed under "Conversion notes" in the output. All four dialects were tested on real engines, with schema creation, introspection and data checks.
- **DB Designer sidebar** in the Activity Bar, with three views: open and recent diagrams, saved database connections, and auto-detected SQL folders in the workspace.
- Fixed: a parsed default of `- 1` (with a space) is now treated as the number -1.

## 0.2.0

- **Image export**: the whole diagram as a high-resolution PNG (up to 4×) or as a vector SVG with unlimited zoom.
- **Sharing**: save a diagram as `.erd.json` (schema + layout). It opens with a double-click in VS Code and stays editable, with **Save** writing back to the file. You can also export a standalone `.html` viewer that anyone can open in a browser without installing anything.
- **Relationships**: a new **+ Relation** dialog, also opened by dragging between column dots. It supports many-to-one, one-to-one and many-to-many (which creates a join table). It can create the FK column for you, offers to make the referenced column unique, and aligns the column types.
- **AI normalisation review**: ✨ AI review checks the schema for 1NF/2NF/3NF/BCNF, redundancy and key problems. You can apply each suggestion to the diagram as an undoable change. It works with VS Code language models (Copilot), the Anthropic API, or a local Ollama model.
- **Agent tools**: `#dbSchema` and `#dbApply` let chat agents in VS Code read the open diagram and propose changes, which you confirm before they are applied.
- MIT license, plus a GitHub Actions build that tests on Linux/Windows/macOS and publishes the VSIX to GitHub Releases.

## 0.1.0

- First version: ERDs from SQL migration folders or live PostgreSQL / SQL Server / MySQL / SQLite databases, a table editor, and PostgreSQL export (full schema or migration).
