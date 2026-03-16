import type { PipelineConfig } from "./types.js";
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
export declare function buildSafeEnv(config?: PipelineConfig): Record<string, string>;
