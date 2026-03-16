import type { RunState } from "./run-state.js";
/**
 * Format milliseconds as a human-readable duration.
 * Examples: "12s", "1m30s", "2h5m"
 */
export declare function formatDuration(ms: number): string;
/**
 * Format an ISO date as a relative "age" string.
 * Examples: "just now", "5m ago", "2h ago", "3d ago", or "running" if status is running.
 */
export declare function formatAge(isoDate: string, status?: string): string;
/**
 * Format a list of runs as a compact table.
 *
 * ```
 * STATUS  RUN       SHEET        ROWS      UPDATES  ERRORS  DURATION  AGE
 * ✓       a1b2c3    EliteCart    30/30     28       0       12s       5m ago
 * ```
 */
export declare function formatRunList(runs: RunState[]): string;
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
export declare function formatRunDetail(run: RunState, errorsOnly?: boolean): string;
