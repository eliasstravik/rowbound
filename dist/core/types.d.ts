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
export type OnErrorConfig = Record<string, string | {
    write: string;
}>;
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
    /** Value template to match (e.g. "{{row.email}}") */
    matchValue: string;
    /** Operator for matching (default: "equals") */
    matchOperator?: "equals" | "contains";
    /** Column header in the source tab to return */
    returnColumn: string;
    /** "first" returns first match; "all" returns all matches as JSON array (default: "first") */
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
/** Union of all action types */
export type Action = HttpAction | WaterfallAction | TransformAction | ExecAction | LookupAction | WriteAction;
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
    enabled?: boolean;
    columns: Record<string, string>;
    actions: Action[];
    settings?: PipelineSettings;
}
/** Top-level pipeline configuration */
export interface PipelineConfig {
    version: string;
    tabs?: Record<string, TabConfig>;
    columns?: Record<string, string>;
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
