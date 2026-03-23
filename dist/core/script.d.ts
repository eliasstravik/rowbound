import type { OnErrorConfig, PipelineConfig, ScriptDef, TabConfig } from "./types.js";
export interface ScriptExecOptions {
    env?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
}
export interface ScriptExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/**
 * Resolve a script name to its definition.
 * Checks tab-level scripts first, then global scripts.
 */
export declare function resolveScript(name: string, config: PipelineConfig, tabConfig?: TabConfig | null): ScriptDef | null;
/**
 * Execute a script by writing it to a temp file and running it.
 *
 * The script's `code` is written to a temp file with the appropriate shebang,
 * made executable, and run with the given args. Stdout is captured and returned.
 */
export declare function executeScript(scriptDef: ScriptDef, args: string[], options?: ScriptExecOptions): Promise<ScriptExecResult>;
/**
 * Execute a script and optionally extract a value from its JSON output.
 * Returns the stdout (or extracted value) as a string, or null on failure.
 */
export declare function executeScriptAction(scriptDef: ScriptDef, args: string[], options?: ScriptExecOptions & {
    extract?: string;
    onError?: OnErrorConfig;
}): Promise<string | null>;
