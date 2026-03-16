import { execFile } from "node:child_process";
import { z } from "zod/v4";
// ---------------------------------------------------------------------------
// Zod schemas for gws CLI response shapes
// ---------------------------------------------------------------------------
/** Response from `gws sheets spreadsheets values get` */
const ValuesResponseSchema = z.object({
    values: z.array(z.array(z.string())).optional(),
});
/** Response from `gws sheets spreadsheets developerMetadata search` */
const MetadataSearchResponseSchema = z.object({
    matchedDeveloperMetadata: z
        .array(z.object({
        developerMetadata: z.object({
            metadataId: z.number(),
            metadataKey: z.string(),
            metadataValue: z.string(),
        }),
    }))
        .optional(),
});
/** Response from `gws sheets spreadsheets get` (sheets.properties) */
const SheetsPropertiesResponseSchema = z.object({
    sheets: z
        .array(z.object({
        properties: z.object({
            sheetId: z.number(),
            title: z.string(),
        }),
    }))
        .optional(),
});
/** Response from `gws sheets spreadsheets get` (namedRanges) */
const NamedRangesResponseSchema = z.object({
    namedRanges: z
        .array(z.object({
        name: z.string(),
        namedRangeId: z.string(),
        range: z.object({
            sheetId: z.number().optional(),
            startColumnIndex: z.number(),
            endColumnIndex: z.number(),
        }),
    }))
        .optional(),
});
/**
 * Safely parse gws JSON output with a Zod schema.
 * Wraps parse errors with a descriptive message.
 */
function parseGwsResponse(output, schema, context) {
    let raw;
    try {
        raw = JSON.parse(output);
    }
    catch {
        throw new Error(`gws returned invalid JSON for ${context}`);
    }
    try {
        return schema.parse(raw);
    }
    catch (e) {
        throw new Error(`gws returned unexpected response format for ${context}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
/**
 * Convert a 0-indexed column number to a spreadsheet column letter.
 * 0 = A, 1 = B, ..., 25 = Z, 26 = AA, 27 = AB, ...
 */
export function columnIndexToLetter(index) {
    let result = "";
    let n = index;
    while (true) {
        result = String.fromCharCode((n % 26) + 65) + result;
        n = Math.floor(n / 26) - 1;
        if (n < 0)
            break;
    }
    return result;
}
/**
 * Run the gws CLI with the given arguments.
 * Uses execFile (not exec) to avoid shell injection.
 */
export function runGws(args) {
    return new Promise((resolve, reject) => {
        execFile("gws", args, (error, stdout, stderr) => {
            if (error) {
                if (error.code === "ENOENT") {
                    reject(new Error("'gws' CLI not found. Rowbound requires the Google Workspace CLI (gws) to interact with Google Sheets.\n" +
                        "Install: npm install -g @googleworkspace/cli\n" +
                        "Then run: gws auth setup\n" +
                        "See: https://github.com/googleworkspace/cli"));
                    return;
                }
                reject(new Error(`gws failed: ${stderr || error.message}`));
                return;
            }
            resolve(stdout);
        });
    });
}
/**
 * Google Sheets adapter using the gws CLI tool.
 */
export class SheetsAdapter {
    headerCache = new Map();
    headerCacheTimes = new Map();
    headerPending = new Map();
    HEADER_CACHE_TTL_MS = 60_000; // 1 minute
    escapeSheetName(name) {
        return name.replace(/'/g, "''");
    }
    cacheKey(ref) {
        return `${ref.spreadsheetId}:${ref.sheetName || "Sheet1"}`;
    }
    sheetName(ref) {
        return ref.sheetName || "Sheet1";
    }
    /**
     * Look up a column name in the headers and return its letter (A, B, ..., AA, etc.).
     */
    async columnNameToLetter(ref, columnName) {
        const headers = await this.getHeaders(ref);
        const index = headers.indexOf(columnName);
        if (index === -1) {
            throw new Error(`Column "${columnName}" not found in headers: ${headers.join(", ")}`);
        }
        return columnIndexToLetter(index);
    }
    async readRows(ref, range) {
        const effectiveRange = range || `'${this.escapeSheetName(this.sheetName(ref))}'`;
        const output = await runGws([
            "sheets",
            "spreadsheets",
            "values",
            "get",
            "--params",
            JSON.stringify({
                spreadsheetId: ref.spreadsheetId,
                range: effectiveRange,
            }),
            "--format",
            "json",
        ]);
        const result = parseGwsResponse(output, ValuesResponseSchema, "readRows");
        if (!result.values || result.values.length === 0) {
            return [];
        }
        const [headerRow, ...dataRows] = result.values;
        const headers = headerRow;
        return dataRows.map((row) => {
            const obj = {};
            for (let i = 0; i < headers.length; i++) {
                obj[headers[i]] = i < row.length ? row[i] : "";
            }
            return obj;
        });
    }
    async writeCell(ref, update) {
        await this.writeBatch(ref, [update]);
    }
    async writeBatch(ref, updates) {
        const sheet = this.sheetName(ref);
        const data = await Promise.all(updates.map(async (u) => {
            const colLetter = await this.columnNameToLetter(ref, u.column);
            return {
                range: `'${this.escapeSheetName(sheet)}'!${colLetter}${u.row}`,
                values: [[u.value]],
            };
        }));
        await runGws([
            "sheets",
            "spreadsheets",
            "values",
            "batchUpdate",
            "--params",
            JSON.stringify({ spreadsheetId: ref.spreadsheetId }),
            "--json",
            JSON.stringify({
                valueInputOption: "USER_ENTERED",
                data,
            }),
        ]);
    }
    async readConfig(ref) {
        let output;
        try {
            output = await runGws([
                "sheets",
                "spreadsheets",
                "developerMetadata",
                "search",
                "--params",
                JSON.stringify({ spreadsheetId: ref.spreadsheetId }),
                "--json",
                JSON.stringify({
                    dataFilters: [
                        {
                            developerMetadataLookup: {
                                metadataKey: "rowbound_config",
                            },
                        },
                    ],
                }),
            ]);
        }
        catch {
            // If the command fails (e.g., 404-like response), treat as no config
            return null;
        }
        const result = parseGwsResponse(output, MetadataSearchResponseSchema, "readConfig");
        if (!result.matchedDeveloperMetadata ||
            result.matchedDeveloperMetadata.length === 0) {
            return null;
        }
        let parsed;
        try {
            parsed = JSON.parse(result.matchedDeveloperMetadata[0].developerMetadata.metadataValue);
        }
        catch {
            throw new Error("Rowbound config contains invalid JSON in developer metadata.");
        }
        if (typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)) {
            throw new Error("Rowbound config is not a valid object.");
        }
        const cfg = parsed;
        if (typeof cfg.version !== "string" && typeof cfg.version !== "number") {
            throw new Error("Rowbound config is missing required field 'version' (string or number).");
        }
        if (typeof cfg.settings !== "object" ||
            cfg.settings === null ||
            Array.isArray(cfg.settings)) {
            throw new Error("Rowbound config is missing required field 'settings' (object).");
        }
        const hasActions = Array.isArray(cfg.actions);
        const hasTabs = typeof cfg.tabs === "object" &&
            cfg.tabs !== null &&
            !Array.isArray(cfg.tabs);
        if (!hasActions && !hasTabs) {
            throw new Error("Rowbound config must have either 'actions' (array) or 'tabs' (object).");
        }
        return parsed;
    }
    async writeConfig(ref, config) {
        const configJson = JSON.stringify(config);
        // Try to read existing config to get metadataId
        let existingId = null;
        try {
            const output = await runGws([
                "sheets",
                "spreadsheets",
                "developerMetadata",
                "search",
                "--params",
                JSON.stringify({ spreadsheetId: ref.spreadsheetId }),
                "--json",
                JSON.stringify({
                    dataFilters: [
                        {
                            developerMetadataLookup: {
                                metadataKey: "rowbound_config",
                            },
                        },
                    ],
                }),
            ]);
            const result = parseGwsResponse(output, MetadataSearchResponseSchema, "writeConfig (search existing)");
            if (result.matchedDeveloperMetadata &&
                result.matchedDeveloperMetadata.length > 0) {
                existingId =
                    result.matchedDeveloperMetadata[0].developerMetadata.metadataId;
            }
        }
        catch {
            // No existing config — will create
        }
        if (existingId !== null) {
            // Update existing metadata
            await runGws([
                "sheets",
                "spreadsheets",
                "batchUpdate",
                "--params",
                JSON.stringify({ spreadsheetId: ref.spreadsheetId }),
                "--json",
                JSON.stringify({
                    requests: [
                        {
                            updateDeveloperMetadata: {
                                dataFilters: [
                                    {
                                        developerMetadataLookup: {
                                            metadataId: existingId,
                                        },
                                    },
                                ],
                                developerMetadata: {
                                    metadataValue: configJson,
                                },
                                fields: "metadataValue",
                            },
                        },
                    ],
                }),
            ]);
        }
        else {
            // Create new metadata
            await runGws([
                "sheets",
                "spreadsheets",
                "batchUpdate",
                "--params",
                JSON.stringify({ spreadsheetId: ref.spreadsheetId }),
                "--json",
                JSON.stringify({
                    requests: [
                        {
                            createDeveloperMetadata: {
                                developerMetadata: {
                                    metadataKey: "rowbound_config",
                                    metadataValue: configJson,
                                    location: { spreadsheet: true },
                                    visibility: "DOCUMENT",
                                },
                            },
                        },
                    ],
                }),
            ]);
        }
    }
    async getHeaders(ref) {
        const key = this.cacheKey(ref);
        const cached = this.headerCache.get(key);
        const cachedTime = this.headerCacheTimes.get(key);
        if (cached &&
            cachedTime &&
            Date.now() - cachedTime < this.HEADER_CACHE_TTL_MS) {
            return cached;
        }
        // Deduplicate concurrent requests for the same headers
        const pending = this.headerPending.get(key);
        if (pending)
            return pending;
        const promise = this.fetchHeaders(ref, key);
        this.headerPending.set(key, promise);
        try {
            return await promise;
        }
        finally {
            this.headerPending.delete(key);
        }
    }
    /**
     * Clear the header cache. Useful when headers are known to have changed.
     */
    clearCache() {
        this.headerCache.clear();
        this.headerCacheTimes.clear();
    }
    /**
     * List all sheets (tabs) in the spreadsheet with their GIDs and names.
     */
    async listSheets(spreadsheetId) {
        const output = await runGws([
            "sheets",
            "spreadsheets",
            "get",
            "--params",
            JSON.stringify({
                spreadsheetId,
                fields: "sheets.properties",
            }),
            "--format",
            "json",
        ]);
        const result = parseGwsResponse(output, SheetsPropertiesResponseSchema, "listSheets");
        return (result.sheets ?? []).map((s) => ({
            gid: s.properties.sheetId,
            name: s.properties.title,
        }));
    }
    /**
     * Get the numeric sheet ID (GID) for a sheet.
     * Needed for named range creation.
     */
    async getSheetGid(ref) {
        const sheets = await this.listSheets(ref.spreadsheetId);
        const targetName = this.sheetName(ref);
        const sheet = sheets.find((s) => s.name === targetName);
        if (!sheet) {
            throw new Error(`Sheet "${targetName}" not found in spreadsheet ${ref.spreadsheetId}`);
        }
        return sheet.gid;
    }
    /**
     * Create a named range pointing to a specific column.
     * Name format: _rowbound_{actionId}
     * Range: entire column (no row bounds).
     */
    async createColumnRange(ref, actionId, columnIndex) {
        const sheetGid = await this.getSheetGid(ref);
        await runGws([
            "sheets",
            "spreadsheets",
            "batchUpdate",
            "--params",
            JSON.stringify({ spreadsheetId: ref.spreadsheetId }),
            "--json",
            JSON.stringify({
                requests: [
                    {
                        addNamedRange: {
                            namedRange: {
                                name: `_rowbound_${actionId}`,
                                range: {
                                    sheetId: sheetGid,
                                    startColumnIndex: columnIndex,
                                    endColumnIndex: columnIndex + 1,
                                },
                            },
                        },
                    },
                ],
            }),
        ]);
    }
    /**
     * Read all Rowbound named ranges for a sheet.
     * Returns a map of actionId -> column index (0-based).
     * When sheetGid is provided, only returns ranges belonging to that tab.
     */
    async readColumnRanges(ref, sheetGid) {
        const output = await runGws([
            "sheets",
            "spreadsheets",
            "get",
            "--params",
            JSON.stringify({
                spreadsheetId: ref.spreadsheetId,
                fields: "namedRanges",
            }),
            "--format",
            "json",
        ]);
        const result = parseGwsResponse(output, NamedRangesResponseSchema, "readColumnRanges");
        const map = new Map();
        const prefix = "_rowbound_";
        if (result.namedRanges) {
            for (const nr of result.namedRanges) {
                if (nr.name.startsWith(prefix)) {
                    // Filter by sheetGid if provided.
                    // Google Sheets API omits sheetId when it's 0 (the default tab).
                    if (sheetGid !== undefined && (nr.range.sheetId ?? 0) !== sheetGid) {
                        continue;
                    }
                    const actionId = nr.name.slice(prefix.length);
                    map.set(actionId, nr.range.startColumnIndex);
                }
            }
        }
        return map;
    }
    /**
     * Delete a named range by action ID.
     */
    async deleteColumnRange(ref, actionId) {
        // First read to find the namedRangeId
        const output = await runGws([
            "sheets",
            "spreadsheets",
            "get",
            "--params",
            JSON.stringify({
                spreadsheetId: ref.spreadsheetId,
                fields: "namedRanges",
            }),
            "--format",
            "json",
        ]);
        const result = parseGwsResponse(output, NamedRangesResponseSchema, "deleteColumnRange");
        const targetName = `_rowbound_${actionId}`;
        const namedRange = result.namedRanges?.find((nr) => nr.name === targetName);
        if (!namedRange) {
            // No named range to delete -- silently return
            return;
        }
        await runGws([
            "sheets",
            "spreadsheets",
            "batchUpdate",
            "--params",
            JSON.stringify({ spreadsheetId: ref.spreadsheetId }),
            "--json",
            JSON.stringify({
                requests: [
                    {
                        deleteNamedRange: {
                            namedRangeId: namedRange.namedRangeId,
                        },
                    },
                ],
            }),
        ]);
    }
    async fetchHeaders(ref, key) {
        const sheet = this.sheetName(ref);
        const output = await runGws([
            "sheets",
            "spreadsheets",
            "values",
            "get",
            "--params",
            JSON.stringify({
                spreadsheetId: ref.spreadsheetId,
                range: `'${this.escapeSheetName(sheet)}'!1:1`,
            }),
            "--format",
            "json",
        ]);
        const result = parseGwsResponse(output, ValuesResponseSchema, "getHeaders");
        const headers = result.values && result.values.length > 0 ? result.values[0] : [];
        this.headerCache.set(key, headers);
        this.headerCacheTimes.set(key, Date.now());
        return headers;
    }
}
