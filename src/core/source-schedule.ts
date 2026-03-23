import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** State for a single source's schedule */
export interface ScheduleEntry {
  lastRunAt: string; // ISO 8601
  lastStatus: "completed" | "failed";
  rowsCreated: number;
}

/** All schedule state, keyed by "spreadsheetId:tabGid:sourceId" */
export type ScheduleState = Record<string, ScheduleEntry>;

const SCHEDULE_DIR = path.join(os.homedir(), ".rowbound");
const SCHEDULE_FILE = path.join(SCHEDULE_DIR, "schedules.json");

/** Read schedule state from disk */
export function readScheduleState(): ScheduleState {
  try {
    const raw = fs.readFileSync(SCHEDULE_FILE, "utf-8");
    return JSON.parse(raw) as ScheduleState;
  } catch {
    return {};
  }
}

/** Write schedule state to disk */
export function writeScheduleState(state: ScheduleState): void {
  fs.mkdirSync(SCHEDULE_DIR, { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(state, null, 2));
}

/** Build the key for a schedule entry */
export function scheduleKey(
  spreadsheetId: string,
  tabGid: string,
  sourceId: string,
): string {
  return `${spreadsheetId}:${tabGid}:${sourceId}`;
}

/** Update the schedule entry for a source after a run */
export function updateScheduleEntry(
  spreadsheetId: string,
  tabGid: string,
  sourceId: string,
  status: "completed" | "failed",
  rowsCreated: number,
): void {
  const state = readScheduleState();
  const key = scheduleKey(spreadsheetId, tabGid, sourceId);
  state[key] = {
    lastRunAt: new Date().toISOString(),
    lastStatus: status,
    rowsCreated,
  };
  writeScheduleState(state);
}

/** Schedule intervals in milliseconds */
const SCHEDULE_INTERVALS: Record<string, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Check if a scheduled source is due to run.
 * Returns true if the source should run now.
 */
export function isSourceDue(
  schedule: string | undefined,
  lastRunAt: string | undefined,
): boolean {
  if (!schedule || schedule === "manual") return false;

  const intervalMs = SCHEDULE_INTERVALS[schedule];
  if (!intervalMs) return false; // unknown schedule or cron (not yet supported)

  if (!lastRunAt) return true; // never run before

  const elapsed = Date.now() - new Date(lastRunAt).getTime();
  return elapsed >= intervalMs;
}
