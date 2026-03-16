import { SheetsAdapter } from "../adapters/sheets/sheets-adapter.js";
import { defaultSettings } from "../core/defaults.js";
import { dim, error, success, warn } from "./format.js";
/**
 * Extract spreadsheet ID from a full Google Sheets URL, or return the input as-is
 * if it's already a plain ID.
 *
 * Google Sheets URLs look like:
 *   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit...
 */
export function extractSheetId(input) {
    const match = input.match(/^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (match) {
        return match[1];
    }
    return input;
}
export function registerInit(program) {
    program
        .command("init")
        .description("Initialize a sheet with a default Rowbound config")
        .argument("<sheetId>", "Google Sheets spreadsheet ID or URL")
        .option("--tab <name>", "Sheet tab name", "Sheet1")
        .action(async (rawSheetId, opts) => {
        const sheetId = extractSheetId(rawSheetId);
        if (sheetId !== rawSheetId) {
            console.log(warn(`Extracted spreadsheet ID from URL: ${sheetId}`));
        }
        const adapter = new SheetsAdapter();
        const ref = { spreadsheetId: sheetId, sheetName: opts.tab };
        try {
            const existing = await adapter.readConfig(ref);
            if (existing) {
                console.error(error("Config already exists for this sheet.") +
                    " Remove it first or use 'rowbound config show' to inspect.");
                process.exitCode = 1;
                return;
            }
            // Get the tab's GID for v2 config
            const sheets = await adapter.listSheets(sheetId);
            const targetSheet = sheets.find((s) => s.name === opts.tab);
            if (!targetSheet) {
                console.error(error(`Tab "${opts.tab}" not found`) +
                    ` in spreadsheet ${dim(sheetId)}. Available: ${sheets.map((s) => s.name).join(", ")}`);
                process.exitCode = 1;
                return;
            }
            const gid = String(targetSheet.gid);
            const defaultConfig = {
                version: "2",
                tabs: {
                    [gid]: {
                        name: opts.tab,
                        columns: {},
                        actions: [],
                    },
                },
                actions: [],
                settings: defaultSettings,
            };
            await adapter.writeConfig(ref, defaultConfig);
            console.log(success("Initialized Rowbound config for sheet:"), dim(sheetId));
            console.log("Tab:", opts.tab, dim(`(GID: ${gid})`));
            console.log("\nNext steps:\n  rowbound config add-action <sheetId> --json '<action>'\n  rowbound run <sheetId>");
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(error("Failed to initialize:"), msg);
            process.exitCode = 1;
        }
    });
}
