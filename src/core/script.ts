import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractValue } from "./extractor.js";
import type {
  OnErrorConfig,
  PipelineConfig,
  ScriptDef,
  TabConfig,
} from "./types.js";

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
export function resolveScript(
  name: string,
  config: PipelineConfig,
  tabConfig?: TabConfig | null,
): ScriptDef | null {
  // Tab-level scripts take precedence
  if (tabConfig?.scripts?.[name]) {
    return tabConfig.scripts[name];
  }
  // Fall back to global scripts
  if (config.scripts?.[name]) {
    return config.scripts[name];
  }
  return null;
}

/**
 * Execute a script by writing it to a temp file and running it.
 *
 * The script's `code` is written to a temp file with the appropriate shebang,
 * made executable, and run with the given args. Stdout is captured and returned.
 */
export async function executeScript(
  scriptDef: ScriptDef,
  args: string[],
  options: ScriptExecOptions = {},
): Promise<ScriptExecResult> {
  const { timeout = 30_000, signal, env } = options;

  // Write script to temp file
  const shebangMap: Record<string, string> = {
    bash: "#!/usr/bin/env bash",
    python3: "#!/usr/bin/env python3",
    node: "#!/usr/bin/env node",
  };

  const shebang = shebangMap[scriptDef.runtime] ?? "#!/usr/bin/env bash";
  const tmpDir = os.tmpdir();
  const ext =
    scriptDef.runtime === "python3"
      ? ".py"
      : scriptDef.runtime === "node"
        ? ".mjs"
        : ".sh";
  const tmpFile = path.join(
    tmpDir,
    `rowbound_script_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`,
  );

  const scriptContent = `${shebang}\n${scriptDef.code}\n`;
  fs.writeFileSync(tmpFile, scriptContent, { mode: 0o755 });

  try {
    return await new Promise<ScriptExecResult>((resolve, reject) => {
      const child = execFile(
        tmpFile,
        args,
        {
          timeout,
          signal,
          env: env
            ? ({ ...process.env, ...env } as NodeJS.ProcessEnv)
            : (process.env as NodeJS.ProcessEnv),
          maxBuffer: 10 * 1024 * 1024, // 10MB
        },
        (error, stdout, stderr) => {
          if (error) {
            const execError = error as Error & {
              killed?: boolean;
              code?: number | string;
              signal?: string;
            };

            if (execError.killed || execError.signal === "SIGTERM") {
              reject(new Error(`Script timed out after ${timeout}ms`));
              return;
            }

            resolve({
              stdout: stdout?.toString() ?? "",
              stderr: stderr?.toString() ?? "",
              exitCode: typeof execError.code === "number" ? execError.code : 1,
            });
            return;
          }

          resolve({
            stdout: stdout?.toString().trim() ?? "",
            stderr: stderr?.toString() ?? "",
            exitCode: 0,
          });
        },
      );

      // Kill entire process group on abort
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGTERM");
              } catch {
                child.kill("SIGTERM");
              }
            }
          },
          { once: true },
        );
      }
    });
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Execute a script and optionally extract a value from its JSON output.
 * Returns the stdout (or extracted value) as a string, or null on failure.
 */
export async function executeScriptAction(
  scriptDef: ScriptDef,
  args: string[],
  options: ScriptExecOptions & {
    extract?: string;
    onError?: OnErrorConfig;
  } = {},
): Promise<string | null> {
  const result = await executeScript(scriptDef, args, options);

  if (result.exitCode !== 0) {
    // Check onError config
    const errorKey = String(result.exitCode);
    const onError = options?.onError;
    if (onError) {
      const handler = onError[errorKey] ?? onError.default;
      if (handler === "skip") return null;
      if (typeof handler === "object" && "write" in handler)
        return handler.write;
    }
    return null;
  }

  const stdout = result.stdout;
  if (!stdout) return null;

  // If extract is set, parse as JSON and extract with JSONPath
  if (options?.extract) {
    try {
      const parsed = JSON.parse(stdout);
      const extracted = extractValue(parsed, options.extract);
      return extracted || null;
    } catch {
      // Not valid JSON — return raw stdout
      return stdout;
    }
  }

  return stdout;
}
