# Getting started — build your first table

This guide takes you from nothing to a Google Sheet that fills its own columns, in about ten minutes. You can drive every step yourself from the CLI, or let Claude Code do the building — both paths are below.

## 1. Prerequisites

- **Node.js 22+** — check with `node --version`
- **Google Workspace CLI** — handles Google Sheets access:

```bash
npm install -g @googleworkspace/cli
gws auth setup   # first time: creates a Cloud project, enables APIs, logs in
gws auth login   # subsequent logins
```

## 2. Install Rowbound

```bash
npm install -g github:eliasstravik/rowbound
```

## 3. Initialize your table

Create a Google Sheet (or copy an existing one) and grab its spreadsheet ID from the URL — the long string between `/d/` and `/edit`.

```bash
rowbound init <spreadsheet-id>
```

This writes a workflow config into the sheet itself (Developer Metadata). No local config files are created — any machine with access to the sheet can run its workflow.

## 4. Build the table

### Path A — with Claude Code (recommended)

Add Rowbound's MCP server to your Claude Code config:

```json
{ "mcpServers": { "rowbound": { "command": "rowbound", "args": ["mcp"] } } }
```

Then describe the table you want:

> "On sheet `<spreadsheet-id>`, add a waterfall that fills the `email` column — Hunter first, Apollo for the misses — and an AI column `segment` that classifies each company as SMB, mid-market, or enterprise. Dry-run it and show me the plan."

Claude configures the actions, validates the config, and shows you the dry-run plan before anything is written.

### Path B — by hand

One action per column. For example, fill `company_name` from a domain:

```bash
rowbound config add-action <spreadsheet-id> --json '{
  "id": "enrich_company",
  "type": "http",
  "target": "company_name",
  "url": "https://api.example.com/company?domain={{row.domain}}",
  "headers": { "Authorization": "Bearer {{env.API_KEY}}" },
  "extract": "$.name"
}'
```

## 5. Add your keys

Bring your own API keys — you pay providers directly, with zero markup:

```bash
rowbound env set API_KEY=your_key_here
```

Keys are stored in `~/.config/rowbound/.env` with `600` permissions. They never enter the spreadsheet.

## 6. Preview, then run

```bash
rowbound run <spreadsheet-id> --dry-run   # every write the run would make — nothing written
rowbound run <spreadsheet-id>             # fill the table
```

Open the sheet: the columns are filled. Cells that already have values are always skipped, so re-running is safe and never re-spends API calls.

## 7. Check the results

```bash
rowbound status <spreadsheet-id>   # completion rates per column
rowbound runs                      # run history with per-action durations and errors
```

## Where to go next

- **Keep it running** — `rowbound watch <spreadsheet-id> --interval 60` polls for new rows and hosts a webhook for real-time ingestion
- **Create rows automatically** — add sources (`http`, `webhook`, `exec`, `script`) with dedup and hourly/daily/weekly schedules
- **Give the team access** — the bundled [Google Sheets sidebar](../apps-script/) lets teammates view and edit the same workflow without a terminal
- **Full reference** — action types, source types, templates, and error handling are documented in the [README](../README.md)

Something not working? [Open an issue](https://github.com/eliasstravik/rowbound/issues).
