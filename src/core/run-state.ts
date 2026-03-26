import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PipelineConfig } from "./types.js";

export interface ActionSummary {
  actionId: string;
  type: string; // "http" | "waterfall" | "formula" | "exec"
  target: string;
  success: number; // count of rows where action produced a value
  skipped: number; // count of rows where condition was false or value was null
  errors: number; // count of rows where action threw
}

export interface RunError {
  rowIndex: number; // sheet row number (not 0-indexed)
  actionId: string;
  error: string;
}

export interface RunState {
  runId: string;
  sheetId: string;
  sheetName?: string;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: string; // ISO 8601
  completedAt?: string; // ISO 8601
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

/** Validate that a runId is a legitimate 8-char hex string (prevents path traversal) */
function validateRunId(runId: string): void {
  if (!/^[a-f0-9]{8}$/.test(runId)) {
    throw new Error(
      `Invalid run ID "${runId}". Expected 8-character hex string.`,
    );
  }
}

/** Default runs directory under ~/.rowbound/runs */
let overrideRunsDir: string | undefined;

/**
 * Override the runs directory (for testing).
 * Pass undefined to reset to default.
 */
export function setRunsDir(dir: string | undefined): void {
  overrideRunsDir = dir;
}

/** Get the runs directory path, creating it if needed */
export async function getRunsDir(): Promise<string> {
  const dir = overrideRunsDir ?? path.join(os.homedir(), ".rowbound", "runs");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Generate a short run ID (8 chars, random hex) */
export function generateRunId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/** Write run state to disk */
export async function writeRunState(state: RunState): Promise<void> {
  validateRunId(state.runId);
  const filePath = path.join(await getRunsDir(), `${state.runId}.json`);
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

/** Read a specific run state */
export async function readRunState(runId: string): Promise<RunState | null> {
  validateRunId(runId);
  const filePath = path.join(await getRunsDir(), `${runId}.json`);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as RunState;
  } catch {
    return null;
  }
}

/** List all runs, sorted by startedAt descending (most recent first) */
export async function listRuns(options?: {
  sheetId?: string;
  limit?: number;
}): Promise<RunState[]> {
  const dir = await getRunsDir();
  const limit = options?.limit ?? 20;

  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const runs: RunState[] = [];
  for (const file of files) {
    try {
      const data = await fs.readFile(path.join(dir, file), "utf-8");
      const state = JSON.parse(data) as RunState;
      if (options?.sheetId && state.sheetId !== options.sheetId) {
        continue;
      }
      runs.push(state);
    } catch {
      // Skip corrupted files
    }
  }

  runs.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  return runs.slice(0, limit);
}

/** Delete old runs, keeping the most recent N. Returns number deleted. */
export async function pruneRuns(keep: number): Promise<number> {
  const dir = await getRunsDir();

  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }

  // Read and sort all runs by startedAt descending
  const runs: Array<{ file: string; startedAt: string }> = [];
  for (const file of files) {
    try {
      const data = await fs.readFile(path.join(dir, file), "utf-8");
      const state = JSON.parse(data) as RunState;
      runs.push({ file, startedAt: state.startedAt });
    } catch {
      // Corrupted files get deleted
      runs.push({ file, startedAt: "" });
    }
  }

  runs.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  let deleted = 0;
  for (let i = keep; i < runs.length; i++) {
    try {
      await fs.unlink(path.join(dir, runs[i]!.file));
      deleted++;
    } catch {
      // Ignore deletion errors
    }
  }

  return deleted;
}

/** Create a fresh RunState for a new pipeline run */
export function createRunState(options: {
  sheetId: string;
  sheetName?: string;
  config: PipelineConfig;
  totalRows: number;
  dryRun: boolean;
  range?: string;
  actionFilter?: string;
}): RunState {
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
