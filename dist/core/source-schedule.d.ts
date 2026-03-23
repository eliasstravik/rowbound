/** State for a single source's schedule */
export interface ScheduleEntry {
    lastRunAt: string;
    lastStatus: "completed" | "failed";
    rowsCreated: number;
}
/** All schedule state, keyed by "spreadsheetId:tabGid:sourceId" */
export type ScheduleState = Record<string, ScheduleEntry>;
/** Read schedule state from disk */
export declare function readScheduleState(): ScheduleState;
/** Write schedule state to disk */
export declare function writeScheduleState(state: ScheduleState): void;
/** Build the key for a schedule entry */
export declare function scheduleKey(spreadsheetId: string, tabGid: string, sourceId: string): string;
/** Update the schedule entry for a source after a run */
export declare function updateScheduleEntry(spreadsheetId: string, tabGid: string, sourceId: string, status: "completed" | "failed", rowsCreated: number): void;
/**
 * Check if a scheduled source is due to run.
 * Returns true if the source should run now.
 */
export declare function isSourceDue(schedule: string | undefined, lastRunAt: string | undefined): boolean;
