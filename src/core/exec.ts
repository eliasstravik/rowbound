import { execFile } from "node:child_process";
import { extractValue } from "./extractor.js";
import { shellEscape } from "./shell-escape.js";
import { resolveTemplateEscaped } from "./template.js";
import type { ExecAction, ExecutionContext, OnErrorConfig } from "./types.js";

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
export async function executeCommand(
  command: string,
  options: {
    timeout?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
  } = {},
): Promise<ExecResult> {
  const { timeout = 30_000, signal, env } = options;

  return new Promise<ExecResult>((resolve, reject) => {
    const childEnv = env ?? {};

    const child = execFile(
      "/bin/sh",
      ["-c", command],
      {
        timeout,
        signal,
        env: childEnv as NodeJS.ProcessEnv,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
      (error, stdout, stderr) => {
        if (error) {
          // Cast to access killed and code properties from ExecException
          const execError = error as Error & {
            killed?: boolean;
            code?: number | string;
            signal?: string;
          };

          // Check if it was killed by timeout or signal
          if (execError.killed || error.message?.includes("TIMEOUT")) {
            reject(new Error(`Command timed out after ${timeout}ms`));
            return;
          }

          // If signal was aborted
          if (signal?.aborted) {
            reject(new Error("Command aborted"));
            return;
          }

          // Non-zero exit code — resolve with the exit code and captured output
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            exitCode: typeof execError.code === "number" ? execError.code : 1,
          });
          return;
        }

        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: 0,
        });
      },
    );

    // Handle abort signal — kill the entire process group so grandchildren
    // (e.g. headless Claude) are also terminated, not just the /bin/sh wrapper.
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          try {
            if (child.pid) {
              process.kill(-child.pid, "SIGTERM");
            }
          } catch {
            child.kill();
          }
        },
        { once: true },
      );
    }
  });
}

/**
 * Resolve the onError action for a given exit code.
 * Checks the specific exit code first, then falls back to "default".
 */
function resolveErrorAction(
  onError: OnErrorConfig | undefined,
  exitCode: number,
): string | { write: string } | undefined {
  if (!onError) return undefined;

  const codeKey = String(exitCode);
  if (codeKey in onError) {
    return onError[codeKey];
  }
  if ("default" in onError) {
    return onError.default;
  }
  return undefined;
}

/**
 * Apply the resolved error action, returning a fallback value or throwing.
 */
function applyErrorAction(
  action: string | { write: string } | undefined,
  exitCode: number,
  stderr: string,
): string | null {
  if (action === undefined) {
    throw new Error(
      `Command failed with exit code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`,
    );
  }

  if (action === "skip") {
    return null;
  }

  if (typeof action === "object" && "write" in action) {
    return action.write;
  }

  // Unknown action — treat as skip
  return null;
}

/**
 * Execute an exec action: resolve templates in the command, run it,
 * optionally extract a value from JSON output, and handle errors.
 */
export async function executeExecAction(
  action: ExecAction,
  context: ExecutionContext,
  options: { signal?: AbortSignal } = {},
): Promise<string | null> {
  const resolvedCommand = resolveTemplateEscaped(
    action.command,
    context,
    shellEscape,
  );

  let result: ExecResult;
  try {
    result = await executeCommand(resolvedCommand, {
      timeout: action.timeout ? action.timeout * 1000 : undefined,
      signal: options.signal,
      env: context.env,
    });
  } catch (error) {
    // Timeout or abort errors
    const errorAction = resolveErrorAction(action.onError, 1);
    return applyErrorAction(
      errorAction,
      1,
      error instanceof Error ? error.message : String(error),
    );
  }

  // Non-zero exit code
  if (result.exitCode !== 0) {
    const errorAction = resolveErrorAction(action.onError, result.exitCode);
    return applyErrorAction(errorAction, result.exitCode, result.stderr);
  }

  // Success — extract or return raw stdout
  if (action.extract) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `Exec action "${action.id}": output is not valid JSON for extraction`,
      );
    }
    const value = extractValue(parsed, action.extract);
    return value !== "" ? value : null;
  }

  const trimmed = result.stdout.trim();
  return trimmed !== "" ? trimmed : null;
}
