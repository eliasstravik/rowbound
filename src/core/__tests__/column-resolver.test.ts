import { describe, expect, it, vi } from "vitest";
import type { SheetsAdapter } from "../../adapters/sheets/sheets-adapter.js";
import { runPipeline } from "../engine.js";
import { reconcile } from "../reconcile.js";
import type {
  Adapter,
  CellUpdate,
  PipelineConfig,
  Row,
  SheetRef,
  TabConfig,
} from "../types.js";

// Mock HTTP dependencies so no real network calls are made
vi.mock("../http-client.js", () => ({
  httpRequest: vi.fn(),
  StopProviderError: class StopProviderError extends Error {
    constructor(message = "Provider stopped") {
      super(message);
      this.name = "StopProviderError";
    }
  },
}));

vi.mock("../extractor.js", () => ({
  extractValue: vi.fn(),
}));

vi.mock("../waterfall.js", () => ({
  executeWaterfall: vi.fn(),
}));

vi.mock("../exec.js", () => ({
  executeExecAction: vi.fn(),
}));

/** Minimal mock adapter for testing */
class MockAdapter implements Adapter {
  private rows: Row[] = [];
  public writtenBatches: Array<{ ref: SheetRef; updates: CellUpdate[] }> = [];

  constructor(rows: Row[] = []) {
    this.rows = rows;
  }

  async readRows(_ref: SheetRef): Promise<Row[]> {
    return this.rows;
  }

  async writeCell(_ref: SheetRef, _update: CellUpdate): Promise<void> {}

  async writeBatch(ref: SheetRef, updates: CellUpdate[]): Promise<void> {
    this.writtenBatches.push({ ref, updates });
  }

  async readConfig(_ref: SheetRef): Promise<PipelineConfig | null> {
    return null;
  }

  async writeConfig(_ref: SheetRef, _config: PipelineConfig): Promise<void> {}

  async getHeaders(_ref: SheetRef): Promise<string[]> {
    if (this.rows.length > 0) {
      return Object.keys(this.rows[0]!);
    }
    return [];
  }
}

/** Mock SheetsAdapter with controllable headers, named ranges, sheets list, and range creation tracking */
function createMockSheetsAdapter(opts: {
  headers: string[];
  namedRanges?: Map<string, number>;
  sheets?: Array<{ gid: number; name: string }>;
}): SheetsAdapter & {
  createdRanges: Array<{ rangeId: string; columnIndex: number }>;
  deletedRanges: string[];
} {
  const createdRanges: Array<{ rangeId: string; columnIndex: number }> = [];
  const deletedRanges: string[] = [];
  const defaultSheets = opts.sheets ?? [{ gid: 0, name: "Sheet1" }];
  return {
    createdRanges,
    deletedRanges,
    getHeaders: vi.fn().mockResolvedValue(opts.headers),
    readColumnRanges: vi.fn().mockResolvedValue(opts.namedRanges ?? new Map()),
    createColumnRange: vi
      .fn()
      .mockImplementation(
        async (_ref: SheetRef, rangeId: string, columnIndex: number) => {
          createdRanges.push({ rangeId, columnIndex });
        },
      ),
    deleteColumnRange: vi
      .fn()
      .mockImplementation(async (_ref: SheetRef, rangeId: string) => {
        deletedRanges.push(rangeId);
      }),
    listSheets: vi.fn().mockResolvedValue(defaultSheets),
  } as unknown as SheetsAdapter & {
    createdRanges: Array<{ rangeId: string; columnIndex: number }>;
    deletedRanges: string[];
  };
}

const REF: SheetRef = { spreadsheetId: "test-sheet-id", sheetName: "Sheet1" };

function makeConfig(
  actions: PipelineConfig["actions"],
  columns?: Record<string, string>,
): PipelineConfig {
  return {
    version: "1",
    columns,
    actions,
    settings: {
      concurrency: 1,
      rateLimit: 0,
      retryAttempts: 0,
      retryBackoff: "exponential",
    },
  };
}

function makeV2Config(tabs: Record<string, TabConfig>): PipelineConfig {
  return {
    version: "2",
    tabs,
    actions: [],
    settings: {
      concurrency: 1,
      rateLimit: 0,
      retryAttempts: 0,
      retryBackoff: "exponential",
    },
  };
}

describe("reconcile", () => {
  it("creates ranges for all columns when columns registry is empty", async () => {
    const adapter = createMockSheetsAdapter({
      headers: ["name", "email", "phone"],
    });

    const config = makeConfig([]);
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    expect(result.config.version).toBe("2");
    expect(result.tabGid).toBe("0");
    const cols = result.tabConfig.columns;
    // 3 columns tracked, IDs are keys, names are values
    expect(Object.keys(cols)).toHaveLength(3);
    expect(Object.values(cols)).toContain("name");
    expect(Object.values(cols)).toContain("email");
    expect(Object.values(cols)).toContain("phone");
    expect(adapter.createdRanges).toHaveLength(3);
  });

  it("does nothing when all columns are already tracked (v2)", async () => {
    const columns = { aaa: "name", bbb: "email" };
    const namedRanges = new Map([
      ["aaa", 0],
      ["bbb", 1],
    ]);
    const adapter = createMockSheetsAdapter({
      headers: ["name", "email"],
      namedRanges,
    });

    const config = makeV2Config({
      "0": { name: "Sheet1", columns, actions: [] },
    });
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(false);
    expect(result.messages).toHaveLength(0);
    expect(adapter.createdRanges).toHaveLength(0);
    expect(result.orphanedRanges).toHaveLength(0);
  });

  it("detects rename — updates label, key stays stable", async () => {
    const columns = { aaa: "company_name" };
    const namedRanges = new Map([["aaa", 0]]);
    const adapter = createMockSheetsAdapter({
      headers: ["org_name"],
      namedRanges,
    });

    const config = makeV2Config({
      "0": { name: "Sheet1", columns, actions: [] },
    });
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    // Key (ID) stays the same, value (name) updated
    expect(result.tabConfig.columns.aaa).toBe("org_name");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toContain("company_name");
    expect(result.messages[0]).toContain("org_name");
  });

  it("action targets remain stable on rename (they reference IDs)", async () => {
    const columns = { aaa: "company_name" };
    const namedRanges = new Map([["aaa", 0]]);
    const adapter = createMockSheetsAdapter({
      headers: ["org_name"],
      namedRanges,
    });

    // Action target is the ID "aaa" — should NOT change on rename
    const config = makeV2Config({
      "0": {
        name: "Sheet1",
        columns,
        actions: [
          {
            id: "action1",
            type: "transform",
            target: "aaa",
            expression: "'test'",
          },
        ],
      },
    });
    const result = await reconcile(adapter, REF, config);

    expect(result.tabConfig.actions[0]!.target).toBe("aaa");
    expect(result.tabConfig.columns.aaa).toBe("org_name");
  });

  it("migrates action target from column name to ID", async () => {
    const columns = { aaa: "company_name", bbb: "email" };
    const namedRanges = new Map([
      ["aaa", 0],
      ["bbb", 1],
    ]);
    const adapter = createMockSheetsAdapter({
      headers: ["company_name", "email"],
      namedRanges,
    });

    // Action target is a name (legacy) — should be migrated to ID
    const config = makeV2Config({
      "0": {
        name: "Sheet1",
        columns,
        actions: [
          {
            id: "action1",
            type: "transform",
            target: "company_name",
            expression: "'test'",
          },
        ],
      },
    });
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    expect(result.tabConfig.actions[0]!.target).toBe("aaa");
    expect(result.messages.some((m) => m.includes("migrated to ID"))).toBe(
      true,
    );
  });

  it("handles deleted column", async () => {
    const columns = { aaa: "name", bbb: "deleted_col" };
    const namedRanges = new Map([
      ["aaa", 0],
      ["bbb", 5],
    ]);
    const adapter = createMockSheetsAdapter({
      headers: ["name", "email"],
      namedRanges,
    });

    const config = makeV2Config({
      "0": { name: "Sheet1", columns, actions: [] },
    });
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    expect(result.tabConfig.columns.bbb).toBeUndefined();
    expect(result.tabConfig.columns.aaa).toBe("name");
    expect(result.messages.some((m) => m.includes("deleted"))).toBe(true);
  });

  it("migrates legacy action-based named ranges", async () => {
    const namedRanges = new Map([["extract_handle", 2]]);
    const adapter = createMockSheetsAdapter({
      headers: ["name", "email", "handle"],
      namedRanges,
    });

    // Legacy config: no columns, action target is a name
    const config = makeConfig([
      {
        id: "extract_handle",
        type: "transform",
        target: "handle",
        expression: "'test'",
      },
    ]);
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    expect(result.config.version).toBe("2");
    // Legacy range adopted: key is "extract_handle", value is "handle"
    expect(result.tabConfig.columns.extract_handle).toBe("handle");
    // Action target migrated to ID
    expect(result.tabConfig.actions[0]!.target).toBe("extract_handle");
  });

  it("resolves action target via legacy range when column was renamed before migration", async () => {
    const namedRanges = new Map([["extract_handle", 1]]);
    const adapter = createMockSheetsAdapter({
      headers: ["name", "Attio handles"],
      namedRanges,
    });

    const config = makeConfig([
      {
        id: "extract_handle",
        type: "transform",
        target: "Expert handle",
        expression: "'test'",
      },
    ]);
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    expect(result.config.version).toBe("2");
    // Legacy range adopted with current header name
    expect(result.tabConfig.columns.extract_handle).toBe("Attio handles");
    // Action target migrated to the range ID
    expect(result.tabConfig.actions[0]!.target).toBe("extract_handle");
  });

  it("handles mix of stable and renamed columns", async () => {
    const columns = { aaa: "name", bbb: "old_email", ccc: "phone" };
    const namedRanges = new Map([
      ["aaa", 0],
      ["bbb", 1],
      ["ccc", 2],
    ]);
    const adapter = createMockSheetsAdapter({
      headers: ["name", "contact_email", "phone"],
      namedRanges,
    });

    const config = makeV2Config({
      "0": {
        name: "Sheet1",
        columns,
        actions: [
          {
            id: "action1",
            type: "transform",
            target: "aaa",
            expression: "'test'",
          },
          {
            id: "action2",
            type: "transform",
            target: "bbb",
            expression: "'test'",
          },
        ],
      },
    });
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    // Only the label changed, not the key
    expect(result.tabConfig.columns.bbb).toBe("contact_email");
    // Action targets stay as IDs
    expect(result.tabConfig.actions[0]!.target).toBe("aaa");
    expect(result.tabConfig.actions[1]!.target).toBe("bbb");
  });

  it("migrates v1 config to v2 with correct tab GID", async () => {
    const adapter = createMockSheetsAdapter({
      headers: ["name", "email"],
      sheets: [
        { gid: 42, name: "Sheet1" },
        { gid: 999, name: "Other" },
      ],
    });

    const config = makeConfig(
      [
        {
          id: "action1",
          type: "transform",
          target: "email",
          expression: "'test'",
        },
      ],
      { aaa: "name", bbb: "email" },
    );
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    expect(result.config.version).toBe("2");
    expect(result.tabGid).toBe("42");
    expect(result.config.tabs).toBeDefined();
    expect(result.config.tabs!["42"]).toBeDefined();
    expect(result.config.tabs!["42"]!.name).toBe("Sheet1");
    // Top-level v1 fields cleared
    expect(result.config.columns).toBeUndefined();
    expect(result.config.actions).toEqual([]);
  });

  it("reconciles tab names when tab is renamed in the sheet", async () => {
    const adapter = createMockSheetsAdapter({
      headers: ["name"],
      sheets: [{ gid: 0, name: "Renamed Tab" }],
    });

    const config = makeV2Config({
      "0": { name: "Sheet1", columns: {}, actions: [] },
    });
    const result = await reconcile(
      adapter,
      { spreadsheetId: "test-sheet-id", sheetName: "Renamed Tab" },
      config,
    );

    expect(result.configChanged).toBe(true);
    expect(result.tabConfig.name).toBe("Renamed Tab");
    expect(result.messages.some((m) => m.includes("renamed"))).toBe(true);
  });

  it("prunes orphaned ranges when multiple ranges point to the same column after deletion", async () => {
    // Scenario: columns "Company Details" (col_cd) and "Website Exa" (col_we)
    // were deleted from the sheet. Google Sheets shifted their named ranges so
    // they now point to existing columns "Serper" (col_serp) and "GPT Nano" (col_gpt).
    const columns = {
      col_serp: "Serper",
      col_gpt: "GPT Nano",
      col_cd: "Company Details",
      col_we: "Website Exa",
    };
    // After deletion: col_cd shifted to index 0 (same as col_serp),
    // col_we shifted to index 1 (same as col_gpt)
    const namedRanges = new Map([
      ["col_serp", 0],
      ["col_gpt", 1],
      ["col_cd", 0], // orphaned — shifted onto col_serp's column
      ["col_we", 1], // orphaned — shifted onto col_gpt's column
    ]);
    const adapter = createMockSheetsAdapter({
      headers: ["Serper", "GPT Nano"],
      namedRanges,
    });

    const config = makeV2Config({
      "0": { name: "Sheet1", columns, actions: [] },
    });
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    // Only the legitimate ranges survive
    expect(result.tabConfig.columns).toEqual({
      col_serp: "Serper",
      col_gpt: "GPT Nano",
    });
    // Orphaned range IDs returned for caller to clean up
    expect(result.orphanedRanges).toContain("col_cd");
    expect(result.orphanedRanges).toContain("col_we");
    expect(result.orphanedRanges).toHaveLength(2);
    // reconcile itself does NOT delete ranges (callers do after saving config)
    expect(adapter.deletedRanges).toHaveLength(0);
    // Messages mention orphaned removal
    expect(
      result.messages.filter((m) => m.includes("orphaned")),
    ).toHaveLength(2);
  });

  it("handles collision when no range matches the header by old name", async () => {
    // Edge case: two ranges point to the same column, but neither old name
    // matches the current header (e.g., header was also renamed).
    // Tiebreaker is deterministic: lexicographically first ID wins.
    const columns = { bbb: "old_name_1", aaa: "old_name_2" };
    const namedRanges = new Map([
      ["bbb", 0],
      ["aaa", 0], // collision
    ]);
    const adapter = createMockSheetsAdapter({
      headers: ["new_name"],
      namedRanges,
    });

    const config = makeV2Config({
      "0": { name: "Sheet1", columns, actions: [] },
    });
    const result = await reconcile(adapter, REF, config);

    expect(result.configChanged).toBe(true);
    // "aaa" survives (lexicographically first), "bbb" is pruned
    expect(result.tabConfig.columns).toEqual({ aaa: "new_name" });
    expect(result.orphanedRanges).toEqual(["bbb"]);
    expect(adapter.deletedRanges).toHaveLength(0);
  });

  it("multi-tab config only reconciles the target tab", async () => {
    const namedRanges = new Map([["aaa", 0]]);
    const adapter = createMockSheetsAdapter({
      headers: ["name"],
      namedRanges,
      sheets: [
        { gid: 0, name: "Sheet1" },
        { gid: 100, name: "Other" },
      ],
    });

    const config = makeV2Config({
      "0": { name: "Sheet1", columns: { aaa: "name" }, actions: [] },
      "100": {
        name: "Other",
        columns: { zzz: "data" },
        actions: [
          { id: "s1", type: "transform", target: "zzz", expression: "'x'" },
        ],
      },
    });
    const result = await reconcile(adapter, REF, config);

    // Target tab reconciled
    expect(result.tabGid).toBe("0");
    // Other tab untouched
    expect(result.config.tabs!["100"]!.columns).toEqual({ zzz: "data" });
    expect(result.config.tabs!["100"]!.actions).toHaveLength(1);
  });
});

describe("engine with columnMap (ID-keyed rows)", () => {
  it("builds ID-keyed rows from column map", async () => {
    const adapter = new MockAdapter([{ name: "Alice", greeting: "" }]);

    const config = makeConfig([
      {
        id: "greet",
        type: "transform",
        target: "col_greeting",
        expression: "'Hi ' + row.col_name",
      },
    ]);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
      columnMap: { col_name: "name", col_greeting: "greeting" },
    });

    expect(result.updates).toBe(1);
    // CellUpdate.column should be the resolved name, not the ID
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "greeting", value: "Hi Alice" },
    ]);
  });

  it("resolves action target ID to column name in CellUpdate", async () => {
    const adapter = new MockAdapter([
      { "Profile URL": "https://example.com/experts/alice", result: "" },
    ]);

    const config = makeConfig([
      {
        id: "extract",
        type: "transform",
        target: "col_result",
        expression: "row.col_url.split('/').pop()",
      },
    ]);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
      columnMap: { col_url: "Profile URL", col_result: "result" },
    });

    expect(result.updates).toBe(1);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "result", value: "alice" },
    ]);
  });

  it("works without columnMap (legacy/testing mode)", async () => {
    const adapter = new MockAdapter([{ name: "Alice", greeting: "" }]);

    const config = makeConfig([
      {
        id: "greet",
        type: "transform",
        target: "greeting",
        expression: "'Hi ' + row.name",
      },
    ]);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    expect(result.updates).toBe(1);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "greeting", value: "Hi Alice" },
    ]);
  });
});
