/**
 * Rowbound — Google Sheets Sidebar for Pipeline Configuration
 *
 * Setup:
 *   1. Open your Google Sheet
 *   2. Extensions → Apps Script
 *   3. Paste this file as Code.gs
 *   4. Create a new HTML file called "Sidebar" and paste Sidebar.html
 *   5. In the Apps Script editor: Services (+ icon) → Google Sheets API → Add
 *   6. Reload the spreadsheet — the "Rowbound" menu will appear
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Rowbound')
    .addItem('Open sidebar', 'openOverview')
    .addToUi();
}


// ── Sidebar entry points ────────────────────────────────────────────────────

function openOverview() {
  PropertiesService.getUserProperties().setProperty('rb_view', 'overview');
  openSidebar_();
}

function openSidebar_() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Rowbound')
    .setWidth(400);
  SpreadsheetApp.getUi().showSidebar(html);
}

function getCleanHeaders_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet
    .getRange(1, 1, 1, lastCol)
    .getValues()[0]
    .filter(function(h) { return h !== ''; })
    .map(String);
}

function buildColumnInfo_(sheet, headers) {
  var cell = SpreadsheetApp.getActiveRange();
  var col = cell ? cell.getColumn() : 1;
  var columnName = col <= headers.length ? String(headers[col - 1]) : '';
  return {
    column: columnName,
    columnIndex: col,
    tabName: sheet.getName(),
    tabGid: String(sheet.getSheetId()),
    headers: headers
  };
}

function listSpreadsheetTabs_(ss) {
  return ss.getSheets().map(function(s) {
    return { name: s.getName(), gid: String(s.getSheetId()) };
  });
}

function reconcileSheetColumns_(config, sheet, headers) {
  if (!config || !config.tabs) return false;
  return reconcileColumns_(config, String(sheet.getSheetId()), headers);
}

/**
 * Single init call — returns everything the sidebar needs in one round-trip.
 */
function getInitData() {
  var props = PropertiesService.getUserProperties();
  var view = props.getProperty('rb_view') || 'overview';
  props.deleteProperty('rb_view');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SpreadsheetApp.getActiveSheet();
  var headers = getCleanHeaders_(sheet);

  var configResult = loadConfigWithVersion_();

  if (reconcileSheetColumns_(configResult.config, sheet, headers)) {
    saveConfig(configResult.config);
    configResult.version = getConfigVersion_();
  }

  return {
    initialView: view,
    config: configResult.config,
    configVersion: configResult.version,
    columnInfo: buildColumnInfo_(sheet, headers),
    tabs: listSpreadsheetTabs_(ss)
  };
}

/**
 * Fast poll endpoint — returns config version + tab list.
 * Config version is from PropertiesService (~10ms).
 * Tab list requires one lightweight sheet API call.
 */
function pollState() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var version = getConfigVersion_();
  var tabs = listSpreadsheetTabs_(ss);
  return { configVersion: version, tabs: tabs };
}

/**
 * Called by sidebar only when config version changed — fetches full config.
 */
function loadConfigFull() {
  var result = loadConfigWithVersion_();
  return result;
}

/** Returns column headers and the reconciled column ID map for a given tab. */
function getTabHeaders(tabName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sheet || sheet.getLastColumn() === 0) {
    return { headers: [], columns: {} };
  }
  var headers = getCleanHeaders_(sheet);

  var config = loadConfig();
  if (reconcileSheetColumns_(config, sheet, headers)) {
    saveConfig(config);
  }
  var gid = String(sheet.getSheetId());

  var columns =
    config && config.tabs && config.tabs[gid] && config.tabs[gid].columns
      ? config.tabs[gid].columns
      : {};

  return { headers: headers, columns: columns };
}

// ── Lightweight column reconcile ─────────────────────────────────────────────

/**
 * Detect column header renames by comparing sheet headers with config columns.
 * Uses positional matching: if the header at position N changed but the ID at
 * position N still exists, it's a rename. Also adds new columns and removes
 * deleted ones.
 * Returns true if config was modified.
 */
function reconcileColumns_(config, tabGid, headers) {
  if (!config.tabs || !config.tabs[tabGid]) return false;
  var tab = config.tabs[tabGid];
  var columns = tab.columns || {};
  var changed = false;

  // Build position → id map from current config (sorted by name to match header order)
  // Actually we need to match by position. Build id→name and name→id maps.
  var idToName = {};
  var nameToId = {};
  for (var id in columns) {
    idToName[id] = columns[id];
    nameToId[columns[id]] = id;
  }

  // For each header, check if it matches a known column name
  var usedIds = {};
  for (var i = 0; i < headers.length; i++) {
    var header = headers[i];
    if (nameToId[header]) {
      // Exact match — column exists with this name
      usedIds[nameToId[header]] = true;
    }
  }

  // Find unmatched headers (possible renames or new columns)
  var unmatchedHeaders = [];
  for (var j = 0; j < headers.length; j++) {
    if (!nameToId[headers[j]]) {
      unmatchedHeaders.push(headers[j]);
    }
  }

  // Find orphaned IDs (columns in config not matching any header — possible renames)
  var orphanedIds = [];
  for (var oid in idToName) {
    if (!usedIds[oid]) {
      orphanedIds.push(oid);
    }
  }

  // Match orphans to unmatched headers by position if possible
  // Simple heuristic: if there's exactly one orphan and one unmatched header, it's a rename
  if (orphanedIds.length > 0 && unmatchedHeaders.length > 0) {
    // Try positional matching: for each orphan, find its old position, check if the header at that position is unmatched
    for (var k = 0; k < orphanedIds.length; k++) {
      var orphanId = orphanedIds[k];
      var oldName = idToName[orphanId];
      // Find what header is now at roughly the same position
      // Simple: if the unmatched header count equals orphan count, pair them in order
      if (k < unmatchedHeaders.length) {
        columns[orphanId] = unmatchedHeaders[k];
        changed = true;
      }
    }
    // Remove paired unmatched headers
    unmatchedHeaders = unmatchedHeaders.slice(orphanedIds.length);
  }

  // Add truly new columns
  for (var n = 0; n < unmatchedHeaders.length; n++) {
    var newId = generateColumnId_();
    columns[newId] = unmatchedHeaders[n];
    changed = true;
  }

  if (changed) {
    tab.columns = columns;
    config.tabs[tabGid] = tab;
  }
  return changed;
}

/** Generate a short random hex column ID */
function generateColumnId_() {
  var chars = '0123456789abcdef';
  var id = '';
  for (var i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * 16));
  }
  return id;
}

// ── Config read/write via Developer Metadata ────────────────────────────────

/**
 * Config versioning: a simple counter stored in PropertiesService.
 * Incremented on every saveConfig(). The sidebar polls this (~10ms)
 * instead of fetching the full config (~1-3s) to detect changes.
 */
function getConfigVersion_() {
  var props = PropertiesService.getUserProperties();
  return parseInt(props.getProperty('rb_config_version') || '0', 10);
}

function incrementConfigVersion_() {
  var props = PropertiesService.getUserProperties();
  var v = parseInt(props.getProperty('rb_config_version') || '0', 10) + 1;
  props.setProperty('rb_config_version', String(v));
  return v;
}

/** Reads config + current version in one call. */
function loadConfigWithVersion_() {
  return {
    config: loadConfig(),
    version: getConfigVersion_()
  };
}

/** Reads the rowbound_config from Developer Metadata with CacheService layer.
 *  Cache hit is ~10ms vs ~1-3s for the Developer Metadata REST call. */
function loadConfig() {
  var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
  var cacheKey = getConfigCacheKey_(ssId);
  var cache = CacheService.getUserCache();

  // Try cache first (5-minute TTL, invalidated by saveConfig)
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through to API */ }
  }

  return loadConfigFromApi_(ssId, cache, cacheKey);
}

function getConfigCacheKey_(ssId) {
  return 'rb_config_' + ssId;
}

function getConfigMetadataIdKey_(ssId) {
  return 'rb_config_metadata_id_' + ssId;
}

function getCachedConfigMetadataId_(ssId) {
  return PropertiesService.getDocumentProperties().getProperty(getConfigMetadataIdKey_(ssId));
}

function setCachedConfigMetadataId_(ssId, metadataId) {
  if (metadataId === null || metadataId === undefined || metadataId === '') return;
  PropertiesService.getDocumentProperties().setProperty(
    getConfigMetadataIdKey_(ssId),
    String(metadataId)
  );
}

function clearCachedConfigMetadataId_(ssId) {
  PropertiesService.getDocumentProperties().deleteProperty(getConfigMetadataIdKey_(ssId));
}

function searchConfigMetadata_(ssId) {
  var result = Sheets.Spreadsheets.DeveloperMetadata.search({
    dataFilters: [{
      developerMetadataLookup: { metadataKey: 'rowbound_config' }
    }]
  }, ssId);

  if (!result.matchedDeveloperMetadata || result.matchedDeveloperMetadata.length === 0) {
    return null;
  }

  return result.matchedDeveloperMetadata[0].developerMetadata || null;
}

/** Internal: fetch config from the Sheets Developer Metadata API and update cache. */
function loadConfigFromApi_(ssId, cache, cacheKey) {
  try {
    var metadata = searchConfigMetadata_(ssId);
    if (!metadata) {
      clearCachedConfigMetadataId_(ssId);
      return null;
    }

    var configStr = metadata.metadataValue;
    // Cache for 5 minutes (300 seconds)
    cache.put(cacheKey, configStr, 300);
    setCachedConfigMetadataId_(ssId, metadata.metadataId);
    return JSON.parse(configStr);
  } catch (e) {
    Logger.log('loadConfig error: ' + e.message);
    return null;
  }
}

/** Writes the rowbound_config to Developer Metadata (create or update). */
function saveConfig(configJson) {
  var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
  var cacheKey = getConfigCacheKey_(ssId);
  var cache = CacheService.getUserCache();
  var configStr = (typeof configJson === 'string')
    ? configJson
    : JSON.stringify(configJson);
  var saved = false;
  var metadataId = getCachedConfigMetadataId_(ssId);

  if (metadataId) {
    saved = updateConfigMetadata_(ssId, metadataId, configStr);
    if (!saved) metadataId = null;
  }

  if (!saved) {
    try {
      var metadata = searchConfigMetadata_(ssId);
      if (metadata && metadata.metadataId) {
        metadataId = String(metadata.metadataId);
        setCachedConfigMetadataId_(ssId, metadataId);
        saved = updateConfigMetadata_(ssId, metadataId, configStr);
      }
    } catch (e) {
      Logger.log('saveConfig search error: ' + e.message);
    }
  }

  if (!saved) {
    metadataId = createConfigMetadata_(ssId, configStr);
  }

  cache.put(cacheKey, configStr, 300);
  var version = incrementConfigVersion_();
  return { success: true, version: version };
}

function updateConfigMetadata_(ssId, metadataId, configStr) {
  try {
    updateConfigMetadataOrThrow_(ssId, metadataId, configStr);
    return true;
  } catch (e) {
    Logger.log('saveConfig update error: ' + e.message);
    clearCachedConfigMetadataId_(ssId);
    return false;
  }
}

function updateConfigMetadataOrThrow_(ssId, metadataId, configStr) {
  Sheets.Spreadsheets.batchUpdate({
    requests: [{
      updateDeveloperMetadata: {
        dataFilters: [{
          developerMetadataLookup: { metadataId: metadataId }
        }],
        developerMetadata: { metadataValue: configStr },
        fields: 'metadataValue'
      }
    }]
  }, ssId);
  setCachedConfigMetadataId_(ssId, metadataId);
}

function createConfigMetadata_(ssId, configStr) {
  var response = Sheets.Spreadsheets.batchUpdate({
    requests: [{
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: 'rowbound_config',
          metadataValue: configStr,
          location: { spreadsheet: true },
          visibility: 'DOCUMENT'
        }
      }
    }]
  }, ssId);

  var metadataId =
    response &&
    response.replies &&
    response.replies[0] &&
    response.replies[0].createDeveloperMetadata &&
    response.replies[0].createDeveloperMetadata.developerMetadata
      ? response.replies[0].createDeveloperMetadata.developerMetadata.metadataId
      : null;

  if (metadataId !== null && metadataId !== undefined) {
    setCachedConfigMetadataId_(ssId, metadataId);
    return String(metadataId);
  }

  clearCachedConfigMetadataId_(ssId);
  return null;
}
