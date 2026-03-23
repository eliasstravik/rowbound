import vm from "node:vm";
import { evaluateCondition, preCheckExpression } from "./condition.js";
import { executeExecAction } from "./exec.js";
import { extractValue } from "./extractor.js";
import { httpRequest } from "./http-client.js";
import { executeLookup } from "./lookup.js";
import { RateLimiter } from "./rate-limiter.js";
import { executeScriptAction, resolveScript } from "./script.js";
import { resolveObject, resolveTemplate, } from "./template.js";
import { executeWaterfall } from "./waterfall.js";
import { executeWrite } from "./write-action.js";
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
export function evaluateExpression(expression, context) {
    preCheckExpression(expression);
    const rawSandbox = Object.create(null);
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
function parseRange(range, totalRows) {
    if (!range) {
        return { start: 0, end: totalRows };
    }
    const parts = range.split(":");
    if (parts.length !== 2) {
        throw new Error(`Invalid range "${range}": expected format "start:end" (e.g. "2:50")`);
    }
    const sheetStart = parseInt(parts[0], 10);
    const sheetEnd = parseInt(parts[1], 10);
    if (Number.isNaN(sheetStart) || Number.isNaN(sheetEnd)) {
        throw new Error(`Invalid range "${range}": start and end must be numbers`);
    }
    if (sheetStart < 1) {
        throw new Error(`Invalid range "${range}": start must be >= 1 (got ${sheetStart})`);
    }
    if (sheetStart > sheetEnd) {
        throw new Error(`Invalid range "${range}": start (${sheetStart}) must be <= end (${sheetEnd})`);
    }
    // Sheet row 2 = data row 0, sheet row 3 = data row 1, etc.
    const start = Math.max(0, sheetStart - 2);
    const end = Math.min(totalRows, sheetEnd - 1);
    return { start, end };
}
/**
 * Execute an HTTP action: resolve templates, make request, extract value.
 */
async function executeHttpAction(action, context, rateLimiter, retryAttempts, signal, retryBackoff, onMissing) {
    const resolvedUrl = resolveTemplate(action.url, context, onMissing);
    const resolvedHeaders = action.headers
        ? resolveObject(action.headers, context, onMissing)
        : undefined;
    const resolvedBody = action.body !== undefined
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
export async function runPipeline(options) {
    const { adapter, ref, config, env, range, actionFilter, dryRun = false, signal, } = options;
    // Read all rows from the sheet
    const rows = await adapter.readRows(ref);
    // Create rate limiter if configured (rateLimit = seconds between requests)
    const rateLimiter = config.settings.rateLimit > 0
        ? new RateLimiter(config.settings.rateLimit * 1000)
        : undefined;
    const retryAttempts = config.settings.retryAttempts ?? 0;
    const retryBackoff = config.settings.retryBackoff;
    // Deduplicate missing-variable warnings (warn once per unique source.key)
    const warnedMissing = new Set();
    const onMissing = (source, key) => {
        const tag = `${source}.${key}`;
        if (!warnedMissing.has(tag)) {
            warnedMissing.add(tag);
            console.warn(`Warning: template variable {{${tag}}} resolved to empty string (not found in context)`);
        }
    };
    // Determine which actions to run
    const actions = actionFilter
        ? config.actions.filter((s) => s.id === actionFilter)
        : config.actions;
    // Determine which data row indices to process
    const rowIndices = [];
    if (options.rowSet && options.rowSet.size > 0) {
        // Specific rows requested — sort them for sequential processing
        for (const idx of options.rowSet) {
            if (idx >= 0 && idx < rows.length) {
                rowIndices.push(idx);
            }
        }
        rowIndices.sort((a, b) => a - b);
    }
    else {
        // Contiguous range
        const { start, end } = parseRange(range, rows.length);
        for (let i = start; i < end; i++) {
            rowIndices.push(i);
        }
    }
    // Notify caller of total rows to process (for progress display)
    options.onTotalRows?.(rowIndices.length);
    const result = {
        totalRows: rows.length,
        processedRows: 0,
        skippedRows: 0,
        errors: [],
        updates: 0,
    };
    // Cache for cross-tab reads (lookup actions). Pre-seeded with current tab data
    // so same-tab lookups are free.
    const tabDataCache = new Map();
    tabDataCache.set(ref.sheetName || "Sheet1", rows);
    // Warn if concurrency > 1 since it's not yet implemented
    if (config.settings.concurrency > 1) {
        console.warn(`Warning: concurrency is set to ${config.settings.concurrency} but parallel row processing is not yet implemented. All rows will be processed sequentially (concurrency=1).`);
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
        const nameKeyedRow = rows[i];
        const row = {};
        if (options.columnMap) {
            for (const [id, name] of Object.entries(options.columnMap)) {
                if (nameKeyedRow[name] !== undefined) {
                    row[id] = nameKeyedRow[name];
                    row[name] = nameKeyedRow[name];
                }
            }
        }
        else {
            // No column map — use name-keyed row directly (legacy/testing)
            Object.assign(row, nameKeyedRow);
        }
        const rowUpdates = [];
        options.onRowStart?.(i, row);
        const context = { row, env };
        for (const action of actions) {
            // Check abort between actions (not just between rows)
            if (signal?.aborted)
                break;
            try {
                // Skip if target cell already has a value
                if (row[action.target] !== undefined && row[action.target] !== "") {
                    options.onActionComplete?.(i, action.id, null);
                    continue;
                }
                // Evaluate `when` condition
                if (!evaluateCondition(action.when, context)) {
                    options.onActionComplete?.(i, action.id, null);
                    continue;
                }
                let value = null;
                if (action.type === "transform") {
                    value = evaluateExpression(action.expression, context);
                }
                else if (action.type === "http") {
                    value = await executeHttpAction(action, context, rateLimiter, retryAttempts, signal, retryBackoff, onMissing);
                }
                else if (action.type === "waterfall") {
                    const waterfallResult = await executeWaterfall(action, context, {
                        rateLimiter,
                        retryAttempts,
                        retryBackoff,
                        signal,
                        onMissing,
                    });
                    value = waterfallResult?.value ?? null;
                }
                else if (action.type === "exec") {
                    value = await executeExecAction(action, context, {
                        signal,
                    });
                }
                else if (action.type === "lookup") {
                    value = await executeLookup(action, context, {
                        adapter,
                        spreadsheetId: ref.spreadsheetId,
                        tabDataCache,
                        onMissing,
                    });
                }
                else if (action.type === "write") {
                    value = await executeWrite(action, context, {
                        adapter,
                        spreadsheetId: ref.spreadsheetId,
                        dryRun,
                        onMissing,
                    });
                }
                else if (action.type === "script") {
                    const sa = action;
                    const scriptDef = resolveScript(sa.script, config, null);
                    if (!scriptDef) {
                        throw new Error(`Script "${sa.script}" not found`);
                    }
                    const resolvedArgs = (sa.args ?? []).map((a) => resolveTemplate(a, context, onMissing));
                    value = await executeScriptAction(scriptDef, resolvedArgs, {
                        env,
                        timeout: sa.timeout,
                        signal,
                        extract: sa.extract,
                        onError: sa.onError,
                    });
                }
                if (value !== null) {
                    // Update in-memory row so subsequent actions see new values (ID-keyed)
                    row[action.target] = value;
                    // Resolve target ID to column name for sheet write
                    const columnName = options.columnMap?.[action.target] ?? action.target;
                    // Sheet row = data index + 2 (row 1 is headers)
                    rowUpdates.push({
                        row: i + 2,
                        column: columnName,
                        value,
                    });
                }
                options.onActionComplete?.(i, action.id, value);
            }
            catch (error) {
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
