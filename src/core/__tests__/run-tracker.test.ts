import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunState, readRunState, setRunsDir } from "../run-state.js";
import { createRunTracker } from "../run-tracker.js";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rowbound-tracker-test-"));
  setRunsDir(tmpDir);
});

afterEach(() => {
  setRunsDir(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeState() {
  return createRunState({
    sheetId: "sheet-123",
    config: testConfig,
    totalRows: 10,
    dryRun: false,
  });
}

/** Wait for pending microtasks / next tick so fire-and-forget writes complete */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

describe("createRunTracker", () => {
  describe("onActionComplete", () => {
    it("increments success count when value is non-null", () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onActionComplete(0, "enrich_email", "test@example.com");

      expect(state.actionSummaries[0]!.success).toBe(1);
      expect(state.actionSummaries[0]!.skipped).toBe(0);
    });

    it("increments skipped count when value is null", () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onActionComplete(0, "enrich_email", null);

      expect(state.actionSummaries[0]!.skipped).toBe(1);
      expect(state.actionSummaries[0]!.success).toBe(0);
    });

    it("handles unknown actionId gracefully", () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      // Should not throw
      tracker.onActionComplete(0, "nonexistent_action", "value");
      expect(state.actionSummaries[0]!.success).toBe(0);
    });

    it("tracks multiple actions independently", () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onActionComplete(0, "enrich_email", "test@example.com");
      tracker.onActionComplete(0, "score", null);
      tracker.onActionComplete(1, "enrich_email", null);
      tracker.onActionComplete(1, "score", "high");

      expect(state.actionSummaries[0]!.success).toBe(1);
      expect(state.actionSummaries[0]!.skipped).toBe(1);
      expect(state.actionSummaries[1]!.success).toBe(1);
      expect(state.actionSummaries[1]!.skipped).toBe(1);
    });
  });

  describe("onError", () => {
    it("increments action error count", () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onError(0, "enrich_email", new Error("Timeout"));

      expect(state.actionSummaries[0]!.errors).toBe(1);
    });

    it("adds error with correct sheet row number (rowIndex + 2)", () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onError(0, "enrich_email", new Error("Timeout"));
      tracker.onError(3, "score", new Error("Expression failed"));

      expect(state.errors).toHaveLength(2);
      // rowIndex 0 -> sheet row 2 (row 1 is headers)
      expect(state.errors[0]).toEqual({
        rowIndex: 2,
        actionId: "enrich_email",
        error: "Timeout",
      });
      // rowIndex 3 -> sheet row 5
      expect(state.errors[1]).toEqual({
        rowIndex: 5,
        actionId: "score",
        error: "Expression failed",
      });
    });
  });

  describe("onRowComplete", () => {
    it("increments processedRows", () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onRowComplete(0, []);
      expect(state.processedRows).toBe(1);

      tracker.onRowComplete(1, []);
      expect(state.processedRows).toBe(2);
    });

    it("writes state to disk on each call", async () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onRowComplete(0, []);
      // Wait for fire-and-forget write to complete
      await tick();

      const loaded = await readRunState(state.runId);
      expect(loaded).not.toBeNull();
      expect(loaded!.processedRows).toBe(1);

      tracker.onRowComplete(1, []);
      await tick();

      const loaded2 = await readRunState(state.runId);
      expect(loaded2!.processedRows).toBe(2);
    });
  });

  describe("onRowStart", () => {
    it("is a no-op that does not throw", () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      expect(() =>
        tracker.onRowStart(0, { Name: "Alice", Domain: "example.com" }),
      ).not.toThrow();
    });
  });

  describe("finalize", () => {
    it("sets status to 'completed' on normal finish", async () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onRowComplete(0, []);
      await tracker.finalize(false);

      expect(state.status).toBe("completed");
      expect(state.completedAt).toBeTruthy();
      expect(state.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("sets status to 'aborted' when aborted=true", async () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onRowComplete(0, []);
      await tracker.finalize(true);

      expect(state.status).toBe("aborted");
    });

    it("sets status to 'failed' when errors exist and processedRows is 0", async () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onError(0, "enrich_email", new Error("Connection refused"));
      // Note: no onRowComplete calls, so processedRows stays 0
      await tracker.finalize(false);

      expect(state.status).toBe("failed");
    });

    it("sets status to 'completed' when errors exist but rows were processed", async () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      tracker.onError(0, "enrich_email", new Error("Timeout"));
      tracker.onRowComplete(0, []);
      await tracker.finalize(false);

      expect(state.status).toBe("completed");
    });

    it("sets completedAt and durationMs", async () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      await tracker.finalize(false);

      expect(state.completedAt).toBeTruthy();
      expect(new Date(state.completedAt!).getTime()).not.toBeNaN();
      expect(typeof state.durationMs).toBe("number");
      expect(state.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("writes final state to disk", async () => {
      const state = makeState();
      const tracker = createRunTracker(state);

      await tracker.finalize(false);

      const loaded = await readRunState(state.runId);
      expect(loaded!.status).toBe("completed");
      expect(loaded!.completedAt).toBeTruthy();
    });

    it("prunes old runs (keeps 50)", async () => {
      // Create 52 runs
      for (let i = 0; i < 52; i++) {
        const s = makeState();
        s.startedAt = new Date(2024, 0, i + 1).toISOString();
        s.status = "completed";
        // Write using the run-state module directly
        const filePath = path.join(tmpDir, `${s.runId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(s));
      }

      const state = makeState();
      const tracker = createRunTracker(state);
      await tracker.finalize(false);

      // After finalize, prune(50) is called. We now have 53 total (52 + the finalized one).
      // So 3 should be deleted.
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(50);
    });
  });
});
