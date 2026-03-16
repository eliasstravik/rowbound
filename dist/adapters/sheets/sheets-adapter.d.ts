import type { Adapter, CellUpdate, PipelineConfig, Row, SheetRef } from "../../core/types.js";
/**
 * Convert a 0-indexed column number to a spreadsheet column letter.
 * 0 = A, 1 = B, ..., 25 = Z, 26 = AA, 27 = AB, ...
 */
export declare function columnIndexToLetter(index: number): string;
/**
 * Run the gws CLI with the given arguments.
 * Uses execFile (not exec) to avoid shell injection.
 */
export declare function runGws(args: string[]): Promise<string>;
/**
 * Google Sheets adapter using the gws CLI tool.
 */
export declare class SheetsAdapter implements Adapter {
    private headerCache;
    private headerCacheTimes;
    private headerPending;
    private readonly HEADER_CACHE_TTL_MS;
    private escapeSheetName;
    private cacheKey;
    private sheetName;
    /**
     * Look up a column name in the headers and return its letter (A, B, ..., AA, etc.).
     */
    private columnNameToLetter;
    readRows(ref: SheetRef, range?: string): Promise<Row[]>;
    writeCell(ref: SheetRef, update: CellUpdate): Promise<void>;
    writeBatch(ref: SheetRef, updates: CellUpdate[]): Promise<void>;
    readConfig(ref: SheetRef): Promise<PipelineConfig | null>;
    writeConfig(ref: SheetRef, config: PipelineConfig): Promise<void>;
    getHeaders(ref: SheetRef): Promise<string[]>;
    /**
     * Clear the header cache. Useful when headers are known to have changed.
     */
    clearCache(): void;
    /**
     * List all sheets (tabs) in the spreadsheet with their GIDs and names.
     */
    listSheets(spreadsheetId: string): Promise<Array<{
        gid: number;
        name: string;
    }>>;
    /**
     * Get the numeric sheet ID (GID) for a sheet.
     * Needed for named range creation.
     */
    getSheetGid(ref: SheetRef): Promise<number>;
    /**
     * Create a named range pointing to a specific column.
     * Name format: _rowbound_{actionId}
     * Range: entire column (no row bounds).
     */
    createColumnRange(ref: SheetRef, actionId: string, columnIndex: number): Promise<void>;
    /**
     * Read all Rowbound named ranges for a sheet.
     * Returns a map of actionId -> column index (0-based).
     * When sheetGid is provided, only returns ranges belonging to that tab.
     */
    readColumnRanges(ref: SheetRef, sheetGid?: number): Promise<Map<string, number>>;
    /**
     * Delete a named range by action ID.
     */
    deleteColumnRange(ref: SheetRef, actionId: string): Promise<void>;
    private fetchHeaders;
}
