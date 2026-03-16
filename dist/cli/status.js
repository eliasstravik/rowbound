import { SheetsAdapter } from "../adapters/sheets/sheets-adapter.js";
import { getTabConfig } from "../core/tab-resolver.js";
import { bold, dim, error, success, warn } from "./format.js";
export function registerStatus(program) {
    program
        .command("status")
        .description("Show pipeline status overview")
        .argument("<sheetId>", "Google Sheets spreadsheet ID")
        .option("--tab <name>", "Sheet tab name")
        .option("--json", "Output as JSON")
        .action(async (sheetId, opts) => {
        const adapter = new SheetsAdapter();
        const tabName = opts.tab ?? "Sheet1";
        const ref = { spreadsheetId: sheetId, sheetName: tabName };
        try {
            const config = await adapter.readConfig(ref);
            if (!config) {
                console.error(error("No Rowbound config found. Run 'rowbound init <sheetId>' first."));
                process.exitCode = 1;
                return;
            }
            // Resolve actions from tab config (v2) or top-level (v1)
            let actions;
            if (config.tabs) {
                try {
                    const { tab } = getTabConfig(config, opts.tab);
                    actions = tab.actions;
                }
                catch (e) {
                    console.error(error(e instanceof Error ? e.message : String(e)));
                    process.exitCode = 1;
                    return;
                }
            }
            else {
                actions = config.actions;
            }
            // Read rows to build enrichment status
            const enrichment = [];
            let rowCount = 0;
            try {
                const rows = await adapter.readRows(ref);
                rowCount = rows.length;
                const targetColumns = [...new Set(actions.map((s) => s.target))];
                if (targetColumns.length > 0 && rows.length > 0) {
                    for (const target of targetColumns) {
                        const filled = rows.filter((row) => row[target] !== undefined && row[target] !== "").length;
                        const pct = rows.length > 0 ? Math.round((filled / rows.length) * 100) : 0;
                        enrichment.push({ target, filled, total: rows.length, pct });
                    }
                }
            }
            catch (readErr) {
                const readMsg = readErr instanceof Error ? readErr.message : String(readErr);
                console.log(warn(`Could not read sheet data: ${readMsg}`));
            }
            if (opts.json) {
                const data = {
                    actions: actions.map((s) => ({
                        id: s.id,
                        type: s.type,
                        target: s.target,
                    })),
                    settings: config.settings,
                    rows: rowCount,
                    enrichment,
                };
                console.log(JSON.stringify(data, null, 2));
                return;
            }
            console.log(bold("Pipeline Status"));
            console.log("===============\n");
            // Action summary
            console.log(`Actions: ${bold(String(actions.length))}`);
            if (actions.length > 0) {
                console.log();
                for (const action of actions) {
                    console.log(`  ${bold(action.id)} ${dim(`(${action.type})`)} -> ${action.target}`);
                }
            }
            // Settings
            console.log(dim("\nSettings:"));
            console.log(`  Concurrency:   ${config.settings.concurrency}`);
            console.log(`  Rate limit:    ${config.settings.rateLimit}/s`);
            console.log(`  Retry:         ${config.settings.retryAttempts} attempts (${config.settings.retryBackoff})`);
            console.log(`\nData: ${bold(String(rowCount))} rows`);
            if (enrichment.length > 0) {
                console.log("\nEnrichment status:");
                for (const e of enrichment) {
                    const colorPct = e.pct >= 80
                        ? success(`${e.pct}%`)
                        : e.pct >= 50
                            ? warn(`${e.pct}%`)
                            : error(`${e.pct}%`);
                    console.log(`  ${e.target}: ${e.filled}/${e.total} filled (${colorPct})`);
                }
            }
            else if (rowCount === 0) {
                console.log(dim("\n(Could not read sheet data for enrichment status)"));
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(error("Failed to get status:"), msg);
            process.exitCode = 1;
        }
    });
}
