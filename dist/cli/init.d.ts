import type { Command } from "commander";
/**
 * Extract spreadsheet ID from a full Google Sheets URL, or return the input as-is
 * if it's already a plain ID.
 *
 * Google Sheets URLs look like:
 *   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit...
 */
export declare function extractSheetId(input: string): string;
export declare function registerInit(program: Command): void;
