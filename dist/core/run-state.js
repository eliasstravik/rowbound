import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/** Validate that a runId is a legitimate 8-char hex string (prevents path traversal) */
function validateRunId(runId) {
    if (!/^[a-f0-9]{8}$/.test(runId)) {
        throw new Error(`Invalid run ID "${runId}". Expected 8-character hex string.`);
    }
}
/** Default runs directory under ~/.rowbound/runs */
let overrideRunsDir;
/**
 * Override the runs directory (for testing).
 * Pass undefined to reset to default.
 */
export function setRunsDir(dir) {
    overrideRunsDir = dir;
}
/** Get the runs directory path, creating it if needed */
export async function getRunsDir() {
    const dir = overrideRunsDir ?? path.join(os.homedir(), ".rowbound", "runs");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
}
/** Generate a short run ID (8 chars, random hex) */
export function generateRunId() {
    return crypto.randomBytes(4).toString("hex");
}
/** Write run state to disk */
export async function writeRunState(state) {
    validateRunId(state.runId);
    const filePath = path.join(await getRunsDir(), `${state.runId}.json`);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), {
        mode: 0o600,
    });
}
/** Read a specific run state */
export async function readRunState(runId) {
    validateRunId(runId);
    const filePath = path.join(await getRunsDir(), `${runId}.json`);
    try {
        const data = await fs.readFile(filePath, "utf-8");
        return JSON.parse(data);
    }
    catch {
        return null;
    }
}
/** List all runs, sorted by startedAt descending (most recent first) */
export async function listRuns(options) {
    const dir = await getRunsDir();
    const limit = options?.limit ?? 20;
    let files;
    try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    }
    catch {
        return [];
    }
    const runs = [];
    for (const file of files) {
        try {
            const data = await fs.readFile(path.join(dir, file), "utf-8");
            const state = JSON.parse(data);
            if (options?.sheetId && state.sheetId !== options.sheetId) {
                continue;
            }
            runs.push(state);
        }
        catch {
            // Skip corrupted files
        }
    }
    runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return runs.slice(0, limit);
}
/** Delete old runs, keeping the most recent N. Returns number deleted. */
export async function pruneRuns(keep) {
    const dir = await getRunsDir();
    let files;
    try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    }
    catch {
        return 0;
    }
    // Read and sort all runs by startedAt descending
    const runs = [];
    for (const file of files) {
        try {
            const data = await fs.readFile(path.join(dir, file), "utf-8");
            const state = JSON.parse(data);
            runs.push({ file, startedAt: state.startedAt });
        }
        catch {
            // Corrupted files get deleted
            runs.push({ file, startedAt: "" });
        }
    }
    runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    let deleted = 0;
    for (let i = keep; i < runs.length; i++) {
        try {
            await fs.unlink(path.join(dir, runs[i].file));
            deleted++;
        }
        catch {
            // Ignore deletion errors
        }
    }
    return deleted;
}
/** Create a fresh RunState for a new pipeline run */
export function createRunState(options) {
    return {
        runId: generateRunId(),
        sheetId: options.sheetId,
        sheetName: options.sheetName,
        status: "running",
        startedAt: new Date().toISOString(),
        dryRun: options.dryRun,
        totalRows: options.totalRows,
        processedRows: 0,
        actionSummaries: options.config.actions.map((action) => ({
            actionId: action.id,
            type: action.type,
            target: action.target,
            success: 0,
            skipped: 0,
            errors: 0,
        })),
        errors: [],
        settings: {
            range: options.range,
            actionFilter: options.actionFilter,
            rateLimit: options.config.settings.rateLimit,
            retryAttempts: options.config.settings.retryAttempts,
        },
    };
}
