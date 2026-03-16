import { randomBytes } from "node:crypto";
/**
 * Reconcile a pipeline config with the current sheet state.
 *
 * This function handles:
 * 1. v1 → v2 migration (wraps top-level actions/columns under the resolved GID)
 * 2. Tab name reconciliation (detects renamed tabs by GID)
 * 3. Column reconciliation for the target tab (named ranges, renames, new columns)
 * 4. Action target migration from column names to IDs
 */
export async function reconcile(adapter, ref, config) {
    const messages = [];
    let configChanged = false;
    // --- Action 1: Get all tabs from the spreadsheet ---
    const sheets = await adapter.listSheets(ref.spreadsheetId);
    const targetName = ref.sheetName || "Sheet1";
    const targetSheet = sheets.find((s) => s.name === targetName);
    if (!targetSheet) {
        throw new Error(`Tab "${targetName}" not found in spreadsheet ${ref.spreadsheetId}`);
    }
    const tabGid = String(targetSheet.gid);
    // --- Action 2: Migrate v1 → v2 if needed ---
    let tabs;
    if (!config.tabs) {
        // v1 config — migrate to v2
        const v1Columns = config.columns ?? {};
        const v1Actions = config.actions ?? [];
        tabs = {
            [tabGid]: {
                name: targetName,
                columns: { ...v1Columns },
                actions: [...v1Actions],
            },
        };
        configChanged = true;
        messages.push(`Migrated v1 config to v2 multi-tab format (tab GID: ${tabGid})`);
    }
    else {
        // Already v2 — deep clone tabs
        tabs = {};
        for (const [gid, tab] of Object.entries(config.tabs)) {
            tabs[gid] = {
                name: tab.name,
                columns: { ...tab.columns },
                actions: [...tab.actions],
            };
        }
    }
    // Ensure the target tab exists in config
    if (!tabs[tabGid]) {
        tabs[tabGid] = {
            name: targetName,
            columns: {},
            actions: [],
        };
        configChanged = true;
    }
    // --- Action 3: Reconcile tab names ---
    for (const [gid, tab] of Object.entries(tabs)) {
        const sheet = sheets.find((s) => String(s.gid) === gid);
        if (sheet && sheet.name !== tab.name) {
            messages.push(`Tab ${gid}: renamed "${tab.name}" → "${sheet.name}"`);
            tab.name = sheet.name;
            configChanged = true;
        }
    }
    // --- Action 4: Reconcile columns for the target tab ---
    const tabConfig = tabs[tabGid];
    const headers = await adapter.getHeaders(ref);
    const sheetRanges = await adapter.readColumnRanges(ref, targetSheet.gid);
    let oldColumns = tabConfig.columns;
    const newColumns = {};
    if (Object.keys(oldColumns).length === 0 && !config.tabs) {
        // First time — configChanged already set from migration
    }
    // Detect old {name: id} format and flip to new {id: name} format.
    const isOldFormat = Object.keys(oldColumns).length > 0 &&
        Object.values(oldColumns).some((v) => sheetRanges.has(v));
    if (isOldFormat) {
        const flipped = {};
        for (const [name, id] of Object.entries(oldColumns)) {
            flipped[id] = name;
        }
        oldColumns = flipped;
        tabConfig.columns = flipped;
        configChanged = true;
    }
    // Track which header indices are covered by existing ranges
    const coveredIndices = new Set();
    // --- Pass 1: Process all named ranges found in the sheet ---
    for (const [rangeId, colIndex] of sheetRanges) {
        const currentHeader = headers[colIndex];
        if (!currentHeader) {
            // Range points beyond current headers → column was deleted
            const oldName = oldColumns[rangeId];
            if (oldName) {
                messages.push(`✗ "${oldName}" (${rangeId}) → deleted, removing`);
                configChanged = true;
            }
            continue;
        }
        coveredIndices.add(colIndex);
        const oldName = oldColumns[rangeId];
        if (oldName && oldName !== currentHeader) {
            // Header name changed — just update the label
            newColumns[rangeId] = currentHeader;
            messages.push(`✓ "${oldName}" → renamed to "${currentHeader}" (${rangeId})`);
            configChanged = true;
        }
        else if (oldName) {
            // No change
            newColumns[rangeId] = currentHeader;
        }
        else {
            // Range exists in sheet but not in our config (migration from action-based ranges)
            newColumns[rangeId] = currentHeader;
            configChanged = true;
        }
    }
    // --- Pass 2: Create ranges for untracked headers ---
    const trackedNames = new Set(Object.values(newColumns));
    for (let i = 0; i < headers.length; i++) {
        if (coveredIndices.has(i))
            continue;
        const header = headers[i];
        if (!header || trackedNames.has(header))
            continue;
        const rangeId = randomBytes(4).toString("hex");
        try {
            await adapter.createColumnRange(ref, rangeId, i);
            newColumns[rangeId] = header;
            messages.push(`✓ "${header}" → new column (${rangeId})`);
            configChanged = true;
        }
        catch {
            // Non-fatal — column just won't have tracking
        }
    }
    // --- Pass 3: Migrate action targets from column names to IDs ---
    const nameToId = new Map();
    for (const [id, name] of Object.entries(newColumns)) {
        nameToId.set(name, id);
    }
    const actions = tabConfig.actions.map((action) => {
        // Target is already an ID (exists as key in columns)
        if (newColumns[action.target] !== undefined) {
            return action;
        }
        // Target is a column name — migrate to ID
        const id = nameToId.get(action.target);
        if (id) {
            messages.push(`✓ action "${action.id}": target "${action.target}" → ${id} (migrated to ID)`);
            return { ...action, target: id };
        }
        // Legacy migration: action.id was used as the range name in the old system
        const legacyColIndex = sheetRanges.get(action.id);
        if (legacyColIndex !== undefined) {
            const currentHeader = headers[legacyColIndex];
            if (currentHeader) {
                const resolvedId = nameToId.get(currentHeader);
                if (resolvedId) {
                    messages.push(`✓ action "${action.id}": target "${action.target}" → ${resolvedId} (legacy migration)`);
                    return { ...action, target: resolvedId };
                }
            }
        }
        return action;
    });
    if (actions.some((s, i) => s !== tabConfig.actions[i])) {
        configChanged = true;
    }
    // Update tab config
    tabConfig.columns = newColumns;
    tabConfig.actions = actions;
    // Build the final v2 config
    const updatedConfig = {
        ...config,
        version: "2",
        tabs,
        // Clear v1 top-level fields after migration
        columns: undefined,
        actions: [],
        settings: config.settings,
    };
    return {
        config: updatedConfig,
        tabGid,
        tabConfig,
        messages,
        configChanged,
    };
}
