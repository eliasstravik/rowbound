import type { PipelineConfig, TabConfig } from "./types.js";
/**
 * Resolve a tab by name in a v2 config.
 * Returns the GID key and TabConfig, or null if not found.
 */
export declare function resolveTabGid(config: PipelineConfig, tabName: string): {
    gid: string;
    tab: TabConfig;
} | null;
/**
 * Get the tab config for a given tab name, handling single-tab defaults.
 * For v1 configs, returns a synthetic TabConfig from top-level fields.
 */
export declare function getTabConfig(config: PipelineConfig, tabName?: string): {
    gid: string;
    tab: TabConfig;
};
