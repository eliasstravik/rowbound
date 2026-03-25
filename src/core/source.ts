import { forceText } from "./cell-utils.js";
import { executeCommand } from "./exec.js";
import { extractValue } from "./extractor.js";
import { httpRequest } from "./http-client.js";
import type { RateLimiter } from "./rate-limiter.js";
import { executeScript as executeScriptFn } from "./script.js";
import { resolveObject, resolveTemplate } from "./template.js";
import type {
  Adapter,
  CellUpdate,
  ExecSource,
  ExecutionContext,
  HttpSource,
  Row,
  ScriptDef,
  ScriptSource,
  SheetRef,
  Source,
  SourceResult,
  WebhookSource,
} from "./types.js";

export interface SourceOptions {
  adapter: Adapter;
  ref: SheetRef;
  env: Record<string, string>;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Resolve a script name to its definition. Required for script sources. */
  resolveScript?: (name: string) => ScriptDef | null;
  rateLimiter?: RateLimiter;
  retryAttempts?: number;
  retryBackoff?: string;
}

/**
 * Extract a value from an item using a JSONPath-like column mapping.
 * Supports:
 * - "$.field" — extract top-level field via JSONPath
 * - "$.nested.field" — extract nested field
 * - literal string (no $. prefix) — use as-is
 */
function extractColumnValue(item: unknown, path: string): string {
  if (!path.startsWith("$.")) {
    return path; // literal value
  }
  return extractValue(item, path);
}

/**
 * Parse raw data from a source (HTTP response or exec output) into an array of items.
 */
function parseSourceData(
  rawData: unknown,
  extract?: string,
  extractPath?: string,
): unknown[] | null {
  let data = rawData;

  // If extract is set and data is a string, parse it
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }

  // Apply extract JSONPath if set (used by http sources)
  if (extract && extract !== "$") {
    const extracted = extractValue(data, extract);
    if (!extracted) return null;
    try {
      data = JSON.parse(extracted);
    } catch {
      // extractValue returns stringified result; if it's not JSON, it's a single value
      return null;
    }
  }

  // Apply extractPath if set (drill into nested object)
  if (extractPath && !Array.isArray(data)) {
    const extracted = extractValue(data, extractPath);
    if (!extracted) return null;
    try {
      data = JSON.parse(extracted);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(data)) return null;
  return data;
}

/**
 * Execute a source and create rows in the target sheet.
 */
export async function executeSource(
  source: Source,
  options: SourceOptions,
): Promise<SourceResult> {
  const { adapter, ref, env, dryRun = false, signal } = options;

  const result: SourceResult = {
    sourceId: source.id,
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    errors: [],
  };

  // Build a minimal ExecutionContext for template resolution (no row data — sources don't have a current row)
  const context: ExecutionContext = { row: {}, env };

  // 1. Fetch data based on source type
  let items: unknown[];

  if (source.type === "http") {
    const httpSource = source as HttpSource;
    const resolvedUrl = resolveTemplate(httpSource.url, context);
    const resolvedHeaders = httpSource.headers
      ? (resolveObject(httpSource.headers, context) as Record<string, string>)
      : undefined;
    const resolvedBody =
      httpSource.body !== undefined
        ? resolveObject(httpSource.body, context)
        : undefined;

    const response = await httpRequest({
      method: httpSource.method,
      url: resolvedUrl,
      headers: resolvedHeaders,
      body: resolvedBody,
      retryAttempts: options.retryAttempts ?? 0,
      retryBackoff: options.retryBackoff,
      onError: httpSource.onError,
      rateLimiter: options.rateLimiter,
      signal,
    });

    if (response === null) {
      result.errors.push("HTTP request returned null (skipped by onError)");
      return result;
    }

    const parsed = parseSourceData(
      response.data,
      httpSource.extract,
      httpSource.extractPath,
    );
    if (parsed === null) {
      result.errors.push("Failed to extract array from HTTP response");
      return result;
    }
    items = parsed;
  } else if (source.type === "exec") {
    const execSource = source as ExecSource;
    const resolvedCommand = resolveTemplate(execSource.command, context);

    const execResult = await executeCommand(resolvedCommand, {
      timeout: (execSource.timeout ?? 30) * 1000,
      signal,
      env: { ...process.env, ...env } as Record<string, string>,
    });

    if (execResult.exitCode !== 0) {
      result.errors.push(
        `Command exited with code ${execResult.exitCode}: ${execResult.stderr}`,
      );
      return result;
    }

    const parsed = parseSourceData(execResult.stdout, execSource.extract);
    if (parsed === null) {
      result.errors.push("Failed to parse command output as JSON array");
      return result;
    }
    items = parsed;
  } else if (source.type === "script") {
    const scriptSource = source as ScriptSource;
    if (!options.resolveScript) {
      result.errors.push("Script resolution not available");
      return result;
    }
    const scriptDef = options.resolveScript(scriptSource.script);
    if (!scriptDef) {
      result.errors.push(`Script "${scriptSource.script}" not found`);
      return result;
    }
    const resolvedArgs = (scriptSource.args ?? []).map((a) =>
      resolveTemplate(a, context),
    );
    const scriptResult = await executeScriptFn(scriptDef, resolvedArgs, {
      env: { ...process.env, ...env } as Record<string, string>,
      timeout: (scriptSource.timeout ?? 30) * 1000,
      signal,
    });
    if (scriptResult.exitCode !== 0) {
      result.errors.push(
        `Script exited with code ${scriptResult.exitCode}: ${scriptResult.stderr}`,
      );
      return result;
    }
    const parsed = parseSourceData(scriptResult.stdout, scriptSource.extract);
    if (parsed === null) {
      result.errors.push("Failed to parse script output as JSON array");
      return result;
    }
    items = parsed;
  } else if (source.type === "webhook") {
    // Webhook sources are handled differently — data comes from the request payload,
    // not from executing the source. This function should be called with items pre-parsed.
    result.errors.push(
      "Webhook sources must be executed via executeWebhookSource()",
    );
    return result;
  } else {
    result.errors.push(`Unknown source type: ${(source as Source).type}`);
    return result;
  }

  if (items.length === 0) return result;

  // 2. Read target sheet headers and existing rows
  let headers: string[];
  let existingRows: Row[];
  try {
    headers = await adapter.getHeaders(ref);
    existingRows = await adapter.readRows(ref);
  } catch (err) {
    result.errors.push(
      `Failed to read sheet: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  // 3. Build dedup index if needed
  const dedupIndex = new Map<string, number>(); // value → row index (0-based data)
  if (source.dedup) {
    for (let i = 0; i < existingRows.length; i++) {
      const val = existingRows[i]![source.dedup];
      if (val) {
        dedupIndex.set(val, i);
      }
    }
  }

  // 4. Map items to rows and write
  const updates: CellUpdate[] = [];
  let nextRow = existingRows.length + 2; // row 1 = headers, data starts at row 2

  for (const item of items) {
    // Map columns using JSONPath extraction per column config
    const mappedRow: Record<string, string> = {};
    for (const [header, path] of Object.entries(source.columns)) {
      const val = extractColumnValue(item, path);
      mappedRow[header] = val;
    }

    // Check dedup
    if (source.dedup) {
      const dedupVal = mappedRow[source.dedup] ?? "";
      const existingIdx = dedupIndex.get(dedupVal);

      if (existingIdx !== undefined) {
        if (source.updateExisting) {
          // Update existing row
          const sheetRow = existingIdx + 2;
          for (const [col, val] of Object.entries(mappedRow)) {
            if (val !== "" && headers.includes(col)) {
              updates.push({
                row: sheetRow,
                column: col,
                value: forceText(val),
              });
            }
          }
          result.rowsUpdated++;
        } else {
          result.rowsSkipped++;
        }
        continue;
      }
    }

    // Append new row
    for (const [col, val] of Object.entries(mappedRow)) {
      if (val !== "" && headers.includes(col)) {
        updates.push({ row: nextRow, column: col, value: forceText(val) });
      }
    }

    // Track for dedup within the same batch
    if (source.dedup) {
      const dedupVal = mappedRow[source.dedup] ?? "";
      if (dedupVal) {
        dedupIndex.set(dedupVal, nextRow - 2);
      }
    }

    nextRow++;
    result.rowsCreated++;
  }

  // 5. Write batch
  if (updates.length > 0 && !dryRun) {
    await adapter.writeBatch(ref, updates);
  }

  return result;
}

/**
 * Execute a webhook source with pre-parsed payload data.
 * Called from the watch webhook handler when a POST is received.
 */
export async function executeWebhookSource(
  source: WebhookSource,
  payload: unknown,
  options: SourceOptions,
): Promise<SourceResult> {
  const { adapter, ref, dryRun = false } = options;

  const result: SourceResult = {
    sourceId: source.id,
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    errors: [],
  };

  // Parse payload — could be a single object (one row) or an array (multiple rows)
  const items: unknown[] = Array.isArray(payload) ? payload : [payload];

  if (items.length === 0) return result;

  let headers: string[];
  let existingRows: Row[];
  try {
    headers = await adapter.getHeaders(ref);
    existingRows = await adapter.readRows(ref);
  } catch (err) {
    result.errors.push(
      `Failed to read sheet: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const dedupIndex = new Map<string, number>();
  if (source.dedup) {
    for (let i = 0; i < existingRows.length; i++) {
      const val = existingRows[i]![source.dedup];
      if (val) {
        dedupIndex.set(val, i);
      }
    }
  }

  const updates: CellUpdate[] = [];
  let nextRow = existingRows.length + 2;

  for (const item of items) {
    const mappedRow: Record<string, string> = {};
    for (const [header, path] of Object.entries(source.columns)) {
      mappedRow[header] = extractColumnValue(item, path);
    }

    if (source.dedup) {
      const dedupVal = mappedRow[source.dedup] ?? "";
      const existingIdx = dedupIndex.get(dedupVal);

      if (existingIdx !== undefined) {
        if (source.updateExisting) {
          const sheetRow = existingIdx + 2;
          for (const [col, val] of Object.entries(mappedRow)) {
            if (val !== "" && headers.includes(col)) {
              updates.push({
                row: sheetRow,
                column: col,
                value: forceText(val),
              });
            }
          }
          result.rowsUpdated++;
        } else {
          result.rowsSkipped++;
        }
        continue;
      }
    }

    for (const [col, val] of Object.entries(mappedRow)) {
      if (val !== "" && headers.includes(col)) {
        updates.push({ row: nextRow, column: col, value: forceText(val) });
      }
    }

    if (source.dedup) {
      const dedupVal = mappedRow[source.dedup] ?? "";
      if (dedupVal) {
        dedupIndex.set(dedupVal, nextRow - 2);
      }
    }

    nextRow++;
    result.rowsCreated++;
  }

  if (updates.length > 0 && !dryRun) {
    await adapter.writeBatch(ref, updates);
  }

  return result;
}
