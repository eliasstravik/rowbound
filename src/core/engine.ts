import vm from "node:vm";
import { sortActionsByDependency } from "./action-deps.js";
import { executeAiAction } from "./ai.js";
import { evaluateCondition, preCheckExpression } from "./condition.js";
import { executeExecAction } from "./exec.js";
import { extractValue } from "./extractor.js";
import { httpRequest } from "./http-client.js";
import { executeLookup } from "./lookup.js";
import { RateLimiter } from "./rate-limiter.js";
import { executeScriptAction, resolveScript } from "./script.js";
import {
  type OnMissingCallback,
  resolveObject,
  resolveTemplate,
} from "./template.js";
import type {
  Action,
  Adapter,
  AiAction,
  CellUpdate,
  ExecAction,
  ExecutionContext,
  HttpAction,
  LookupAction,
  PipelineConfig,
  Row,
  ScriptAction,
  SheetRef,
  WriteAction,
} from "./types.js";
import { executeWaterfall } from "./waterfall.js";
import { executeWrite } from "./write-action.js";

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
  onActionComplete?: (
    rowIndex: number,
    actionId: string,
    value: string | null,
  ) => void;
  onError?: (rowIndex: number, actionId: string, error: Error) => void;
  /** Called before each row to check if the tab is still enabled.
   *  If it returns false, remaining rows are skipped. */
  checkEnabled?: () => Promise<boolean>;
}

export interface RunResult {
  totalRows: number;
  processedRows: number;
  skippedRows: number;
  errors: Array<{ rowIndex: number; actionId: string; error: string }>;
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
export function evaluateExpression(
  expression: string,
  context: ExecutionContext,
): string {
  preCheckExpression(expression);

  const rawSandbox = Object.create(null) as Record<string, unknown>;
  rawSandbox.row = { ...context.row };
  rawSandbox.env = context.env;
  rawSandbox.results = context.results ?? {};
  const sandbox = vm.createContext(rawSandbox);

  const result = vm.runInContext(expression, sandbox, { timeout: 100 });

  if (result === undefined || result === null) {
    return "";
  }

  if (typeof result === "object") {
    return JSON.stringify(result);
  }

  return String(result);
}

/**
 * Parse a range string like "2:50" into start/end indices (0-based data row indices).
 * Range uses sheet row numbers (1-indexed, row 1 = headers, row 2 = first data row).
 * So range "2:50" means data rows 0..48.
 */
function parseRange(
  range: string | undefined,
  totalRows: number,
): { start: number; end: number } {
  if (!range) {
    return { start: 0, end: totalRows };
  }

  const parts = range.split(":");
  if (parts.length !== 2) {
    throw new Error(
      `Invalid range "${range}": expected format "start:end" (e.g. "2:50")`,
    );
  }

  const sheetStart = parseInt(parts[0]!, 10);
  const sheetEnd = parseInt(parts[1]!, 10);

  if (Number.isNaN(sheetStart) || Number.isNaN(sheetEnd)) {
    throw new Error(`Invalid range "${range}": start and end must be numbers`);
  }

  if (sheetStart < 1) {
    throw new Error(
      `Invalid range "${range}": start must be >= 1 (got ${sheetStart})`,
    );
  }

  if (sheetStart > sheetEnd) {
    throw new Error(
      `Invalid range "${range}": start (${sheetStart}) must be <= end (${sheetEnd})`,
    );
  }

  // Sheet row 2 = data row 0, sheet row 3 = data row 1, etc.
  const start = Math.max(0, sheetStart - 2);
  const end = Math.min(totalRows, sheetEnd - 1);

  return { start, end };
}

/**
 * Execute an HTTP action: resolve templates, make request, extract value.
 */
async function executeHttpAction(
  action: HttpAction,
  context: ExecutionContext,
  rateLimiter: RateLimiter | undefined,
  retryAttempts: number,
  signal: AbortSignal | undefined,
  retryBackoff?: string,
  onMissing?: OnMissingCallback,
): Promise<string | null> {
  const resolvedUrl = resolveTemplate(action.url, context, onMissing);
  const resolvedHeaders = action.headers
    ? (resolveObject(action.headers, context, onMissing) as Record<
        string,
        string
      >)
    : undefined;
  const resolvedBody =
    action.body !== undefined
      ? resolveObject(action.body, context, onMissing)
      : undefined;

  const response = await httpRequest({
    method: action.method,
    url: resolvedUrl,
    headers: resolvedHeaders,
    body: resolvedBody,
    retryAttempts,
    retryBackoff,
    onError: action.onError,
    rateLimiter,
    signal,
  });

  if (response === null) {
    return null;
  }

  const value = extractValue(response.data, action.extract);
  return value !== "" ? value : null;
}

/**
 * Run the full pipeline: read rows, process each through actions, write results back.
 *
 * Execution flow per row:
 * 1. Read row data (header -> value map)
 * 2. For each action: evaluate condition, execute, update in-memory row state
 * 3. Batch-write all cell updates for the row
 * 4. Fire progress callbacks
 */
export async function runPipeline(
  options: RunPipelineOptions,
): Promise<RunResult> {
  const {
    adapter,
    ref,
    config,
    env,
    range,
    actionFilter,
    dryRun = false,
    signal,
  } = options;

  // Read all rows from the sheet
  const rows = await adapter.readRows(ref);

  // Create rate limiter if configured (rateLimit = seconds between requests)
  const rateLimiter =
    config.settings.rateLimit > 0
      ? new RateLimiter(config.settings.rateLimit * 1000)
      : undefined;

  const retryAttempts = config.settings.retryAttempts ?? 0;
  const retryBackoff = config.settings.retryBackoff;

  // Deduplicate missing-variable warnings (warn once per unique source.key)
  const warnedMissing = new Set<string>();
  const onMissing: OnMissingCallback = (source, key) => {
    const tag = `${source}.${key}`;
    if (!warnedMissing.has(tag)) {
      warnedMissing.add(tag);
      console.warn(
        `Warning: template variable {{${tag}}} resolved to empty string (not found in context)`,
      );
    }
  };

  // Determine which actions to run, sorted by dependency order
  const filteredActions: Action[] = actionFilter
    ? config.actions.filter((s) => s.id === actionFilter)
    : config.actions;
  const actions = sortActionsByDependency(filteredActions);

  // Determine which data row indices to process
  const rowIndices: number[] = [];
  if (options.rowSet && options.rowSet.size > 0) {
    // Specific rows requested — sort them for sequential processing
    for (const idx of options.rowSet) {
      if (idx >= 0 && idx < rows.length) {
        rowIndices.push(idx);
      }
    }
    rowIndices.sort((a, b) => a - b);
  } else {
    // Contiguous range
    const { start, end } = parseRange(range, rows.length);
    for (let i = start; i < end; i++) {
      rowIndices.push(i);
    }
  }

  // Notify caller of total rows to process (for progress display)
  options.onTotalRows?.(rowIndices.length);

  const result: RunResult = {
    totalRows: rows.length,
    processedRows: 0,
    skippedRows: 0,
    errors: [],
    updates: 0,
  };

  // Cache for cross-tab reads (lookup actions). Pre-seeded with current tab data
  // so same-tab lookups are free.
  const tabDataCache = new Map<string, Row[]>();
  tabDataCache.set(ref.sheetName || "Sheet1", rows);

  // Warn if concurrency > 1 since it's not yet implemented
  if (config.settings.concurrency > 1) {
    console.warn(
      `Warning: concurrency is set to ${config.settings.concurrency} but parallel row processing is not yet implemented. All rows will be processed sequentially (concurrency=1).`,
    );
  }

  for (const i of rowIndices) {
    // Check if tab is still enabled (supports mid-run stop via config change)
    if (options.checkEnabled) {
      const enabled = await options.checkEnabled();
      if (!enabled) {
        break;
      }
    }

    // Check abort signal between rows
    if (signal?.aborted) {
      break;
    }

    // Build ID-keyed row from name-keyed sheet data
    const nameKeyedRow = rows[i]!;
    const row: Row = {};
    if (options.columnMap) {
      for (const [id, name] of Object.entries(options.columnMap)) {
        if (nameKeyedRow[name] !== undefined) {
          row[id] = nameKeyedRow[name];
          row[name] = nameKeyedRow[name];
        }
      }
    } else {
      // No column map — use name-keyed row directly (legacy/testing)
      Object.assign(row, nameKeyedRow);
    }

    const rowUpdates: CellUpdate[] = [];

    options.onRowStart?.(i, row);

    const context: ExecutionContext = { row, env };

    for (const action of actions) {
      // Check abort between actions (not just between rows)
      if (signal?.aborted) break;

      try {
        // Skip if target cell already has a value
        if (row[action.target] !== undefined && row[action.target] !== "") {
          options.onActionComplete?.(i, action.id, "__SKIPPED__");
          continue;
        }

        // Evaluate `when` condition
        if (!evaluateCondition(action.when, context)) {
          options.onActionComplete?.(i, action.id, "__SKIPPED__");
          continue;
        }

        // Merge per-action env overrides into context for this action
        const actionContext = action.env
          ? { ...context, env: { ...context.env, ...action.env } }
          : context;

        // Apply per-action delay if configured (clamped to 600s max)
        const rawDelay = (action as { runSettings?: { delay?: number } })
          .runSettings?.delay;
        const actionDelay =
          rawDelay && rawDelay > 0 ? Math.min(rawDelay, 600) : 0;
        if (actionDelay > 0) {
          await new Promise((r) => setTimeout(r, actionDelay * 1000));
        }

        let value: string | null = null;

        if (action.type === "transform") {
          value = evaluateExpression(action.expression, actionContext);
        } else if (action.type === "http") {
          value = await executeHttpAction(
            action,
            actionContext,
            rateLimiter,
            retryAttempts,
            signal,
            retryBackoff,
            onMissing,
          );
        } else if (action.type === "waterfall") {
          const waterfallResult = await executeWaterfall(
            action,
            actionContext,
            {
              rateLimiter,
              retryAttempts,
              retryBackoff,
              signal,
              onMissing,
            },
          );
          value = waterfallResult?.value ?? null;
        } else if (action.type === "exec") {
          value = await executeExecAction(action as ExecAction, actionContext, {
            signal,
          });
        } else if (action.type === "lookup") {
          value = await executeLookup(action as LookupAction, actionContext, {
            adapter,
            spreadsheetId: ref.spreadsheetId,
            tabDataCache,
            onMissing,
          });
        } else if (action.type === "write") {
          value = await executeWrite(action as WriteAction, actionContext, {
            adapter,
            spreadsheetId: ref.spreadsheetId,
            dryRun,
            onMissing,
          });
        } else if (action.type === "script") {
          const sa = action as ScriptAction;
          const scriptDef = resolveScript(sa.script, config, null);
          if (!scriptDef) {
            throw new Error(`Script "${sa.script}" not found`);
          }
          const resolvedArgs = (sa.args ?? []).map((a) =>
            resolveTemplate(a, actionContext, onMissing),
          );
          const actionEnv = action.env ? { ...env, ...action.env } : env;
          value = await executeScriptAction(scriptDef, resolvedArgs, {
            env: actionEnv,
            timeout: sa.timeout ? sa.timeout * 1000 : undefined,
            signal,
            extract: sa.extract,
            onError: sa.onError,
          });
        } else if (action.type === "ai") {
          const aiUpdates = await executeAiAction(
            action as AiAction,
            actionContext,
            {
              signal,
              rowIndex: i,
              columnMap: options.columnMap,
            },
          );
          value = aiUpdates.length > 0 ? aiUpdates[0]!.value : null;
        }

        if (value !== null) {
          // Update in-memory row so subsequent actions see new values.
          // Set both the ID key and the header-name alias so later actions
          // see the updated value regardless of which key they reference.
          row[action.target] = value;
          const columnName =
            options.columnMap?.[action.target] ?? action.target;
          if (columnName !== action.target) {
            row[columnName] = value;
          }

          // Sheet row = data index + 2 (row 1 is headers)
          rowUpdates.push({
            row: i + 2,
            column: columnName,
            value,
          });
        }

        options.onActionComplete?.(i, action.id, value);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        result.errors.push({
          rowIndex: i,
          actionId: action.id,
          error: err.message,
        });
        options.onError?.(i, action.id, err);
        options.onActionComplete?.(i, action.id, null);
      }
    }

    // Write batch for this row
    if (rowUpdates.length > 0 && !dryRun) {
      await adapter.writeBatch(ref, rowUpdates);
    }

    result.updates += rowUpdates.length;
    result.processedRows++;

    options.onRowComplete?.(i, rowUpdates);
  }

  // Count skipped rows (rows outside the range)
  result.skippedRows = rows.length - result.processedRows;

  return result;
}
