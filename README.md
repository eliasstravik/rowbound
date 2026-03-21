<p align="center">
  <img src="assets/logo.png" width="80" alt="Rowbound logo" />
</p>

<h1 align="center">Rowbound</h1>

<p align="center">
  A CLI for GTM Engineering in Google Sheets with Claude Code.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js" /></a>
</p>

---

## Demo

![Rowbound demo](assets/demo.gif)

## Install

### Prerequisites

- **Node.js 22+** — `node --version` must be >= 22.0.0
- **gws CLI** — [Google Workspace CLI](https://github.com/googleworkspace/cli) for Sheets access

```bash
npm install -g @googleworkspace/cli
gws auth setup   # first time: creates Cloud project, enables APIs, logs in
gws auth login   # subsequent logins
```

### Quick install

```bash
npm install -g github:eliasstravik/rowbound
```

### Build from source

```bash
git clone https://github.com/eliasstravik/rowbound.git
cd rowbound
npm install
npm run dev -- <command>
```

## Quick Start

```bash
# 1. Initialize a sheet
rowbound init <spreadsheet-id>

# 2. Add an action
rowbound config add-action <spreadsheet-id> --json '{
  "id": "enrich_company",
  "type": "http",
  "target": "company_info",
  "method": "GET",
  "url": "https://api.example.com/company?domain={{row.domain}}",
  "headers": { "Authorization": "Bearer {{env.API_KEY}}" },
  "extract": "$.name"
}'

# 3. Store API keys and run
rowbound env set API_KEY=your_key_here
rowbound run <spreadsheet-id>
rowbound run <spreadsheet-id> --dry-run   # preview first
```

Column names are automatically resolved to stable IDs when you run `rowbound sync`.

## Features

- **HTTP actions** — call any REST API with templated URLs, headers, and bodies; extract values with JSONPath
- **Waterfall actions** — try multiple providers in order until one returns a result (e.g., Clearbit → Apollo → Hunter)
- **Transform actions** — compute derived values with sandboxed JavaScript expressions
- **Exec actions** — run shell commands and capture stdout
- **Conditional execution** — skip actions per-row with `when` expressions
- **Smart skip** — automatically skips rows where the target cell already has a value
- **Watch mode** — poll sheets on an interval or trigger runs via webhook
- **Column tracking** — automatic column registry that survives header renames
- **Rate limiting** — global token-bucket rate limiter with configurable requests/second
- **Retry with backoff** — exponential, linear, or fixed backoff on failures
- **Structured error handling** — per-action `onError` config maps status codes to actions (skip, write fallback)
- **MCP server** — expose all operations as Model Context Protocol tools for Claude Desktop and other AI assistants
- **Run history** — track pipeline executions with per-action summaries, durations, and error logs
- **Dry run** — preview what would change without writing to the sheet
- **BYOK** — bring your own API keys, pay only for the APIs you use

## CLI Commands

| Command | Description |
|---------|-------------|
| `rowbound init <sheetId>` | Initialize a sheet with a default pipeline config |
| `rowbound run <sheetId>` | Run the enrichment pipeline (`--dry-run`, `--rows`, `--action`) |
| `rowbound status <sheetId>` | Show pipeline status and enrichment rates |
| `rowbound watch <sheetId>` | Watch for changes and run continuously (`--interval`, `--port`) |
| `rowbound sync <sheetId>` | Reconcile columns, validate config, fix issues |
| `rowbound config show <sheetId>` | Display the pipeline config as JSON |
| `rowbound config add-action <sheetId>` | Add an action to the pipeline |
| `rowbound config remove-action <sheetId>` | Remove an action by ID |
| `rowbound config update-action <sheetId>` | Update an action (merge partial JSON) |
| `rowbound config set <sheetId>` | Update pipeline settings (concurrency, rate limit, retry) |
| `rowbound config validate <sheetId>` | Validate the pipeline config |
| `rowbound runs [runId]` | List recent runs or view a specific run |
| `rowbound runs clear` | Delete all run history |
| `rowbound env set <KEY=value>` | Store an API key globally |
| `rowbound env remove <KEY>` | Remove a stored key |
| `rowbound env list` | List stored keys (values masked) |
| `rowbound mcp` | Start the MCP server (stdio) |

## MCP Server

Rowbound exposes all pipeline operations as MCP tools. Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "rowbound": {
      "command": "rowbound",
      "args": ["mcp"]
    }
  }
}
```

| Tool | Description |
|------|-------------|
| `init_pipeline` | Initialize a sheet with a default pipeline config |
| `run_pipeline` | Run the enrichment pipeline |
| `add_action` / `remove_action` / `update_action` | Manage pipeline actions |
| `update_settings` | Update pipeline settings (concurrency, rate limit, retry) |
| `sync_columns` | Sync the column registry with the current sheet state |
| `get_config` / `validate_config` | Read or validate the pipeline config |
| `get_status` | Return pipeline status with enrichment rates |
| `dry_run` | Run in dry mode (no writes) |
| `start_watch` / `stop_watch` | Manage watch mode |
| `preview_rows` | Read and display rows from the sheet |
| `list_runs` / `get_run` | View pipeline run history |

## Action Types

Templates use `{{row.column}}` for row data and `{{env.KEY}}` for environment variables. Actions support conditional execution with `when` expressions and structured error handling with `onError`.

### http

Call a REST API and extract a value with JSONPath.

```json
{
  "id": "get_company",
  "type": "http",
  "target": "company_name",
  "when": "row.domain !== ''",
  "method": "GET",
  "url": "https://api.clearbit.com/v2/companies/find?domain={{row.domain}}",
  "headers": { "Authorization": "Bearer {{env.CLEARBIT_API_KEY}}" },
  "extract": "$.name",
  "onError": { "404": "skip", "429": "skip", "default": { "write": "ERROR" } }
}
```

### waterfall

Try multiple providers in order. First non-empty result wins.

```json
{
  "id": "find_email",
  "type": "waterfall",
  "target": "email",
  "providers": [
    {
      "name": "hunter",
      "method": "GET",
      "url": "https://api.hunter.io/v2/email-finder?domain={{row.domain}}&first_name={{row.first_name}}&last_name={{row.last_name}}&api_key={{env.HUNTER_API_KEY}}",
      "extract": "$.data.email"
    },
    {
      "name": "apollo",
      "method": "POST",
      "url": "https://api.apollo.io/api/v1/people/match",
      "headers": { "Content-Type": "application/json", "X-Api-Key": "{{env.APOLLO_API_KEY}}" },
      "body": { "email": "{{row.personal_email}}", "domain": "{{row.domain}}" },
      "extract": "$.person.email"
    }
  ]
}
```

### transform

Compute a value with a sandboxed JavaScript expression.

```json
{
  "id": "full_name",
  "type": "transform",
  "target": "full_name",
  "expression": "`${row.first_name} ${row.last_name}`"
}
```

### exec

Run a shell command and capture stdout. Template values are shell-escaped.

```json
{
  "id": "whois_lookup",
  "type": "exec",
  "target": "registrar",
  "command": "whois {{row.domain}} | grep 'Registrar:' | head -1 | cut -d: -f2",
  "timeout": 10000,
  "onError": { "default": "skip" }
}
```

### lookup

Read data from another tab by matching a column value.

```json
{
  "id": "get_email",
  "type": "lookup",
  "target": "email",
  "sourceTab": "Contacts",
  "matchColumn": "Domain",
  "matchValue": "{{row.domain}}",
  "matchOperator": "equals",
  "returnColumn": "Email",
  "matchMode": "first"
}
```

### write

Write or append data to another tab. Supports array expansion for one-to-many mappings.

```json
{
  "id": "archive_lead",
  "type": "write",
  "target": "archive_status",
  "destTab": "Archive",
  "columns": { "Name": "{{row.name}}", "Email": "{{row.email}}" },
  "mode": "append"
}
```

### Error handling

Actions can define `onError` to map HTTP status codes (or exit codes for exec) to behaviors:

| Action | Effect |
|--------|--------|
| `"skip"` | Skip this action for the current row |
| `"stop_provider"` | Stop the current waterfall provider, try the next |
| `{"write": "value"}` | Write a fallback value to the target cell |

## Google Sheets Sidebar

Rowbound includes an Apps Script sidebar that lets you configure actions directly in Google Sheets — no CLI needed. Click a column, edit the action config in a sidebar UI, and save. The sidebar reads and writes the same Developer Metadata config as the CLI, so both stay in sync.

### Setup

1. Open your Google Sheet → **Extensions → Apps Script**
2. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs)
3. Click **+** next to Files → **HTML** → name it `Sidebar` → paste [`apps-script/Sidebar.html`](apps-script/Sidebar.html)
4. In the left panel, click **+** next to **Services** → select **Google Sheets API** → set Identifier to `Sheets` → click **Add**
5. Press **Cmd+S** (or Ctrl+S) to save
6. Reload your spreadsheet — a **Rowbound** menu appears in the menu bar

### Usage

- **Rowbound → Actions** — view all configured actions, reorder them, or create new ones
- **Rowbound → Settings** — edit pipeline settings (concurrency, rate limit, retries, backoff)
- Click any action to edit its full config: type, run conditions, request details, headers, extract path, error handling
- The column dropdown (●/○ indicators) lets you navigate between columns and see which ones have actions

### Supported action types

All action types are configurable through the sidebar: HTTP, Waterfall, Transform, Exec, Lookup, and Write. The sidebar covers every field the CLI supports.

> **Note:** The sidebar is a config editor only — it doesn't execute the pipeline. Use `rowbound run` via the CLI to execute. The `exec` action type can be configured in the sidebar but only executes via the CLI (no shell access in Apps Script).

### Multi-sheet use

To use the sidebar across multiple sheets, repeat the setup steps for each sheet. Alternatively, you can set up a test deployment:

1. In the Apps Script editor → **Deploy → Test deployments**
2. Click the gear icon → select **Editor Add-on**
3. Click **Create new test** → select any sheet as test document → **Save test**
4. The add-on will be available in your test document; for other sheets, repeat the paste-in setup

## Development

```bash
npm install
npm run dev -- <command>
```

| Command | Description |
|---------|-------------|
| `npm run dev -- <command>` | Run a CLI command in development mode |
| `npm run build` | Type-check and build for production |
| `npm test` | Run tests |
| `npm run lint` | Lint with Biome |

## Security

- **Expression sandbox** — `when` conditions and transform expressions run in Node.js `vm.runInContext` with keyword blocking; convenience sandbox, not a security boundary
- **Exec actions** — shell commands run locally; template values are shell-escaped but use only with trusted data
- **SSRF protection** — HTTP requests enforce HTTPS by default and block private/internal IP ranges; set `ROWBOUND_ALLOW_HTTP=true` for local dev
- **Webhook auth** — set `ROWBOUND_WEBHOOK_TOKEN` to require bearer token authentication; server binds to localhost by default
- **API keys** — stored in `~/.config/rowbound/.env` with `600` permissions; `.gitignore` excludes `.env`
- **Env filtering** — only `ROWBOUND_*`, `NODE_ENV`, `PATH`, and explicitly referenced vars are exposed to actions
- **MCP permissions** — the MCP server inherits the authenticated `gws` CLI session permissions

## License

[MIT](LICENSE)
