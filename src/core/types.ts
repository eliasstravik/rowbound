// Rowbound Core Types

/** Reference to a Google Sheet */
export interface SheetRef {
  spreadsheetId: string;
  sheetName?: string;
}

/** A row of data: header name -> cell value */
export type Row = Record<string, string>;

/** Shared context passed to condition evaluation and template resolution */
export interface ExecutionContext {
  row: Row;
  env: Record<string, string>;
  results?: Record<string, unknown>;
  /** Available during write action array expansion: properties of the current array element */
  item?: Record<string, string>;
}

/** A single cell update to write back to the sheet */
export interface CellUpdate {
  row: number;
  column: string;
  value: string;
}

/** Error handling config: maps error codes to actions */
export type OnErrorConfig = Record<string, string | { write: string }>;

// ---------------------------------------------------------------------------
// Scripts — reusable code blocks
// ---------------------------------------------------------------------------

/** A reusable script definition stored in the config */
export interface ScriptDef {
  /** Runtime to execute the script with */
  runtime: "bash" | "python3" | "node";
  /** The script code (multi-line, stored with real newlines) */
  code: string;
}

/** HTTP enrichment action */
export interface HttpAction {
  id: string;
  type: "http";
  target: string;
  when?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  extract: string;
  onError?: OnErrorConfig;
  runSettings?: ActionRunSettings;
}

/** A single provider in a waterfall action */
export interface WaterfallProvider {
  name: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  extract: string;
  onError?: OnErrorConfig;
}

/** Waterfall action: tries providers in order until one succeeds */
export interface WaterfallAction {
  id: string;
  type: "waterfall";
  target: string;
  when?: string;
  providers: WaterfallProvider[];
  runSettings?: ActionRunSettings;
}

/** Transform action: computes a value from existing data */
export interface TransformAction {
  id: string;
  type: "transform";
  target: string;
  when?: string;
  expression: string;
}

/** Exec action: runs a shell command and captures output */
export interface ExecAction {
  id: string;
  type: "exec";
  target: string;
  when?: string;
  command: string;
  extract?: string;
  timeout?: number;
  onError?: OnErrorConfig;
  runSettings?: ActionRunSettings;
}

/** Lookup action: reads data from another tab and returns a matched field */
export interface LookupAction {
  id: string;
  type: "lookup";
  target: string;
  when?: string;
  /** Tab name to search in (same spreadsheet) */
  sourceTab: string;
  /** Column header in the source tab to match against */
  matchColumn: string;
  /** Value to match — either a column name (e.g. "Clean Domain") which reads from the
   *  current row, or a template (e.g. "{{row.email}}"). Plain strings without {{ are
   *  treated as column name references. */
  matchValue: string;
  /** Operator for matching (default: "equals") */
  matchOperator?: "equals" | "contains";
  /** Column header in the source tab to return (used when returnType is "value") */
  returnColumn?: string;
  /** What to return (default: "value")
   *  - "value": the returnColumn value from the first match (or JSON array in "all" mode)
   *  - "boolean": "true" if any match found, "false" otherwise
   *  - "count": number of matching rows as a string
   *  - "rows": JSON array of full matching row objects */
  returnType?: "value" | "boolean" | "count" | "rows";
  /** "first" returns first match; "all" returns all matches (default: "first"). Only used with returnType "value". */
  matchMode?: "first" | "all";
}

/** Write action: writes data from the current row to another tab */
export interface WriteAction {
  id: string;
  type: "write";
  target: string;
  when?: string;
  /** Destination tab name (same spreadsheet) */
  destTab: string;
  /** Column mappings: { "Dest Header": "{{row.source}}" } */
  columns: Record<string, string>;
  /** Write mode (default: "append") */
  mode?: "append" | "upsert";
  /** For upsert: how to match existing rows in the destination */
  upsertMatch?: {
    /** Column header in destination tab to match on */
    column: string;
    /** Template for the value to match (e.g. "{{row.email}}") */
    value: string;
  };
  /** Template resolving to a JSON array (or JSON object when expandPath is set) —
   *  creates one destination row per element.
   *  Column values can use {{item}} or {{item.field}} to access element data. */
  expand?: string;
  /** JSONPath to extract the array from the expanded value.
   *  e.g. "$.contacts" extracts the contacts array from {"contacts": [...]} */
  expandPath?: string;
}

// ---------------------------------------------------------------------------
// Sources — create rows from external data
// ---------------------------------------------------------------------------

/** HTTP source: fetch from an API and create rows from the response */
export interface HttpSource {
  id: string;
  type: "http";
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** JSONPath to extract the array from the response (e.g. "$" for top-level array) */
  extract: string;
  /** JSONPath to drill into a nested object before extracting the array (e.g. "$.results") */
  extractPath?: string;
  /** Column mappings: { "Header": "$.field" } — JSONPath per element */
  columns: Record<string, string>;
  /** Column header to deduplicate on. Existing rows with the same value are skipped or updated. */
  dedup?: string;
  /** When true and dedup is set, update matched rows instead of skipping (default: false) */
  updateExisting?: boolean;
  /** Run schedule: "manual" (default), "hourly", "daily", "weekly", or cron expression */
  schedule?: string;
  onError?: OnErrorConfig;
}

/** Exec source: run a shell command and create rows from JSON output */
export interface ExecSource {
  id: string;
  type: "exec";
  command: string;
  /** JSONPath to extract the array from stdout (e.g. "$.results"). If omitted, stdout must be a JSON array. */
  extract?: string;
  /** Column mappings: { "Header": "$.field" } — JSONPath per element */
  columns: Record<string, string>;
  dedup?: string;
  updateExisting?: boolean;
  schedule?: string;
  timeout?: number;
  onError?: OnErrorConfig;
}

/** Webhook source: accept inbound POST payloads and create rows */
export interface WebhookSource {
  id: string;
  type: "webhook";
  /** Column mappings: { "Header": "$.payload.field" } — JSONPath per payload */
  columns: Record<string, string>;
  dedup?: string;
  updateExisting?: boolean;
}

/** Script source: runs a named script and creates rows from JSON output */
export interface ScriptSource {
  id: string;
  type: "script";
  /** Name of a script defined in the scripts section */
  script: string;
  /** Arguments passed to the script. Supports {{env.X}} templates. */
  args?: string[];
  /** JSONPath to extract the array from the script output */
  extract?: string;
  /** Column mappings: { "Header": "$.field" } — JSONPath per element */
  columns: Record<string, string>;
  dedup?: string;
  updateExisting?: boolean;
  schedule?: string;
  timeout?: number;
  onError?: OnErrorConfig;
}

/** Union of all source types */
export type Source = HttpSource | ExecSource | WebhookSource | ScriptSource;

/** Result of executing a source */
export interface SourceResult {
  sourceId: string;
  rowsCreated: number;
  rowsUpdated: number;
  rowsSkipped: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Actions — enrich existing rows
// ---------------------------------------------------------------------------

/** Script action: runs a named script from the scripts section */
export interface ScriptAction {
  id: string;
  type: "script";
  target: string;
  when?: string;
  /** Name of a script defined in the scripts section */
  script: string;
  /** Arguments passed to the script. Supports {{row.x}} and {{env.X}} templates. */
  args?: string[];
  /** Optional JSONPath to extract a value from the script's JSON output */
  extract?: string;
  timeout?: number;
  onError?: OnErrorConfig;
  runSettings?: ActionRunSettings;
}

/** Output field definition for AI actions */
export interface AiOutputField {
  type: "text" | "number" | "boolean";
}

/** AI action: runs headless claude -p or codex exec per row */
export interface AiAction {
  id: string;
  type: "ai";
  /** Primary target column (for single-output mode) */
  target: string;
  when?: string;
  /** AI runtime: "claude" uses `claude -p`, "codex" uses `codex exec` */
  runtime: "claude" | "codex";
  /** Model to use (e.g. "claude-haiku-4-5-20251001"). Omit for default. */
  model?: string;
  /** Max agent tool-use turns (default: 25) */
  maxTurns?: number;
  /** Enable tools (web search, file read, etc.). Default: true */
  tools?: boolean;
  /** Prompt template. Supports {{row.x}} and {{env.X}} references. */
  prompt: string;
  /** Named output fields, each maps to a target column.
   *  When specified, the AI is instructed to return JSON with these keys. */
  outputs?: Record<string, AiOutputField>;
  /** Output format: "fields" for named fields, "json" for raw JSON schema */
  outputFormat?: "fields" | "json";
  /** JSON Schema string (used when outputFormat is "json") */
  outputSchema?: string;
  /** Timeout in ms (default: 120000 = 2 minutes) */
  timeout?: number;
  onError?: OnErrorConfig;
  runSettings?: ActionRunSettings;
}

/** Common optional fields shared across all action types */
export interface ActionCommon {
  /** Per-action environment variable overrides. Merged into the execution
   *  context env for this action only. Useful for API keys, browser config
   *  (e.g. PLAYWRIGHT_HEADLESS=true), feature flags, etc. */
  env?: Record<string, string>;
}

/** Union of all action types, with common optional fields */
export type Action = (
  | HttpAction
  | WaterfallAction
  | TransformAction
  | ExecAction
  | LookupAction
  | WriteAction
  | ScriptAction
  | AiAction
) &
  ActionCommon;

/** Per-action rate limit override */
export interface ActionRateLimit {
  /** Max requests in the window */
  requests: number;
  /** Window duration in milliseconds */
  durationMs: number;
}

/** Per-action retry override */
export interface ActionRetry {
  maxRetries: number;
  /** HTTP status codes or exit codes to retry on */
  statusCodes?: number[];
  retryBackoff?: string;
}

/** Per-action run settings (optional on any action) */
export interface ActionRunSettings {
  /** Per-action rate limit (overrides global).
   *  TODO: not yet consumed by engine — types exist for MCP schema and future use. */
  rateLimit?: ActionRateLimit;
  /** Per-action retry (overrides global).
   *  TODO: not yet consumed by engine — types exist for MCP schema and future use. */
  retry?: ActionRetry;
  /** Delay in seconds before running (max 600) */
  delay?: number;
  /** Auto-update: re-run when dependency columns change */
  autoUpdate?: boolean;
}

/** Global pipeline execution settings */
export interface PipelineSettings {
  concurrency: number;
  rateLimit: number;
  retryAttempts: number;
  retryBackoff: string;
}

/** Per-tab configuration (v2 multi-tab format) */
export interface TabConfig {
  name: string;
  enabled?: boolean; // default true — set to false to stop all processing
  columns: Record<string, string>; // { rangeId: headerName }
  scripts?: Record<string, ScriptDef>; // tab-level scripts (override global)
  sources?: Source[];
  actions: Action[];
  settings?: PipelineSettings; // per-tab settings override
}

/** Top-level pipeline configuration */
export interface PipelineConfig {
  version: string;
  tabs?: Record<string, TabConfig>; // v2: { GID: TabConfig }
  // Legacy v1 fields (kept for migration)
  columns?: Record<string, string>;
  scripts?: Record<string, ScriptDef>; // global scripts
  sources?: Source[];
  actions: Action[];
  settings: PipelineSettings;
}

/** Adapter interface for reading/writing data (Google Sheets, future: Postgres, etc.) */
export interface Adapter {
  readRows(ref: SheetRef): Promise<Row[]>;
  writeCell(ref: SheetRef, update: CellUpdate): Promise<void>;
  writeBatch(ref: SheetRef, updates: CellUpdate[]): Promise<void>;
  readConfig(ref: SheetRef): Promise<PipelineConfig | null>;
  writeConfig(ref: SheetRef, config: PipelineConfig): Promise<void>;
  getHeaders(ref: SheetRef): Promise<string[]>;
}
