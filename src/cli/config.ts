import type { Command } from "commander";
import { SheetsAdapter } from "../adapters/sheets/sheets-adapter.js";
import { getTabConfig, resolveTabGid } from "../core/tab-resolver.js";
import type { Action } from "../core/types.js";
import { type ValidationResult, validateConfig } from "../core/validator.js";
import { error, warn } from "./format.js";

export function registerConfig(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Manage pipeline configuration")
    .action(() => {
      configCmd.help();
    });

  // rowbound config show <sheetId> [--tab <name>]
  configCmd
    .command("show")
    .description("Display pipeline config as formatted JSON")
    .argument("<sheetId>", "Google Sheets spreadsheet ID")
    .option("--tab <name>", "Sheet tab name")
    .action(async (sheetId: string, opts: { tab?: string }) => {
      const adapter = new SheetsAdapter();
      const ref = { spreadsheetId: sheetId, sheetName: opts.tab || "Sheet1" };

      try {
        const existing = await adapter.readConfig(ref);
        if (!existing) {
          console.error(error("No Rowbound config found for this sheet."));
          process.exitCode = 1;
          return;
        }

        if (opts.tab && !existing.tabs) {
          console.warn(
            warn(
              "Note: Config is v1 format (single-tab). Run 'rowbound sync' to migrate to v2.",
            ),
          );
        }

        if (opts.tab && existing.tabs) {
          // Show just the specified tab's config
          const resolved = resolveTabGid(existing, opts.tab);
          if (!resolved) {
            console.error(
              error(
                `Tab "${opts.tab}" not found. Available: ${Object.values(
                  existing.tabs,
                )
                  .map((t) => t.name)
                  .join(", ")}`,
              ),
            );
            process.exitCode = 1;
            return;
          }
          console.log(
            JSON.stringify({ gid: resolved.gid, ...resolved.tab }, null, 2),
          );
        } else {
          console.log(JSON.stringify(existing, null, 2));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(error("Failed to read config:"), msg);
        process.exitCode = 1;
      }
    });

  // rowbound config add-action <sheetId> --json '<action JSON>' [--tab <name>]
  configCmd
    .command("add-action")
    .description("Add an action to the pipeline config")
    .argument("<sheetId>", "Google Sheets spreadsheet ID")
    .requiredOption("--json <actionJson>", "Action definition as JSON string")
    .option("--tab <name>", "Sheet tab name")
    .action(async (sheetId: string, opts: { tab?: string; json: string }) => {
      const adapter = new SheetsAdapter();
      const ref = { spreadsheetId: sheetId, sheetName: opts.tab || "Sheet1" };

      try {
        let action: Action;
        try {
          action = JSON.parse(opts.json) as Action;
        } catch {
          console.error(error("Invalid JSON for action definition."));
          process.exitCode = 1;
          return;
        }

        if (!action.id || !action.type || !action.target) {
          console.error(
            error(
              "Action must have at least 'id', 'type', and 'target' fields.",
            ),
          );
          process.exitCode = 1;
          return;
        }

        const existing = await adapter.readConfig(ref);
        if (!existing) {
          console.error(
            error(
              "No Rowbound config found. Run 'rowbound init <sheetId>' first.",
            ),
          );
          process.exitCode = 1;
          return;
        }

        if (existing.tabs) {
          // v2: add to the specific tab
          const { gid, tab } = getTabConfig(existing, opts.tab);
          if (tab.actions.some((s) => s.id === action.id)) {
            console.error(
              error(`Action with id "${action.id}" already exists.`),
            );
            process.exitCode = 1;
            return;
          }
          tab.actions.push(action);
          existing.tabs[gid] = tab;
        } else {
          // v1 fallback
          if (existing.actions.some((s) => s.id === action.id)) {
            console.error(
              error(`Action with id "${action.id}" already exists.`),
            );
            process.exitCode = 1;
            return;
          }
          existing.actions.push(action);
        }

        await adapter.writeConfig(ref, existing);
        console.log(
          `Added action "${action.id}" (${action.type} -> ${action.target})`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(error("Failed to add action:"), msg);
        process.exitCode = 1;
      }
    });

  // rowbound config remove-action <sheetId> --action <id> [--tab <name>]
  configCmd
    .command("remove-action")
    .description("Remove an action from the pipeline config")
    .argument("<sheetId>", "Google Sheets spreadsheet ID")
    .requiredOption("--action <id>", "Action ID to remove")
    .option("--tab <name>", "Sheet tab name")
    .action(async (sheetId: string, opts: { tab?: string; action: string }) => {
      const adapter = new SheetsAdapter();
      const ref = { spreadsheetId: sheetId, sheetName: opts.tab || "Sheet1" };

      try {
        const existing = await adapter.readConfig(ref);
        if (!existing) {
          console.error(
            error(
              "No Rowbound config found. Run 'rowbound init <sheetId>' first.",
            ),
          );
          process.exitCode = 1;
          return;
        }

        if (existing.tabs) {
          const { gid, tab } = getTabConfig(existing, opts.tab);
          const originalLength = tab.actions.length;
          tab.actions = tab.actions.filter((s) => s.id !== opts.action);
          if (tab.actions.length === originalLength) {
            console.error(
              error(`Action "${opts.action}" not found in config.`),
            );
            process.exitCode = 1;
            return;
          }
          existing.tabs[gid] = tab;
        } else {
          const originalLength = existing.actions.length;
          existing.actions = existing.actions.filter(
            (s) => s.id !== opts.action,
          );
          if (existing.actions.length === originalLength) {
            console.error(
              error(`Action "${opts.action}" not found in config.`),
            );
            process.exitCode = 1;
            return;
          }
        }

        await adapter.writeConfig(ref, existing);
        console.log(`Removed action "${opts.action}".`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(error("Failed to remove action:"), msg);
        process.exitCode = 1;
      }
    });

  // rowbound config update-action <sheetId> --action <id> --json '<partial JSON>' [--tab <name>]
  configCmd
    .command("update-action")
    .description("Update an action in the pipeline config (merge partial JSON)")
    .argument("<sheetId>", "Google Sheets spreadsheet ID")
    .requiredOption("--action <id>", "Action ID to update")
    .requiredOption(
      "--json <partialJson>",
      "Partial action definition to merge",
    )
    .option("--tab <name>", "Sheet tab name")
    .action(
      async (
        sheetId: string,
        opts: { tab?: string; action: string; json: string },
      ) => {
        const adapter = new SheetsAdapter();
        const ref = { spreadsheetId: sheetId, sheetName: opts.tab || "Sheet1" };

        try {
          let patch: Partial<Action>;
          try {
            patch = JSON.parse(opts.json) as Partial<Action>;
          } catch {
            console.error(error("Invalid JSON for action update."));
            process.exitCode = 1;
            return;
          }

          const existing = await adapter.readConfig(ref);
          if (!existing) {
            console.error(
              error(
                "No Rowbound config found. Run 'rowbound init <sheetId>' first.",
              ),
            );
            process.exitCode = 1;
            return;
          }

          let actions: Action[];
          let gid: string | undefined;
          if (existing.tabs) {
            const resolved = getTabConfig(existing, opts.tab);
            gid = resolved.gid;
            actions = resolved.tab.actions;
          } else {
            actions = existing.actions;
          }

          const actionIndex = actions.findIndex((s) => s.id === opts.action);
          if (actionIndex === -1) {
            console.error(
              error(`Action "${opts.action}" not found in config.`),
            );
            process.exitCode = 1;
            return;
          }

          // If renaming the ID, check for duplicates
          if (patch.id && patch.id !== opts.action) {
            if (actions.some((s) => s.id === patch.id)) {
              console.error(
                error(`Action with id "${patch.id}" already exists.`),
              );
              process.exitCode = 1;
              return;
            }
          }

          actions[actionIndex] = {
            ...actions[actionIndex]!,
            ...patch,
          } as Action;

          if (existing.tabs && gid) {
            existing.tabs[gid]!.actions = actions;
          } else {
            existing.actions = actions;
          }

          await adapter.writeConfig(ref, existing);
          console.log(
            `Updated action "${opts.action}"${patch.id && patch.id !== opts.action ? ` → "${patch.id}"` : ""}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(error("Failed to update action:"), msg);
          process.exitCode = 1;
        }
      },
    );

  // rowbound config set <sheetId> [--concurrency <n>] [--rate-limit <n>] [--retry-attempts <n>] [--retry-backoff <strategy>] [--tab <name>]
  configCmd
    .command("set")
    .description("Update pipeline settings")
    .argument("<sheetId>", "Google Sheets spreadsheet ID")
    .option("--concurrency <n>", "Max concurrent rows")
    .option(
      "--rate-limit <n>",
      "Seconds between requests (e.g. 10 = 1 req per 10s, 0.1 = 10 req/s)",
    )
    .option("--retry-attempts <n>", "Number of retry attempts")
    .option(
      "--retry-backoff <strategy>",
      "Backoff strategy (exponential, linear, fixed)",
    )
    .option("--tab <name>", "Sheet tab name")
    .action(
      async (
        sheetId: string,
        opts: {
          tab?: string;
          concurrency?: string;
          rateLimit?: string;
          retryAttempts?: string;
          retryBackoff?: string;
        },
      ) => {
        const adapter = new SheetsAdapter();
        const ref = { spreadsheetId: sheetId, sheetName: opts.tab || "Sheet1" };

        try {
          const existing = await adapter.readConfig(ref);
          if (!existing) {
            console.error(
              error(
                "No Rowbound config found. Run 'rowbound init <sheetId>' first.",
              ),
            );
            process.exitCode = 1;
            return;
          }

          const changes: string[] = [];

          if (opts.concurrency !== undefined) {
            const val = parseInt(opts.concurrency, 10);
            if (Number.isNaN(val) || val <= 0) {
              console.error(error("--concurrency must be a positive integer."));
              process.exitCode = 1;
              return;
            }
            existing.settings.concurrency = val;
            changes.push(`concurrency=${val}`);
          }

          if (opts.rateLimit !== undefined) {
            const val = parseFloat(opts.rateLimit);
            if (Number.isNaN(val) || val < 0) {
              console.error(
                error(
                  "--rate-limit must be a non-negative number (0 to disable).",
                ),
              );
              process.exitCode = 1;
              return;
            }
            existing.settings.rateLimit = val;
            changes.push(`rateLimit=${val}`);
          }

          if (opts.retryAttempts !== undefined) {
            const val = parseInt(opts.retryAttempts, 10);
            if (Number.isNaN(val) || val < 0) {
              console.error(
                error("--retry-attempts must be a non-negative integer."),
              );
              process.exitCode = 1;
              return;
            }
            existing.settings.retryAttempts = val;
            changes.push(`retryAttempts=${val}`);
          }

          if (opts.retryBackoff !== undefined) {
            const validStrategies = ["exponential", "linear", "fixed"];
            if (!validStrategies.includes(opts.retryBackoff)) {
              console.error(
                error(
                  `Invalid --retry-backoff value "${opts.retryBackoff}". Must be one of: ${validStrategies.join(", ")}`,
                ),
              );
              process.exitCode = 1;
              return;
            }
            existing.settings.retryBackoff = opts.retryBackoff;
            changes.push(`retryBackoff=${opts.retryBackoff}`);
          }

          if (changes.length === 0) {
            console.error(
              error(
                "No settings specified. Use --concurrency, --rate-limit, --retry-attempts, or --retry-backoff.",
              ),
            );
            process.exitCode = 1;
            return;
          }

          await adapter.writeConfig(ref, existing);
          console.log(`Updated settings: ${changes.join(", ")}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(error("Failed to update settings:"), msg);
          process.exitCode = 1;
        }
      },
    );

  // rowbound config validate <sheetId> [--tab <name>] [--json]
  configCmd
    .command("validate")
    .description("Validate the pipeline config")
    .argument("<sheetId>", "Google Sheets spreadsheet ID")
    .option("--tab <name>", "Sheet tab name")
    .option("--json", "Output validation result as JSON")
    .action(async (sheetId: string, opts: { tab?: string; json?: boolean }) => {
      const adapter = new SheetsAdapter();
      const ref = { spreadsheetId: sheetId, sheetName: opts.tab || "Sheet1" };

      try {
        const existing = await adapter.readConfig(ref);
        if (!existing) {
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  valid: false,
                  errors: ["No Rowbound config found for this sheet."],
                  warnings: [],
                },
                null,
                2,
              ),
            );
          } else {
            console.error(error("No Rowbound config found for this sheet."));
          }
          process.exitCode = 1;
          return;
        }

        // For v2, validate per-tab
        let result: ValidationResult;
        let tabName: string | undefined;
        let actionCount: number;

        if (existing.tabs) {
          const { tab } = getTabConfig(existing, opts.tab);
          tabName = tab.name;
          actionCount = tab.actions.length;
          const tabValidationConfig = {
            ...existing,
            actions: tab.actions,
          };
          result = validateConfig(tabValidationConfig);
        } else {
          actionCount = existing.actions.length;
          result = validateConfig(existing);
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          if (!result.valid) {
            process.exitCode = 1;
          }
          return;
        }

        if (result.valid) {
          if (result.warnings.length > 0) {
            console.log(
              warn(
                `Config is valid with ${result.warnings.length} warning(s):`,
              ),
            );
            for (const w of result.warnings) {
              console.warn(warn(`  - ${w}`));
            }
          } else {
            console.log("Config is valid.");
          }
          console.log(`  Version: ${existing.version}`);
          if (tabName) {
            console.log(`  Tab:     ${tabName}`);
          }
          console.log(`  Actions: ${actionCount}`);
          console.log(
            `  Settings: concurrency=${existing.settings.concurrency}, rateLimit=${existing.settings.rateLimit}s between requests`,
          );
        } else {
          console.error(error("Config validation failed:"));
          for (const e of result.errors) {
            console.error(error(`  - ${e}`));
          }
          process.exitCode = 1;

          if (result.warnings.length > 0) {
            console.warn(warn("Warnings:"));
            for (const w of result.warnings) {
              console.warn(warn(`  - ${w}`));
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(
            JSON.stringify(
              { valid: false, errors: [msg], warnings: [] },
              null,
              2,
            ),
          );
        } else {
          console.error(error("Failed to validate config:"), msg);
        }
        process.exitCode = 1;
      }
    });
}
