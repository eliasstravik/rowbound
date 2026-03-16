import type { PipelineConfig } from "./types.js";
export interface ActionSummary {
    actionId: string;
    type: string;
    target: string;
    success: number;
    skipped: number;
    errors: number;
}
export interface RunError {
    rowIndex: number;
    actionId: string;
    error: string;
}
export interface RunState {
    runId: string;
    sheetId: string;
    sheetName?: string;
    status: "running" | "completed" | "failed" | "aborted";
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    dryRun: boolean;
    totalRows: number;
    processedRows: number;
    actionSummaries: ActionSummary[];
    errors: RunError[];
    settings: {
        range?: string;
        actionFilter?: string;
        rateLimit: number;
        retryAttempts: number;
    };
}
/**
 * Override the runs directory (for testing).
 * Pass undefined to reset to default.
 */
export declare function setRunsDir(dir: string | undefined): void;
/** Get the runs directory path, creating it if needed */
export declare function getRunsDir(): Promise<string>;
/** Generate a short run ID (8 chars, random hex) */
export declare function generateRunId(): string;
/** Write run state to disk */
export declare function writeRunState(state: RunState): Promise<void>;
/** Read a specific run state */
export declare function readRunState(runId: string): Promise<RunState | null>;
/** List all runs, sorted by startedAt descending (most recent first) */
export declare function listRuns(options?: {
    sheetId?: string;
    limit?: number;
}): Promise<RunState[]>;
/** Delete old runs, keeping the most recent N. Returns number deleted. */
export declare function pruneRuns(keep: number): Promise<number>;
/** Create a fresh RunState for a new pipeline run */
export declare function createRunState(options: {
    sheetId: string;
    sheetName?: string;
    config: PipelineConfig;
    totalRows: number;
    dryRun: boolean;
    range?: string;
    actionFilter?: string;
}): RunState;
