# Changelog

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
