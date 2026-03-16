/**
 * Build a filtered environment object that only includes safe variables.
 *
 * Instead of leaking all of process.env into the pipeline context, this
 * function constructs a minimal env by:
 * 1. Including all ROWBOUND_* prefixed vars
 * 2. Scanning config template strings for {{env.X}} references and
 *    including those specific keys from process.env
 * 3. Including NODE_ENV if set
 * 4. Including PATH so child processes can find executables
 */
export function buildSafeEnv(config) {
    const env = {};
    // 1. ROWBOUND_* prefixed vars
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key.startsWith("ROWBOUND_")) {
            env[key] = value;
        }
    }
    // 2. NODE_ENV
    if (process.env.NODE_ENV !== undefined) {
        env.NODE_ENV = process.env.NODE_ENV;
    }
    // 3. PATH so child processes can find executables
    if (process.env.PATH !== undefined) {
        env.PATH = process.env.PATH;
    }
    // 4. Scan config templates for {{env.X}} references
    if (config) {
        const referencedKeys = extractEnvReferences(config);
        for (const key of referencedKeys) {
            if (process.env[key] !== undefined) {
                env[key] = process.env[key];
            }
        }
    }
    return env;
}
/**
 * Scan all template strings in a PipelineConfig for {{env.X}} patterns
 * and return the set of referenced env var names.
 */
function extractEnvReferences(config) {
    const keys = new Set();
    const ENV_REGEX = /\{\{env\.([^}]+)\}\}/g;
    function scanValue(value) {
        if (typeof value === "string") {
            for (const match of value.matchAll(ENV_REGEX)) {
                keys.add(match[1]);
            }
        }
        else if (Array.isArray(value)) {
            for (const item of value) {
                scanValue(item);
            }
        }
        else if (value !== null && typeof value === "object") {
            for (const v of Object.values(value)) {
                scanValue(v);
            }
        }
    }
    // Scan top-level actions
    scanValue(config.actions);
    // Scan per-tab actions
    if (config.tabs) {
        for (const tab of Object.values(config.tabs)) {
            scanValue(tab.actions);
        }
    }
    return keys;
}
