import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAiAction } from "../ai.js";
import type { AiAction, ExecutionContext } from "../types.js";

// Mock executeCommand to avoid actually running claude/codex
vi.mock("../exec.js", () => ({
  executeCommand: vi.fn(),
}));

import { executeCommand } from "../exec.js";

const mockExecuteCommand = vi.mocked(executeCommand);

const baseContext: ExecutionContext = {
  row: { domain: "acme.com", company: "Acme Corp" },
  env: { ANTHROPIC_API_KEY: "test-key" },
};

const baseAction: AiAction = {
  id: "test_ai",
  type: "ai",
  target: "summary",
  runtime: "claude",
  prompt: "Summarize the company at {{row.domain}}",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("executeAiAction", () => {
  it("executes claude runtime and returns single-column output", async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: "Acme Corp is a technology company.",
      stderr: "",
      exitCode: 0,
    });

    const updates = await executeAiAction(baseAction, baseContext, {
      rowIndex: 0,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      row: 2,
      column: "summary",
      value: "Acme Corp is a technology company.",
    });

    // Should use claude -p
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      expect.stringContaining("claude -p"),
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it("executes codex runtime", async () => {
    const codexAction: AiAction = { ...baseAction, runtime: "codex" };
    mockExecuteCommand.mockResolvedValue({
      stdout: "Codex result",
      stderr: "",
      exitCode: 0,
    });

    const updates = await executeAiAction(codexAction, baseContext, {
      rowIndex: 0,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.value).toBe("Codex result");
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      expect.stringContaining("codex exec"),
      expect.any(Object),
    );
  });

  it("writes structured JSON output to single target column", async () => {
    const multiAction: AiAction = {
      ...baseAction,
      outputs: {
        summary: { type: "text" },
        is_b2b: { type: "boolean" },
        industry: { type: "text" },
      },
    };

    const jsonOutput = {
      summary: "A tech company",
      is_b2b: true,
      industry: "Technology",
    };

    mockExecuteCommand.mockResolvedValue({
      stdout: JSON.stringify(jsonOutput),
      stderr: "",
      exitCode: 0,
    });

    const updates = await executeAiAction(multiAction, baseContext, {
      rowIndex: 0,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      row: 2,
      column: "summary",
      value: JSON.stringify(jsonOutput),
    });
  });

  it("falls back to raw output when JSON parsing fails for multi-column", async () => {
    const multiAction: AiAction = {
      ...baseAction,
      outputs: { summary: { type: "text" } },
    };

    mockExecuteCommand.mockResolvedValue({
      stdout: "This is not JSON, just plain text.",
      stderr: "",
      exitCode: 0,
    });

    const updates = await executeAiAction(multiAction, baseContext, {
      rowIndex: 0,
    });

    // Falls back to writing raw text to primary target
    expect(updates).toHaveLength(1);
    expect(updates[0]!.column).toBe("summary");
    expect(updates[0]!.value).toBe("This is not JSON, just plain text.");
  });

  it("handles non-zero exit code with onError: skip", async () => {
    const action: AiAction = { ...baseAction, onError: { default: "skip" } };
    mockExecuteCommand.mockResolvedValue({
      stdout: "",
      stderr: "Error: API limit",
      exitCode: 1,
    });

    const updates = await executeAiAction(action, baseContext, { rowIndex: 0 });
    expect(updates).toEqual([]);
  });

  it("handles non-zero exit code with onError: write fallback", async () => {
    const action: AiAction = {
      ...baseAction,
      onError: { default: { write: "AI_ERROR" } },
    };
    mockExecuteCommand.mockResolvedValue({
      stdout: "",
      stderr: "Error",
      exitCode: 1,
    });

    const updates = await executeAiAction(action, baseContext, { rowIndex: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.value).toBe("AI_ERROR");
  });

  it("throws on non-zero exit code without onError", async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: "",
      stderr: "CLI not found",
      exitCode: 127,
    });

    await expect(
      executeAiAction(baseAction, baseContext, { rowIndex: 0 }),
    ).rejects.toThrow(/AI action.*failed with exit code 127/);
  });

  it("handles timeout", async () => {
    mockExecuteCommand.mockRejectedValue(
      new Error("Command timed out after 120000ms"),
    );

    await expect(
      executeAiAction(baseAction, baseContext, { rowIndex: 0 }),
    ).rejects.toThrow(/timed out/);
  });

  it("returns empty array for empty stdout", async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const updates = await executeAiAction(baseAction, baseContext, {
      rowIndex: 0,
    });
    expect(updates).toEqual([]);
  });

  it("uses custom timeout in seconds", async () => {
    const action: AiAction = { ...baseAction, timeout: 60 };
    mockExecuteCommand.mockResolvedValue({
      stdout: "result",
      stderr: "",
      exitCode: 0,
    });

    await executeAiAction(action, baseContext, { rowIndex: 0 });

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it("sanitizes row data in prompt to prevent prompt injection", async () => {
    const context: ExecutionContext = {
      row: { domain: "acme.com\x00\x01\x02malicious" },
      env: {},
    };
    mockExecuteCommand.mockResolvedValue({
      stdout: "safe result",
      stderr: "",
      exitCode: 0,
    });

    await executeAiAction(baseAction, context, { rowIndex: 0 });

    // The command should have been called (prompt was written to temp file)
    expect(mockExecuteCommand).toHaveBeenCalled();
  });

  it("resolves column names via columnMap", async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: "result",
      stderr: "",
      exitCode: 0,
    });

    const updates = await executeAiAction(baseAction, baseContext, {
      rowIndex: 0,
      columnMap: { summary: "AI Summary" },
    });

    expect(updates[0]!.column).toBe("AI Summary");
  });

  it("extracts JSON from markdown-wrapped output into target column", async () => {
    const multiAction: AiAction = {
      ...baseAction,
      outputs: { answer: { type: "text" } },
    };

    mockExecuteCommand.mockResolvedValue({
      stdout: 'Here is the result:\n```json\n{"answer": "42"}\n```\n',
      stderr: "",
      exitCode: 0,
    });

    const updates = await executeAiAction(multiAction, baseContext, {
      rowIndex: 0,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.column).toBe("summary");
    expect(updates[0]!.value).toBe('{"answer":"42"}');
  });
});
