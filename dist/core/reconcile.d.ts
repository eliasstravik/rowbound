import type { SheetsAdapter } from "../adapters/sheets/sheets-adapter.js";
import type { PipelineConfig, SheetRef, TabConfig } from "./types.js";
export interface ReconcileResult {
    /** Updated config — always v2 format */
    config: PipelineConfig;
    /** The GID of the tab being operated on */
    tabGid: string;
    /** The specific tab's config (convenience) */
    tabConfig: TabConfig;
    /** User-facing messages about detected changes */
    messages: string[];
    /** Whether the config was modified and needs re-saving */
    configChanged: boolean;
}
/**
 * Reconcile a pipeline config with the current sheet state.
 *
 * This function handles:
 * 1. v1 → v2 migration (wraps top-level actions/columns under the resolved GID)
 * 2. Tab name reconciliation (detects renamed tabs by GID)
 * 3. Column reconciliation for the target tab (named ranges, renames, new columns)
 * 4. Action target migration from column names to IDs
 */
export declare function reconcile(adapter: SheetsAdapter, ref: SheetRef, config: PipelineConfig): Promise<ReconcileResult>;
