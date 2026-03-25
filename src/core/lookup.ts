import type { OnMissingCallback } from "./template.js";
import { resolveTemplate } from "./template.js";
import type {
  Adapter,
  ExecutionContext,
  LookupAction,
  Row,
  SheetRef,
} from "./types.js";

export interface LookupOptions {
  adapter: Adapter;
  spreadsheetId: string;
  /** Shared cache of tab data, keyed by tab name. Populated lazily on first access. */
  tabDataCache: Map<string, Row[]>;
  onMissing?: OnMissingCallback;
}

/**
 * Execute a lookup action: read rows from a source tab, match on a column,
 * and return the value of a specified return column.
 *
 * In "first" mode (default), returns the first matched value as a string.
 * In "all" mode, returns all matched values as a JSON array string.
 */
export async function executeLookup(
  action: LookupAction,
  context: ExecutionContext,
  options: LookupOptions,
): Promise<string | null> {
  const { adapter, spreadsheetId, tabDataCache, onMissing } = options;

  // Resolve the match value — if it's a plain column name (no {{ templates),
  // read the value from the current row directly
  let resolvedMatchValue: string;
  if (action.matchValue.includes("{{")) {
    resolvedMatchValue = resolveTemplate(action.matchValue, context, onMissing);
  } else {
    resolvedMatchValue = context.row[action.matchValue] ?? "";
  }
  if (!resolvedMatchValue) return null;

  // Get source tab data (cached across rows within a pipeline run)
  const sourceTab = action.sourceTab;
  if (!tabDataCache.has(sourceTab)) {
    const sourceRef: SheetRef = { spreadsheetId, sheetName: sourceTab };
    const sourceRows = await adapter.readRows(sourceRef);
    tabDataCache.set(sourceTab, sourceRows);
  }
  const sourceRows = tabDataCache.get(sourceTab)!;

  // Find matching rows
  const operator = action.matchOperator ?? "equals";
  const mode = action.matchMode ?? "first";
  const matches: Row[] = [];

  for (const sourceRow of sourceRows) {
    const cellValue = sourceRow[action.matchColumn] ?? "";
    let isMatch = false;
    if (operator === "equals") {
      isMatch = cellValue === resolvedMatchValue;
    } else {
      isMatch = cellValue.includes(resolvedMatchValue);
    }
    if (isMatch) {
      matches.push(sourceRow);
      if (mode === "first") break;
    }
  }

  const returnType = action.returnType ?? "value";

  // Boolean: true/false based on whether any match was found
  if (returnType === "boolean") {
    return matches.length > 0 ? "true" : "false";
  }

  // Count: number of matching rows
  if (returnType === "count") {
    return String(matches.length);
  }

  // Rows: full matching row objects as JSON array
  if (returnType === "rows") {
    return matches.length > 0 ? JSON.stringify(matches) : null;
  }

  // Value mode (default): return the returnColumn value
  if (matches.length === 0) return null;

  const returnCol = action.returnColumn ?? action.matchColumn;
  if (mode === "first") {
    const val = matches[0]![returnCol];
    return val !== undefined && val !== "" ? val : null;
  }

  // "all" mode: return JSON array of the return column values
  const values = matches.map((r) => r[returnCol] ?? "").filter((v) => v !== "");
  return values.length > 0 ? JSON.stringify(values) : null;
}
