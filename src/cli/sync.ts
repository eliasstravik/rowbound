import type { Command } from "commander";
import { SheetsAdapter } from "../adapters/sheets/sheets-adapter.js";
import { cleanupOrphanedRanges, reconcile } from "../core/reconcile.js";
import { validateConfig } from "../core/validator.js";
import { dim, error, success, warn } from "./format.js";

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description(
      "Sync pipeline config with the sheet — reconcile columns, migrate action targets, validate, and fix issues",
    )
    .argument("<sheetId>", "Google Sheets spreadsheet ID")
    .option("--tab <name>", "Sheet tab name", "Sheet1")
    .action(async (sheetId: string, opts: { tab: string }) => {
      const adapter = new SheetsAdapter();
      const ref = { spreadsheetId: sheetId, sheetName: opts.tab };

      try {
        const config = await adapter.readConfig(ref);
        if (!config) {
          console.error(
            error("No Rowbound config found.") +
              " Run 'rowbound init <sheetId>' first.",
          );
          process.exitCode = 1;
          return;
        }

        // --- 1. Reconcile columns (and migrate v1→v2 if needed) ---
        const reconciled = await reconcile(adapter, ref, config);
        const tabConfig = reconciled.tabConfig;

        if (reconciled.messages.length > 0) {
          console.log(dim("\u21BB Reconciling columns..."));
          for (const msg of reconciled.messages) {
            console.log(`  ${dim(msg)}`);
          }
        } else {
          console.log(`${success("\u2713")} Columns in sync`);
        }

        // --- 2. Check for orphaned action targets ---
        const columns = tabConfig.columns;
        const warnings: string[] = [];

        for (const action of tabConfig.actions) {
          if (!columns[action.target]) {
            warnings.push(
              `Action "${action.id}" targets "${action.target}" which is not a known column ID`,
            );
          }
        }

        // --- 3. Check for unreferenced columns (info, not a problem) ---
        const targetedIds = new Set(tabConfig.actions.map((s) => s.target));
        const _untargeted = Object.entries(columns)
          .filter(([id]) => !targetedIds.has(id))
          .map(([id, name]) => `${name} (${id})`);

        // --- 4. Validate config ---
        const validationConfig = {
          ...reconciled.config,
          actions: tabConfig.actions,
        };
        const validation = validateConfig(validationConfig);

        if (validation.errors.length > 0) {
          console.error(`\n${error("\u2717")} Validation errors:`);
          for (const e of validation.errors) {
            console.error(`  ${error("-")} ${e}`);
          }
        }

        if (validation.warnings.length > 0 || warnings.length > 0) {
          console.log(`\n${warn("\u26A0")} Warnings:`);
          for (const w of [...warnings, ...validation.warnings]) {
            console.log(`  ${warn("-")} ${w}`);
          }
        }

        // --- 5. Save if anything changed ---
        if (reconciled.configChanged) {
          await adapter.writeConfig(ref, reconciled.config);
          console.log(`\n${success("\u2713")} Config saved`);
        }

        // --- 5b. Clean up orphaned named ranges after config is safely saved ---
        if (reconciled.orphanedRanges.length > 0) {
          await cleanupOrphanedRanges(adapter, ref, reconciled.orphanedRanges);
        }

        // --- 6. Summary ---
        const cols = Object.keys(columns).length;
        const actions = tabConfig.actions.length;
        console.log(`\n${cols} columns tracked, ${actions} actions configured`);

        if (validation.errors.length > 0 || warnings.length > 0) {
          process.exitCode = 1;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(error("Sync failed:"), msg);
        process.exitCode = 1;
      }
    });
}
