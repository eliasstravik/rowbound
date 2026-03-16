/**
 * Resolve a tab by name in a v2 config.
 * Returns the GID key and TabConfig, or null if not found.
 */
export function resolveTabGid(config, tabName) {
    if (!config.tabs)
        return null;
    for (const [gid, tab] of Object.entries(config.tabs)) {
        if (tab.name === tabName) {
            return { gid, tab };
        }
    }
    return null;
}
/**
 * Get the tab config for a given tab name, handling single-tab defaults.
 * For v1 configs, returns a synthetic TabConfig from top-level fields.
 */
export function getTabConfig(config, tabName) {
    if (config.tabs) {
        const entries = Object.entries(config.tabs);
        if (tabName) {
            const resolved = resolveTabGid(config, tabName);
            if (!resolved) {
                throw new Error(`Tab "${tabName}" not found. Available: ${entries.map(([, t]) => t.name).join(", ")}`);
            }
            return resolved;
        }
        if (entries.length === 1) {
            const [gid, tab] = entries[0];
            return { gid, tab };
        }
        throw new Error(`Multiple tabs configured. Specify tab. Available: ${entries.map(([, t]) => t.name).join(", ")}`);
    }
    // v1 fallback
    return {
        gid: "0",
        tab: {
            name: tabName || "Sheet1",
            columns: config.columns ?? {},
            actions: config.actions ?? [],
        },
    };
}
