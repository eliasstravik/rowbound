import { pruneRuns, writeRunState } from "./run-state.js";
/**
 * Create callback hooks that track run state and write to disk.
 *
 * The returned callbacks should be composed with any user-provided callbacks,
 * not replace them.
 */
export function createRunTracker(state) {
    const startTime = Date.now();
    return {
        onRowStart: (_rowIndex, _row) => {
            // No-op — reserved for future row-level tracking
        },
        onActionComplete: (_rowIndex, actionId, value) => {
            const action = state.actionSummaries.find((s) => s.actionId === actionId);
            if (!action)
                return;
            if (value !== null) {
                action.success++;
            }
            else {
                action.skipped++;
            }
        },
        onError: (rowIndex, actionId, error) => {
            const action = state.actionSummaries.find((s) => s.actionId === actionId);
            if (action) {
                action.errors++;
            }
            state.errors.push({
                rowIndex: rowIndex + 2, // Convert 0-indexed data row to sheet row number
                actionId,
                error: error.message,
            });
        },
        onRowComplete: (_rowIndex, _updates) => {
            state.processedRows++;
            // Fire-and-forget: checkpoint save after each row (best-effort)
            writeRunState(state).catch(() => { });
        },
        finalize: async (aborted) => {
            if (aborted) {
                state.status = "aborted";
            }
            else if (state.errors.length > 0 && state.processedRows === 0) {
                state.status = "failed";
            }
            else {
                state.status = "completed";
            }
            state.completedAt = new Date().toISOString();
            state.durationMs = Date.now() - startTime;
            await writeRunState(state);
            await pruneRuns(50);
        },
    };
}
