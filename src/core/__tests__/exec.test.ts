import { describe, expect, it } from "vitest";
import { executeCommand, executeExecAction } from "../exec.js";
import type { ExecAction, ExecutionContext } from "../types.js";

describe("executeCommand", () => {
  it("runs a simple command and returns stdout", async () => {
    const result = await executeCommand("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr", async () => {
    const result = await executeCommand("echo error >&2");
    expect(result.stderr.trim()).toBe("error");
    expect(result.exitCode).toBe(0);
  });

  it("handles command failure (non-zero exit)", async () => {
    const result = await executeCommand("exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("respects timeout", async () => {
    await expect(executeCommand("sleep 10", { timeout: 100 })).rejects.toThrow(
      /timed out/i,
    );
  }, 5000);

  it("passes environment variables to command", async () => {
    const result = await executeCommand("echo $MY_TEST_VAR", {
      env: { MY_TEST_VAR: "test_value" },
    });
    expect(result.stdout.trim()).toBe("test_value");
  });

  it("handles commands with pipes", async () => {
    const result = await executeCommand("echo 'hello world' | tr ' ' '_'");
    expect(result.stdout.trim()).toBe("hello_world");
  });

  it("handles command that produces JSON output", async () => {
    const result = await executeCommand('echo \'{"name":"Alice","age":30}\'');
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({ name: "Alice", age: 30 });
  });
});

describe("executeExecAction", () => {
  it("resolves templates in command", async () => {
    const action: ExecAction = {
      id: "test",
      type: "exec",
      target: "result",
      command: "echo {{row.name}}",
    };
    const context: ExecutionContext = {
      row: { name: "Alice" },
      env: {},
    };

    const result = await executeExecAction(action, context);
    expect(result).toBe("Alice");
  });

  it("resolves env templates in command", async () => {
    const action: ExecAction = {
      id: "test",
      type: "exec",
      target: "result",
      command: "echo {{env.GREETING}}",
    };
    const context: ExecutionContext = {
      row: {},
      env: { GREETING: "hello" },
    };

    const result = await executeExecAction(action, context);
    expect(result).toBe("hello");
  });

  it("returns raw stdout when no extract", async () => {
    const action: ExecAction = {
      id: "test",
      type: "exec",
      target: "result",
      command: "echo 'hello world'",
    };
    const context: ExecutionContext = { row: {}, env: {} };

    const result = await executeExecAction(action, context);
    expect(result).toBe("hello world");
  });

  it("extracts JSON with JSONPath when extract is set", async () => {
    const action: ExecAction = {
      id: "test",
      type: "exec",
      target: "result",
      command: 'echo \'{"name":"Alice","age":30}\'',
      extract: "$.name",
    };
    const context: ExecutionContext = { row: {}, env: {} };

    const result = await executeExecAction(action, context);
    expect(result).toBe("Alice");
  });

  it("returns null when extract produces empty result", async () => {
    const action: ExecAction = {
      id: "test",
      type: "exec",
      target: "result",
      command: 'echo \'{"name":"Alice"}\'',
      extract: "$.missing",
    };
    const context: ExecutionContext = { row: {}, env: {} };

    const result = await executeExecAction(action, context);
    expect(result).toBeNull();
  });

  it("throws when extract is set but output is not JSON", async () => {
    const action: ExecAction = {
      id: "test",
      type: "exec",
      target: "result",
      command: "echo 'not json'",
      extract: "$.name",
    };
    const context: ExecutionContext = { row: {}, env: {} };

    await expect(executeExecAction(action, context)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("returns null for empty stdout", async () => {
    const action: ExecAction = {
      id: "test",
      type: "exec",
      target: "result",
      command: "true",
    };
    const context: ExecutionContext = { row: {}, env: {} };

    const result = await executeExecAction(action, context);
    expect(result).toBeNull();
  });

  describe("onError handling", () => {
    it("returns null for 'skip' action on non-zero exit", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "exit 1",
        onError: { default: "skip" },
      };
      const context: ExecutionContext = { row: {}, env: {} };

      const result = await executeExecAction(action, context);
      expect(result).toBeNull();
    });

    it("returns fallback value for 'write' action", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "exit 1",
        onError: { "1": { write: "N/A" } },
      };
      const context: ExecutionContext = { row: {}, env: {} };

      const result = await executeExecAction(action, context);
      expect(result).toBe("N/A");
    });

    it("uses default key as catch-all", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "exit 42",
        onError: { default: { write: "error" } },
      };
      const context: ExecutionContext = { row: {}, env: {} };

      const result = await executeExecAction(action, context);
      expect(result).toBe("error");
    });

    it("prefers specific exit code over default", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "exit 2",
        onError: {
          "2": { write: "specific" },
          default: { write: "fallback" },
        },
      };
      const context: ExecutionContext = { row: {}, env: {} };

      const result = await executeExecAction(action, context);
      expect(result).toBe("specific");
    });

    it("throws when no onError config matches", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "exit 1",
      };
      const context: ExecutionContext = { row: {}, env: {} };

      await expect(executeExecAction(action, context)).rejects.toThrow(
        /Command failed with exit code 1/,
      );
    });

    it("handles onError for timeout errors", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "sleep 10",
        timeout: 0.1,
        onError: { default: { write: "timed out" } },
      };
      const context: ExecutionContext = { row: {}, env: {} };

      const result = await executeExecAction(action, context);
      expect(result).toBe("timed out");
    }, 5000);
  });

  describe("shell injection prevention", () => {
    it("escapes $() command substitution in row values", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "echo {{row.name}}",
      };
      const context: ExecutionContext = {
        row: { name: "$(echo INJECTED)" },
        env: {},
      };

      const result = await executeExecAction(action, context);
      // The value should be literal, not executed
      expect(result).toBe("$(echo INJECTED)");
    });

    it("escapes backtick command substitution in row values", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "echo {{row.name}}",
      };
      const context: ExecutionContext = {
        row: { name: "`echo INJECTED`" },
        env: {},
      };

      const result = await executeExecAction(action, context);
      expect(result).toBe("`echo INJECTED`");
    });

    it("escapes semicolons in row values", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "echo {{row.name}}",
      };
      const context: ExecutionContext = {
        row: { name: "; rm -rf /" },
        env: {},
      };

      const result = await executeExecAction(action, context);
      expect(result).toBe("; rm -rf /");
    });

    it("escapes pipe metacharacters in row values", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "echo {{row.name}}",
      };
      const context: ExecutionContext = {
        row: { name: "| cat /etc/passwd" },
        env: {},
      };

      const result = await executeExecAction(action, context);
      expect(result).toBe("| cat /etc/passwd");
    });

    it("escapes single quotes in row values", async () => {
      const action: ExecAction = {
        id: "test",
        type: "exec",
        target: "result",
        command: "echo {{row.name}}",
      };
      const context: ExecutionContext = {
        row: { name: "O'Brien" },
        env: {},
      };

      const result = await executeExecAction(action, context);
      expect(result).toBe("O'Brien");
    });
  });
});
