/**
 * Format milliseconds as a human-readable duration.
 * Examples: "12s", "1m30s", "2h5m"
 */
export function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 1) {
        return "<1s";
    }
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
    }
    if (minutes > 0) {
        return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
    }
    return `${seconds}s`;
}
/**
 * Format an ISO date as a relative "age" string.
 * Examples: "just now", "5m ago", "2h ago", "3d ago", or "running" if status is running.
 */
export function formatAge(isoDate, status) {
    if (status === "running") {
        return "running";
    }
    const then = new Date(isoDate).getTime();
    const now = Date.now();
    const diffMs = now - then;
    const diffSeconds = Math.floor(diffMs / 1000);
    if (diffSeconds < 60) {
        return "just now";
    }
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) {
        return `${diffMinutes}m ago`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        return `${diffHours}h ago`;
    }
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
}
/** Get status icon for a run */
function statusIcon(run) {
    switch (run.status) {
        case "completed":
            return run.errors.length === 0 ? "\u2713" : "\u2717";
        case "failed":
            return "\u2717";
        case "running":
            return "\u231b";
        case "aborted":
            return "\u2298";
        default:
            return "?";
    }
}
/** Get display name for a sheet */
function sheetDisplayName(run) {
    if (run.sheetName) {
        return run.sheetName;
    }
    return run.sheetId.length > 12 ? run.sheetId.slice(0, 12) : run.sheetId;
}
/**
 * Format a list of runs as a compact table.
 *
 * ```
 * STATUS  RUN       SHEET        ROWS      UPDATES  ERRORS  DURATION  AGE
 * ✓       a1b2c3    EliteCart    30/30     28       0       12s       5m ago
 * ```
 */
export function formatRunList(runs) {
    if (runs.length === 0) {
        return "No runs found.";
    }
    const rows = [];
    rows.push([
        "STATUS",
        "RUN",
        "SHEET",
        "ROWS",
        "UPDATES",
        "ERRORS",
        "DURATION",
        "AGE",
    ]);
    for (const run of runs) {
        const icon = statusIcon(run);
        const totalUpdates = run.actionSummaries.reduce((sum, s) => sum + s.success, 0);
        const totalErrors = run.errors.length;
        const duration = run.durationMs !== undefined ? formatDuration(run.durationMs) : "-";
        const age = formatAge(run.startedAt, run.status);
        const rowCount = run.totalRows > 0
            ? `${run.processedRows}/${run.totalRows}`
            : `${run.processedRows}`;
        rows.push([
            icon,
            run.runId,
            sheetDisplayName(run),
            rowCount,
            String(totalUpdates),
            String(totalErrors),
            duration,
            age,
        ]);
    }
    // Calculate column widths
    const colWidths = rows[0].map((_, colIndex) => Math.max(...rows.map((row) => row[colIndex].length)));
    // Format each row with padding
    return rows
        .map((row) => row.map((cell, i) => cell.padEnd(colWidths[i])).join("  "))
        .join("\n");
}
/** Action status icon: ✓ (0 errors), ✗ (has errors), ⚠ (has skips but no errors) */
function actionStatusIcon(action) {
    if (action.errors > 0)
        return "\u2717";
    if (action.skipped > 0)
        return "\u26a0";
    return "\u2713";
}
/**
 * Format a detailed view of a single run.
 *
 * ```
 * ✗ Run d4e5f6 · LeadList
 *   Sheet: 1xABC...def · Started: 2h ago · Duration: 45s
 *
 * ACTIONS
 *   extract_domain    ✓ 150/150
 *   enrich_company    ✗ 147/150 (3 errors)
 *   find_email        ⚠ 120/147 (27 skipped)
 *
 * ERRORS (3)
 *   Row 45   enrich_company   429 Too Many Requests (retries exhausted)
 *   Row 89   enrich_company   timeout after 30s
 *   Row 102  enrich_company   404 → wrote "not_found"
 * ```
 */
export function formatRunDetail(run, errorsOnly = false) {
    const lines = [];
    if (!errorsOnly) {
        // Header
        const icon = statusIcon(run);
        const name = sheetDisplayName(run);
        lines.push(`${icon} Run ${run.runId} \u00b7 ${name}`);
        const sheetLabel = run.sheetId.length > 12
            ? `${run.sheetId.slice(0, 6)}...${run.sheetId.slice(-3)}`
            : run.sheetId;
        const age = formatAge(run.startedAt, run.status);
        const duration = run.durationMs !== undefined ? formatDuration(run.durationMs) : "-";
        lines.push(`  Sheet: ${sheetLabel} \u00b7 Started: ${age} \u00b7 Duration: ${duration}`);
        if (run.dryRun) {
            lines.push("  Mode: DRY RUN");
        }
        // Actions
        if (run.actionSummaries.length > 0) {
            lines.push("");
            lines.push("ACTIONS");
            // Calculate widths for alignment
            const actionIdWidth = Math.max(...run.actionSummaries.map((s) => s.actionId.length));
            for (const action of run.actionSummaries) {
                const total = action.success + action.skipped + action.errors;
                const icon = actionStatusIcon(action);
                const details = [];
                if (action.errors > 0) {
                    details.push(`${action.errors} errors`);
                }
                if (action.skipped > 0) {
                    details.push(`${action.skipped} skipped`);
                }
                const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
                lines.push(`  ${action.actionId.padEnd(actionIdWidth)}  ${icon} ${action.success}/${total}${suffix}`);
            }
        }
    }
    // Errors section
    if (run.errors.length > 0) {
        if (!errorsOnly) {
            lines.push("");
        }
        lines.push(`ERRORS (${run.errors.length})`);
        // Calculate widths for alignment
        const rowWidth = Math.max(...run.errors.map((e) => `Row ${e.rowIndex}`.length));
        const actionWidth = Math.max(...run.errors.map((e) => e.actionId.length));
        for (const error of run.errors) {
            const rowLabel = `Row ${error.rowIndex}`.padEnd(rowWidth);
            const actionLabel = error.actionId.padEnd(actionWidth);
            lines.push(`  ${rowLabel}  ${actionLabel}  ${error.error}`);
        }
    }
    else if (errorsOnly) {
        lines.push("No errors.");
    }
    return lines.join("\n");
}
