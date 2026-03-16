import type { ExecAction, ExecutionContext } from "./types.js";
export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/**
 * Execute a shell command and capture its output.
 *
 * Uses execFile('/bin/sh', ['-c', command]) for shell features (pipes, env vars)
 * while staying consistent with the codebase's execFile pattern.
 */
export declare function executeCommand(command: string, options?: {
    timeout?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
}): Promise<ExecResult>;
/**
 * Execute an exec action: resolve templates in the command, run it,
 * optionally extract a value from JSON output, and handle errors.
 */
export declare function executeExecAction(action: ExecAction, context: ExecutionContext, options?: {
    signal?: AbortSignal;
}): Promise<string | null>;
