import type { Adapter, CellUpdate, ExecutionContext, PipelineConfig, Row, SheetRef } from "./types.js";
export interface RunPipelineOptions {
    adapter: Adapter;
    ref: SheetRef;
    config: PipelineConfig;
    env: Record<string, string>;
    range?: string;
    /** Specific row indices (0-based data indices) to process. Overrides range. */
    rowSet?: Set<number>;
    actionFilter?: string;
    dryRun?: boolean;
    signal?: AbortSignal;
    /** Column map: columnId -> current header name. Used to build ID-keyed rows. */
    columnMap?: Record<string, string>;
    onTotalRows?: (total: number) => void;
    onRowStart?: (rowIndex: number, row: Row) => void;
    onRowComplete?: (rowIndex: number, updates: CellUpdate[]) => void;
    onActionComplete?: (rowIndex: number, actionId: string, value: string | null) => void;
    onError?: (rowIndex: number, actionId: string, error: Error) => void;
    /** Called before each row to check if the tab is still enabled.
     *  If it returns false, remaining rows are skipped. */
    checkEnabled?: () => Promise<boolean>;
}
export interface RunResult {
    totalRows: number;
    processedRows: number;
    skippedRows: number;
    errors: Array<{
        rowIndex: number;
        actionId: string;
        error: string;
    }>;
    updates: number;
}
/**
 * Evaluate a JavaScript expression in a sandboxed context, returning the result as a string.
 *
 * WARNING: Node.js vm module is NOT a security boundary. The pre-check
 * and Object.create(null) sandbox are defense-in-depth measures only.
 * Do not rely on this for untrusted code execution.
 *
 * Unlike evaluateCondition (which coerces to boolean), this returns the raw value
 * stringified — used for transform action expressions.
 */
export declare function evaluateExpression(expression: string, context: ExecutionContext): string;
/**
 * Run the full pipeline: read rows, process each through actions, write results back.
 *
 * Execution flow per row:
 * 1. Read row data (header -> value map)
 * 2. For each action: evaluate condition, execute, update in-memory row state
 * 3. Batch-write all cell updates for the row
 * 4. Fire progress callbacks
 */
export declare function runPipeline(options: RunPipelineOptions): Promise<RunResult>;
