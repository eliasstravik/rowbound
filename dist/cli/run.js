import { SheetsAdapter } from "../adapters/sheets/sheets-adapter.js";
import { runPipeline } from "../core/engine.js";
import { buildSafeEnv } from "../core/env.js";
import { cleanupOrphanedRanges, reconcile } from "../core/reconcile.js";
import { createRunState } from "../core/run-state.js";
import { createRunTracker } from "../core/run-tracker.js";
import { bold, dim, error, success, warn } from "./format.js";
export function registerRun(program) {
    program
        .command("run")
        .description("Run the enrichment pipeline")
        .argument("<sheetId>", "Google Sheets spreadsheet ID")
        .option("--tab <name>", "Sheet tab name", "Sheet1")
        .option("--rows <range>", "Row range to process (e.g. 2-50)")
        .option("--action <id>", "Run only a specific action")
        .option("--dry-run", "Dry run — compute but do not write back", false)
        .option("--json", "Output result as JSON")
        .option("-q, --quiet", "Suppress per-row output, show only final summary")
        .action(async (sheetId, opts) => {
        const adapter = new SheetsAdapter();
        const ref = { spreadsheetId: sheetId, sheetName: opts.tab };
        const jsonMode = opts.json ?? false;
        const quietMode = opts.quiet ?? false;
        /** Log only when not in --json mode */
        const log = (msg) => {
            if (!jsonMode)
                console.log(msg);
        };
        const logErr = (msg) => {
            if (!jsonMode)
                console.error(msg);
        };
        try {
            const config = await adapter.readConfig(ref);
            if (!config) {
                logErr(error("No Rowbound config found.") +
                    " Run 'rowbound init <sheetId>' first.");
                process.exitCode = 1;
                return;
            }
            // Reconcile column registry (detect renames, track new columns, migrate v1→v2)
            const reconciled = await reconcile(adapter, ref, config);
            if (reconciled.messages.length > 0) {
                log(dim("\u21BB Reconciling columns..."));
                for (const msg of reconciled.messages) {
                    log(`  ${dim(msg)}`);
                }
                log("");
            }
            if (reconciled.configChanged) {
                await adapter.writeConfig(ref, reconciled.config);
            }
            if (reconciled.orphanedRanges.length > 0) {
                await cleanupOrphanedRanges(adapter, ref, reconciled.orphanedRanges);
            }
            const tabConfig = reconciled.tabConfig;
            if (tabConfig.enabled === false) {
                logErr(warn("Tab is disabled. Skipping pipeline run."));
                return;
            }
            if (tabConfig.actions.length === 0) {
                logErr(error("No actions configured.") +
                    " Add actions with 'rowbound config add-action'.");
                process.exitCode = 1;
                return;
            }
            const isRange = opts.rows ? /^\d+-\d+$/.test(opts.rows) : false;
            const isList = opts.rows ? /^\d+(,\d+)*$/.test(opts.rows) : false;
            if (opts.rows && !isRange && !isList) {
                logErr(`${error("Invalid --rows format.")} Expected range (e.g. 2-50) or comma-separated rows (e.g. 100,200,300).`);
                process.exitCode = 1;
                return;
            }
            if (opts.rows && isRange) {
                const [startStr, endStr] = opts.rows.split("-");
                const start = parseInt(startStr, 10);
                const end = parseInt(endStr, 10);
                if (start > end) {
                    logErr(`${error("Invalid --rows range.")} Start (${start}) must be <= end (${end}).`);
                    process.exitCode = 1;
                    return;
                }
            }
            if (opts.action &&
                !tabConfig.actions.some((s) => s.id === opts.action)) {
                logErr(error(`Action "${opts.action}" not found.`) +
                    ` Available: ${tabConfig.actions.map((s) => s.id).join(", ")}`);
                process.exitCode = 1;
                return;
            }
            const resolvedConfig = {
                ...reconciled.config,
                actions: tabConfig.actions,
                settings: { ...reconciled.config.settings, ...(tabConfig.settings || {}) },
            };
            // Convert CLI row format to engine format
            let range;
            let rowSet;
            if (opts.rows && isList) {
                // Comma-separated rows: convert sheet rows to 0-based data indices
                rowSet = new Set(opts.rows.split(",").map((s) => parseInt(s, 10) - 2));
            }
            else if (opts.rows && isRange) {
                range = opts.rows.replace("-", ":");
            }
            // Build filtered env (only ROWBOUND_*, referenced {{env.X}}, NODE_ENV, PATH)
            const env = buildSafeEnv(resolvedConfig);
            // Set up abort controller for graceful shutdown
            const controller = new AbortController();
            const shutdown = () => {
                if (controller.signal.aborted) {
                    log(warn("\nForce quitting..."));
                    process.exit(130);
                }
                log(warn("\nShutting down gracefully (Ctrl+C again to force quit)..."));
                controller.abort();
            };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
            // Create run state for tracking
            const state = createRunState({
                sheetId,
                sheetName: opts.tab,
                config: resolvedConfig,
                totalRows: 0, // Will be set after runPipeline returns
                dryRun: opts.dryRun,
                range,
                actionFilter: opts.action,
            });
            const tracker = createRunTracker(state);
            if (opts.dryRun) {
                log(warn("DRY RUN — no writes will be made\n"));
            }
            log(`Running pipeline on sheet ${dim(sheetId)}...`);
            if (opts.action) {
                log(`Filtering to action: ${bold(opts.action)}`);
            }
            if (opts.rows) {
                log(`Rows: ${bold(opts.rows)}`);
            }
            log("");
            // Track total rows for progress display
            let totalRowsToProcess = 0;
            let currentRow = 0;
            const result = await runPipeline({
                adapter,
                ref,
                config: resolvedConfig,
                env,
                range,
                rowSet,
                actionFilter: opts.action,
                dryRun: opts.dryRun,
                signal: controller.signal,
                columnMap: tabConfig.columns,
                checkEnabled: async () => {
                    try {
                        const freshConfig = await adapter.readConfig(ref);
                        if (!freshConfig?.tabs)
                            return true;
                        const tab = freshConfig.tabs[reconciled.tabGid];
                        return tab?.enabled !== false;
                    }
                    catch {
                        return true;
                    }
                },
                onTotalRows: (total) => {
                    totalRowsToProcess = total;
                },
                onRowStart: (rowIndex, row) => {
                    tracker.onRowStart(rowIndex, row);
                    currentRow++;
                    if (!quietMode) {
                        const progress = totalRowsToProcess > 0
                            ? `Processing row ${currentRow} of ${totalRowsToProcess}...`
                            : `Processing row ${rowIndex + 2}...`;
                        log(progress);
                    }
                },
                onActionComplete: (rowIndex, actionId, value) => {
                    tracker.onActionComplete(rowIndex, actionId, value);
                    if (!quietMode) {
                        if (value !== null) {
                            log(`  ${success("\u2713")} ${actionId}: ${value}`);
                        }
                        else {
                            log(`  ${dim("-")} ${actionId}: ${warn("skipped")}`);
                        }
                    }
                },
                onError: (rowIndex, actionId, err) => {
                    tracker.onError(rowIndex, actionId, err);
                    if (!quietMode) {
                        log(`  ${error("\u2717")} ${actionId}: ${error(err.message)}`);
                    }
                },
                onRowComplete: (rowIndex, updates) => {
                    tracker.onRowComplete(rowIndex, updates);
                },
            });
            // Finalize run tracking
            state.totalRows = result.totalRows;
            await tracker.finalize(controller.signal.aborted);
            if (controller.signal.aborted) {
                process.exitCode = 130;
            }
            if (jsonMode) {
                console.log(JSON.stringify(result, null, 2));
            }
            else {
                // Print summary
                console.log(`\n${bold("--- Summary ---")}`);
                console.log(`Run ID:         ${dim(state.runId)}`);
                console.log(`Rows processed: ${bold(String(result.processedRows))}`);
                console.log(`Cell updates:   ${bold(String(result.updates))}`);
                console.log(`Errors:         ${result.errors.length > 0 ? error(String(result.errors.length)) : success(String(result.errors.length))}`);
                if (result.skippedRows > 0) {
                    console.log(`Rows skipped:   ${warn(String(result.skippedRows))}`);
                }
                if (result.errors.length > 0) {
                    console.log(`\n${error("Errors:")}`);
                    for (const err of result.errors) {
                        console.log(`  Row ${err.rowIndex + 2}, action "${err.actionId}": ${error(err.error)}`);
                    }
                }
            }
            // Clean up signal handlers
            process.removeListener("SIGINT", shutdown);
            process.removeListener("SIGTERM", shutdown);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (jsonMode) {
                console.log(JSON.stringify({ error: msg }, null, 2));
            }
            else {
                console.error(error("Pipeline failed:"), msg);
            }
            process.exitCode = 1;
        }
    });
}
