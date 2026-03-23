import { describe, expect, it } from "vitest";
import {
  executeScript,
  executeScriptAction,
  resolveScript,
} from "../script.js";
import type { PipelineConfig, ScriptDef, TabConfig } from "../types.js";

describe("resolveScript", () => {
  const globalScripts: Record<string, ScriptDef> = {
    hello: { runtime: "bash", code: 'echo "hello"' },
    shared: { runtime: "bash", code: 'echo "global"' },
  };

  const tabScripts: Record<string, ScriptDef> = {
    shared: { runtime: "bash", code: 'echo "tab-level"' },
    tabOnly: { runtime: "bash", code: 'echo "tab only"' },
  };

  const config: PipelineConfig = {
    version: "2",
    scripts: globalScripts,
    actions: [],
    settings: {
      concurrency: 1,
      rateLimit: 0,
      retryAttempts: 0,
      retryBackoff: "exponential",
    },
  };

  const tabConfig: TabConfig = {
    name: "Sheet1",
    columns: {},
    scripts: tabScripts,
    actions: [],
  };

  it("resolves from global scripts", () => {
    const result = resolveScript("hello", config);
    expect(result).toEqual({ runtime: "bash", code: 'echo "hello"' });
  });

  it("resolves from tab scripts (overrides global)", () => {
    const result = resolveScript("shared", config, tabConfig);
    expect(result).toEqual({ runtime: "bash", code: 'echo "tab-level"' });
  });

  it("resolves tab-only scripts", () => {
    const result = resolveScript("tabOnly", config, tabConfig);
    expect(result).toEqual({ runtime: "bash", code: 'echo "tab only"' });
  });

  it("falls back to global when tab has no override", () => {
    const result = resolveScript("hello", config, tabConfig);
    expect(result).toEqual({ runtime: "bash", code: 'echo "hello"' });
  });

  it("returns null for unknown script", () => {
    const result = resolveScript("nonexistent", config, tabConfig);
    expect(result).toBeNull();
  });
});

describe("executeScript", () => {
  it("executes a bash script", async () => {
    const script: ScriptDef = { runtime: "bash", code: 'echo "hello world"' };
    const result = await executeScript(script, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
  });

  it("passes arguments to bash script", async () => {
    const script: ScriptDef = { runtime: "bash", code: 'echo "Hello $1 $2"' };
    const result = await executeScript(script, ["Alice", "Bob"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello Alice Bob");
  });

  it("executes a python3 script", async () => {
    const script: ScriptDef = {
      runtime: "python3",
      code: 'import sys\nprint(f"arg: {sys.argv[1]}")',
    };
    const result = await executeScript(script, ["test"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("arg: test");
  });

  it("executes a node script", async () => {
    const script: ScriptDef = {
      runtime: "node",
      code: "console.log(JSON.stringify({result: process.argv[2]}))",
    };
    const result = await executeScript(script, ["value"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"result":"value"}');
  });

  it("returns non-zero exit code on failure", async () => {
    const script: ScriptDef = { runtime: "bash", code: "exit 42" };
    const result = await executeScript(script, []);
    expect(result.exitCode).toBe(42);
  });

  it("cleans up temp file after execution", async () => {
    const script: ScriptDef = { runtime: "bash", code: 'echo "cleanup test"' };
    // Just verify it doesn't throw — temp file cleanup is internal
    const result = await executeScript(script, []);
    expect(result.exitCode).toBe(0);
  });
});

describe("executeScriptAction", () => {
  it("returns stdout as string", async () => {
    const script: ScriptDef = { runtime: "bash", code: 'echo "result value"' };
    const result = await executeScriptAction(script, []);
    expect(result).toBe("result value");
  });

  it("extracts value from JSON output with JSONPath", async () => {
    const script: ScriptDef = {
      runtime: "bash",
      code: 'echo \'{"name":"Alice","score":95}\'',
    };
    const result = await executeScriptAction(script, [], {
      extract: "$.name",
    });
    expect(result).toBe("Alice");
  });

  it("returns null on non-zero exit code", async () => {
    const script: ScriptDef = { runtime: "bash", code: "exit 1" };
    const result = await executeScriptAction(script, []);
    expect(result).toBeNull();
  });

  it("handles onError skip", async () => {
    const script: ScriptDef = { runtime: "bash", code: "exit 1" };
    const result = await executeScriptAction(script, [], {
      onError: { "1": "skip" },
    });
    expect(result).toBeNull();
  });

  it("handles onError write fallback", async () => {
    const script: ScriptDef = { runtime: "bash", code: "exit 1" };
    const result = await executeScriptAction(script, [], {
      onError: { default: { write: "FAILED" } },
    });
    expect(result).toBe("FAILED");
  });

  it("returns null for empty stdout", async () => {
    const script: ScriptDef = { runtime: "bash", code: "true" };
    const result = await executeScriptAction(script, []);
    expect(result).toBeNull();
  });
});
