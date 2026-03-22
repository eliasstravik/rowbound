import { createServer, } from "node:http";
import { SheetsAdapter } from "../adapters/sheets/sheets-adapter.js";
import { runPipeline } from "../core/engine.js";
import { buildSafeEnv } from "../core/env.js";
import { cleanupOrphanedRanges, reconcile } from "../core/reconcile.js";
import { createRunState } from "../core/run-state.js";
import { createRunTracker } from "../core/run-tracker.js";
import { safeCompare } from "../core/safe-compare.js";
import { bold, dim, error as fmtError, warn } from "./format.js";
// ---------------------------------------------------------------------------
// Rate limiter — simple in-memory per-IP sliding window (60 req/min)
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
function createRateLimiter() {
    const hits = new Map();
    return (ip) => {
        const now = Date.now();
        const timestamps = hits.get(ip) ?? [];
        const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        if (recent.length >= RATE_LIMIT_MAX) {
            hits.set(ip, recent);
            return false; // rate limited
        }
        recent.push(now);
        hits.set(ip, recent);
        return true; // allowed
    };
}
function timestamp() {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
}
async function executePipelineRun(adapter, ref, config, env, signal, sheetId, sheetName, checkEnabled) {
    // Reconcile column registry (detect renames, track new columns, migrate v1→v2)
    const reconciled = await reconcile(adapter, ref, config);
    if (reconciled.configChanged) {
        await adapter.writeConfig(ref, reconciled.config);
    }
    if (reconciled.orphanedRanges.length > 0) {
        await cleanupOrphanedRanges(adapter, ref, reconciled.orphanedRanges);
    }
    const tabConfig = reconciled.tabConfig;
    const resolvedConfig = {
        ...reconciled.config,
        actions: tabConfig.actions,
        settings: { ...reconciled.config.settings, ...(tabConfig.settings || {}) },
    };
    const runState = createRunState({
        sheetId,
        sheetName,
        config: resolvedConfig,
        totalRows: 0,
        dryRun: false,
    });
    const tracker = createRunTracker(runState);
    const result = await runPipeline({
        adapter,
        ref,
        config: resolvedConfig,
        env,
        signal,
        columnMap: tabConfig.columns,
        checkEnabled,
        onRowStart: (rowIndex, row) => {
            tracker.onRowStart(rowIndex, row);
        },
        onActionComplete: (rowIndex, actionId, value) => {
            tracker.onActionComplete(rowIndex, actionId, value);
        },
        onError: (rowIndex, actionId, error) => {
            tracker.onError(rowIndex, actionId, error);
        },
        onRowComplete: (rowIndex, updates) => {
            tracker.onRowComplete(rowIndex, updates);
        },
    });
    runState.totalRows = result.totalRows;
    await tracker.finalize(signal.aborted);
    return result;
}
export function registerWatch(program) {
    program
        .command("watch")
        .description("Watch a sheet for changes and run the pipeline continuously")
        .argument("<sheetId>", "Google Sheets spreadsheet ID")
        .option("--tab <name>", "Sheet tab name", "Sheet1")
        .option("--interval <seconds>", "Polling interval in seconds", "30")
        .option("--port <port>", "Webhook server port", "3000")
        .option("--webhook-host <host>", "Webhook server bind address", "127.0.0.1")
        .option("--webhook-token <token>", "Bearer token for webhook authentication")
        .action(async (sheetId, opts) => {
        const adapter = new SheetsAdapter();
        const ref = {
            spreadsheetId: sheetId,
            sheetName: opts.tab,
        };
        const intervalSeconds = parseInt(opts.interval, 10);
        const port = parseInt(opts.port, 10);
        if (Number.isNaN(intervalSeconds) || intervalSeconds < 1) {
            console.error(fmtError("Invalid --interval value. Must be a positive integer."));
            process.exitCode = 1;
            return;
        }
        if (Number.isNaN(port) || port < 1 || port > 65535) {
            console.error(fmtError("Invalid --port value. Must be between 1 and 65535."));
            process.exitCode = 1;
            return;
        }
        // Validate config exists before starting watch
        let config;
        try {
            config = await adapter.readConfig(ref);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(fmtError("Failed to read config:"), msg);
            process.exitCode = 1;
            return;
        }
        if (!config) {
            console.error(fmtError("No Rowbound config found. Run 'rowbound init <sheetId>' first."));
            process.exitCode = 1;
            return;
        }
        // Check if any actions exist (in v2 tabs or v1 top-level)
        const hasActions = config.tabs
            ? Object.values(config.tabs).some((t) => t.actions.length > 0)
            : config.actions.length > 0;
        if (!hasActions) {
            console.error(fmtError("No actions configured. Add actions with 'rowbound config add-action'."));
            process.exitCode = 1;
            return;
        }
        const webhookToken = opts.webhookToken ?? process.env.ROWBOUND_WEBHOOK_TOKEN;
        const controller = new AbortController();
        let isRunning = false;
        // Run one pipeline cycle, guarded by the isRunning flag
        async function runOnce() {
            if (isRunning) {
                return null;
            }
            isRunning = true;
            try {
                // Re-read config each tick so hot-reload of actions works
                const freshConfig = await adapter.readConfig(ref);
                const activeConfig = freshConfig ?? config;
                // Check if tab is disabled
                if (activeConfig.tabs) {
                    const tabEntries = Object.entries(activeConfig.tabs);
                    const matchingTab = tabEntries.find(([_, t]) => t.name === opts.tab);
                    if (matchingTab && matchingTab[1].enabled === false) {
                        console.log(`[${timestamp()}] Tab "${opts.tab}" is disabled, skipping run.`);
                        return null;
                    }
                }
                // Rebuild env from fresh config so new env references are picked up
                const env = buildSafeEnv(activeConfig);
                const result = await executePipelineRun(adapter, ref, activeConfig, env, controller.signal, sheetId, opts.tab, async () => {
                    try {
                        const cfg = await adapter.readConfig(ref);
                        if (!cfg?.tabs)
                            return true;
                        const tabEntry = Object.entries(cfg.tabs).find(([_, t]) => t.name === opts.tab);
                        return tabEntry ? tabEntry[1].enabled !== false : true;
                    }
                    catch {
                        return true;
                    }
                });
                return result;
            }
            finally {
                isRunning = false;
            }
        }
        // --- Friendly startup message (UX-011) ---
        // Resolve tab name from config if available
        let displayName;
        if (config.tabs) {
            const tabEntry = Object.values(config.tabs).find((t) => t.name === opts.tab);
            if (tabEntry) {
                displayName = tabEntry.name;
            }
        }
        if (displayName) {
            console.log(`Watching ${bold(displayName)} every ${intervalSeconds}s... ${dim(sheetId)}`);
        }
        else {
            console.log(`Watching ${bold(opts.tab)} every ${intervalSeconds}s... ${dim(sheetId)}`);
        }
        // --- Initial pipeline run (UX-010) ---
        console.log(`[${timestamp()}] Running initial pipeline...`);
        try {
            const result = await runOnce();
            if (result && result.updates > 0) {
                console.log(`[${timestamp()}] Initial run: ${result.processedRows} rows, ${result.updates} updates`);
            }
            else if (result) {
                console.log(`[${timestamp()}] Initial run complete, no updates needed`);
            }
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[${timestamp()}] Initial pipeline error: ${msg}`);
            // Don't return — let the interval start anyway
        }
        // --- Polling loop ---
        const intervalId = setInterval(async () => {
            if (controller.signal.aborted)
                return;
            console.log(`[${timestamp()}] Checking for new rows...`);
            try {
                const result = await runOnce();
                if (result && result.updates > 0) {
                    console.log(`[${timestamp()}] Processed ${result.processedRows} rows, ${result.updates} updates`);
                }
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                console.error(`[${timestamp()}] Pipeline error: ${msg}`);
            }
        }, intervalSeconds * 1000);
        // --- Webhook HTTP server ---
        const isAllowed = createRateLimiter();
        const server = createServer(async (req, res) => {
            // Rate limit by remote IP
            const ip = req.socket.remoteAddress ??
                req.headers["x-forwarded-for"]?.toString() ??
                "unknown";
            if (!isAllowed(ip)) {
                res.writeHead(429, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Too Many Requests" }));
                return;
            }
            if (req.method !== "POST" || req.url !== "/webhook") {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Not found" }));
                return;
            }
            // Authenticate if token is configured (constant-time comparison)
            if (webhookToken) {
                const authHeader = req.headers.authorization ?? "";
                if (!safeCompare(authHeader, `Bearer ${webhookToken}`)) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Unauthorized" }));
                    return;
                }
            }
            // Parse JSON body with size limit (1MB)
            const chunks = [];
            let totalBytes = 0;
            for await (const chunk of req) {
                totalBytes += chunk.length;
                if (totalBytes > 1_048_576) {
                    res.writeHead(413, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Payload too large" }));
                    return;
                }
                chunks.push(chunk);
            }
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            }
            catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON body" }));
                return;
            }
            // If body contains row data, write it to the sheet
            if (body && typeof body === "object" && !Array.isArray(body)) {
                const rowData = body;
                if (Object.keys(rowData).length > 0) {
                    try {
                        const MAX_CELL_LENGTH = 50_000;
                        const headers = await adapter.getHeaders(ref);
                        const headerSet = new Set(headers);
                        const rows = await adapter.readRows(ref);
                        const nextRow = rows.length + 2; // +2 because row 1 is headers, data starts at 2
                        const updates = [];
                        for (const h of headers) {
                            if (!(h in rowData))
                                continue;
                            const val = rowData[h];
                            // Skip fields not matching known column headers
                            if (!headerSet.has(h))
                                continue;
                            // Type check: only allow strings and numbers
                            if (typeof val !== "string" && typeof val !== "number") {
                                continue;
                            }
                            const strVal = String(val);
                            // Size check: Google Sheets cell limit
                            if (strVal.length > MAX_CELL_LENGTH)
                                continue;
                            updates.push({
                                row: nextRow,
                                column: h,
                                value: strVal,
                            });
                        }
                        if (updates.length > 0) {
                            await adapter.writeBatch(ref, updates);
                        }
                    }
                    catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        console.error(`[${timestamp()}] Webhook write error: ${msg}`);
                    }
                }
            }
            // Trigger pipeline run immediately
            console.log(`[${timestamp()}] Webhook received, running pipeline...`);
            try {
                const result = await runOnce();
                if (result) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        ok: true,
                        processedRows: result.processedRows,
                        updates: result.updates,
                        errors: result.errors.length,
                    }));
                }
                else {
                    // Pipeline already running
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        ok: true,
                        message: "Pipeline already in progress, skipped.",
                    }));
                }
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                console.error(`[${timestamp()}] Webhook pipeline error: ${msg}`);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: msg }));
            }
        });
        // Server timeouts
        server.headersTimeout = 10_000;
        server.requestTimeout = 30_000;
        server.keepAliveTimeout = 5_000;
        const webhookHost = opts.webhookHost;
        server.listen(port, webhookHost, () => {
            console.log(`Webhook server listening on http://${webhookHost}:${port}`);
            if (!webhookToken) {
                console.warn(warn("WARNING: Webhook server running WITHOUT authentication."));
                console.warn(warn("Anyone who can reach this port can trigger pipeline runs and write data to your sheet."));
                console.warn(warn("Set ROWBOUND_WEBHOOK_TOKEN or use --webhook-token to secure the endpoint."));
            }
        });
        // --- Graceful shutdown (NEW-005/MISSED-006) ---
        // Store handler references so they can be removed on cleanup
        const onSigInt = () => {
            shutdown();
        };
        const onSigTerm = () => {
            shutdown();
        };
        const shutdown = () => {
            console.log("\nShutting down...");
            controller.abort();
            clearInterval(intervalId);
            // Remove signal handlers to prevent accumulation
            process.removeListener("SIGINT", onSigInt);
            process.removeListener("SIGTERM", onSigTerm);
            server.close(() => {
                console.log("Watch stopped.");
            });
        };
        process.on("SIGINT", onSigInt);
        process.on("SIGTERM", onSigTerm);
    });
}
