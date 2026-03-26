import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRunState,
  generateRunId,
  listRuns,
  pruneRuns,
  readRunState,
  setRunsDir,
  writeRunState,
} from "../run-state.js";
import type { PipelineConfig } from "../types.js";

const testConfig: PipelineConfig = {
  version: "1",
  actions: [
    {
      id: "enrich_email",
      type: "http",
      target: "Email",
      method: "GET",
      url: "https://api.example.com/{{row.Domain}}",
      extract: "$.email",
    },
    {
      id: "score",
      type: "formula",
      target: "Score",
      expression: "row.Revenue > 1000 ? 'high' : 'low'",
    },
  ],
  settings: {
    concurrency: 1,
    rateLimit: 10,
    retryAttempts: 2,
    retryBackoff: "exponential",
  },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rowbound-test-"));
  setRunsDir(tmpDir);
});

afterEach(() => {
  setRunsDir(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generateRunId", () => {
  it("returns an 8-character hex string", () => {
    const id = generateRunId();
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns unique values across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRunId()));
    expect(ids.size).toBe(100);
  });
});

describe("createRunState", () => {
  it("initializes correctly from config", () => {
    const state = createRunState({
      sheetId: "sheet-123",
      sheetName: "Leads",
      config: testConfig,
      totalRows: 50,
      dryRun: false,
      range: "2:10",
      actionFilter: "enrich_email",
    });

    expect(state.runId).toHaveLength(8);
    expect(state.sheetId).toBe("sheet-123");
    expect(state.sheetName).toBe("Leads");
    expect(state.status).toBe("running");
    expect(state.startedAt).toBeTruthy();
    expect(new Date(state.startedAt).getTime()).not.toBeNaN();
    expect(state.dryRun).toBe(false);
    expect(state.totalRows).toBe(50);
    expect(state.processedRows).toBe(0);
    expect(state.errors).toEqual([]);
    expect(state.settings).toEqual({
      range: "2:10",
      actionFilter: "enrich_email",
      rateLimit: 10,
      retryAttempts: 2,
    });
  });

  it("creates action summaries from config actions", () => {
    const state = createRunState({
      sheetId: "sheet-123",
      config: testConfig,
      totalRows: 10,
      dryRun: true,
    });

    expect(state.actionSummaries).toHaveLength(2);
    expect(state.actionSummaries[0]).toEqual({
      actionId: "enrich_email",
      type: "http",
      target: "Email",
      success: 0,
      skipped: 0,
      errors: 0,
    });
    expect(state.actionSummaries[1]).toEqual({
      actionId: "score",
      type: "formula",
      target: "Score",
      success: 0,
      skipped: 0,
      errors: 0,
    });
  });
});

describe("writeRunState / readRunState", () => {
  it("roundtrips state correctly", async () => {
    const state = createRunState({
      sheetId: "sheet-abc",
      config: testConfig,
      totalRows: 5,
      dryRun: false,
    });

    await writeRunState(state);
    const loaded = await readRunState(state.runId);

    expect(loaded).toEqual(state);
  });

  it("readRunState returns null for nonexistent run", async () => {
    const result = await readRunState("00000000");
    expect(result).toBeNull();
  });

  it("readRunState throws for invalid run ID", async () => {
    await expect(readRunState("../etc/passwd")).rejects.toThrow(
      "Invalid run ID",
    );
    await expect(readRunState("nonexistent")).rejects.toThrow("Invalid run ID");
  });

  it("persists mutations to state", async () => {
    const state = createRunState({
      sheetId: "sheet-abc",
      config: testConfig,
      totalRows: 5,
      dryRun: false,
    });

    state.processedRows = 3;
    state.actionSummaries[0]!.success = 2;
    state.actionSummaries[0]!.skipped = 1;
    state.errors.push({
      rowIndex: 4,
      actionId: "enrich_email",
      error: "Timeout",
    });

    await writeRunState(state);
    const loaded = await readRunState(state.runId);

    expect(loaded!.processedRows).toBe(3);
    expect(loaded!.actionSummaries[0]!.success).toBe(2);
    expect(loaded!.errors).toHaveLength(1);
    expect(loaded!.errors[0]!.error).toBe("Timeout");
  });
});

describe("listRuns", () => {
  it("returns runs sorted by startedAt descending", async () => {
    const state1 = createRunState({
      sheetId: "sheet-1",
      config: testConfig,
      totalRows: 1,
      dryRun: false,
    });
    state1.startedAt = "2024-01-01T00:00:00.000Z";

    const state2 = createRunState({
      sheetId: "sheet-2",
      config: testConfig,
      totalRows: 1,
      dryRun: false,
    });
    state2.startedAt = "2024-01-03T00:00:00.000Z";

    const state3 = createRunState({
      sheetId: "sheet-1",
      config: testConfig,
      totalRows: 1,
      dryRun: false,
    });
    state3.startedAt = "2024-01-02T00:00:00.000Z";

    await writeRunState(state1);
    await writeRunState(state2);
    await writeRunState(state3);

    const runs = await listRuns();
    expect(runs).toHaveLength(3);
    expect(runs[0]!.runId).toBe(state2.runId);
    expect(runs[1]!.runId).toBe(state3.runId);
    expect(runs[2]!.runId).toBe(state1.runId);
  });

  it("filters by sheetId", async () => {
    const state1 = createRunState({
      sheetId: "sheet-A",
      config: testConfig,
      totalRows: 1,
      dryRun: false,
    });
    const state2 = createRunState({
      sheetId: "sheet-B",
      config: testConfig,
      totalRows: 1,
      dryRun: false,
    });

    await writeRunState(state1);
    await writeRunState(state2);

    const runs = await listRuns({ sheetId: "sheet-A" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sheetId).toBe("sheet-A");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      const state = createRunState({
        sheetId: "sheet-1",
        config: testConfig,
        totalRows: 1,
        dryRun: false,
      });
      await writeRunState(state);
    }

    const runs = await listRuns({ limit: 3 });
    expect(runs).toHaveLength(3);
  });

  it("defaults limit to 20", async () => {
    for (let i = 0; i < 25; i++) {
      const state = createRunState({
        sheetId: "sheet-1",
        config: testConfig,
        totalRows: 1,
        dryRun: false,
      });
      state.startedAt = new Date(2024, 0, i + 1).toISOString();
      await writeRunState(state);
    }

    const runs = await listRuns();
    expect(runs).toHaveLength(20);
  });

  it("returns empty array when no runs exist", async () => {
    const runs = await listRuns();
    expect(runs).toEqual([]);
  });
});

describe("pruneRuns", () => {
  it("keeps the most recent N runs and deletes the rest", async () => {
    const states = [];
    for (let i = 0; i < 5; i++) {
      const state = createRunState({
        sheetId: "sheet-1",
        config: testConfig,
        totalRows: 1,
        dryRun: false,
      });
      state.startedAt = new Date(2024, 0, i + 1).toISOString();
      await writeRunState(state);
      states.push(state);
    }

    const deleted = await pruneRuns(3);
    expect(deleted).toBe(2);

    // Most recent 3 should remain
    const remaining = await listRuns({ limit: 100 });
    expect(remaining).toHaveLength(3);

    const remainingIds = remaining.map((r) => r.runId);
    expect(remainingIds).toContain(states[4]!.runId);
    expect(remainingIds).toContain(states[3]!.runId);
    expect(remainingIds).toContain(states[2]!.runId);
    expect(remainingIds).not.toContain(states[0]!.runId);
    expect(remainingIds).not.toContain(states[1]!.runId);
  });

  it("returns 0 when nothing to prune", async () => {
    const state = createRunState({
      sheetId: "sheet-1",
      config: testConfig,
      totalRows: 1,
      dryRun: false,
    });
    await writeRunState(state);

    const deleted = await pruneRuns(10);
    expect(deleted).toBe(0);
  });
});
