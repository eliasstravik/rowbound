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
    .addItem('Open Rowbound', 'openOverview')
    .addToUi();
}


// ── Sidebar entry points ────────────────────────────────────────────────────

function openColumnConfig() {
  PropertiesService.getUserProperties().setProperty('rb_view', 'column');
  openSidebar_();
}

function openOverview() {
  PropertiesService.getUserProperties().setProperty('rb_view', 'overview');
  openSidebar_();
}

function openSources() {
  PropertiesService.getUserProperties().setProperty('rb_view', 'sources');
  openSidebar_();
}

function openScripts() {
  PropertiesService.getUserProperties().setProperty('rb_view', 'scripts');
  openSidebar_();
}

function openPipelineSettings() {
  PropertiesService.getUserProperties().setProperty('rb_view', 'settings');
  openSidebar_();
}

function openSidebar_() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Rowbound')
    .setWidth(400);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Single init call — returns everything the sidebar needs in one round-trip.
 */
function getInitData() {
  var props = PropertiesService.getUserProperties();
  var view = props.getProperty('rb_view') || 'column';
  props.deleteProperty('rb_view');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SpreadsheetApp.getActiveSheet();
  var cell = SpreadsheetApp.getActiveRange();
  var col = cell.getColumn();
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    : [];
  var columnName = (col <= headers.length) ? String(headers[col - 1]) : '';

  var configResult = loadConfigWithVersion_();

  return {
    initialView: view,
    config: configResult.config,
    configVersion: configResult.version,
    columnInfo: {
      column: columnName,
      columnIndex: col,
      tabName: sheet.getName(),
      tabGid: String(sheet.getSheetId()),
      headers: headers.filter(function(h) { return h !== ''; }).map(String)
    },
    tabs: ss.getSheets().map(function(s) {
      return { name: s.getName(), gid: String(s.getSheetId()) };
    })
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
  var tabs = ss.getSheets().map(function(s) {
    return { name: s.getName(), gid: String(s.getSheetId()) };
  });
  return { configVersion: version, tabs: tabs };
}

/**
 * Called by sidebar only when config version changed — fetches full config.
 */
function loadConfigFull() {
  var result = loadConfigWithVersion_();
  return result;
}

/** Returns column headers for a given tab. */
function getTabHeaders(tabName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sheet || sheet.getLastColumn() === 0) return [];
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.filter(function(h) { return h !== ''; }).map(String);
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
  var cacheKey = 'rb_config_' + ssId;
  var cache = CacheService.getUserCache();

  // Try cache first (5-minute TTL, invalidated by saveConfig)
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through to API */ }
  }

  return loadConfigFromApi_(ssId, cache, cacheKey);
}

/** Internal: fetch config from the Sheets Developer Metadata API and update cache. */
function loadConfigFromApi_(ssId, cache, cacheKey) {
  try {
    var result = Sheets.Spreadsheets.DeveloperMetadata.search({
      dataFilters: [{
        developerMetadataLookup: { metadataKey: 'rowbound_config' }
      }]
    }, ssId);

    if (!result.matchedDeveloperMetadata ||
        result.matchedDeveloperMetadata.length === 0) {
      return null;
    }
    var configStr = result.matchedDeveloperMetadata[0].developerMetadata.metadataValue;
    // Cache for 5 minutes (300 seconds)
    cache.put(cacheKey, configStr, 300);
    return JSON.parse(configStr);
  } catch (e) {
    Logger.log('loadConfig error: ' + e.message);
    return null;
  }
}

/** Writes the rowbound_config to Developer Metadata (create or update). */
function saveConfig(configJson) {
  var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
  var configStr = (typeof configJson === 'string')
    ? configJson
    : JSON.stringify(configJson);

  // Look for existing metadata
  var existingId = null;
  try {
    var result = Sheets.Spreadsheets.DeveloperMetadata.search({
      dataFilters: [{
        developerMetadataLookup: { metadataKey: 'rowbound_config' }
      }]
    }, ssId);
    if (result.matchedDeveloperMetadata &&
        result.matchedDeveloperMetadata.length > 0) {
      existingId = result.matchedDeveloperMetadata[0]
        .developerMetadata.metadataId;
    }
  } catch (e) { /* no existing config */ }

  // Invalidate cache and bump version
  var cacheKey = 'rb_config_' + ssId;
  CacheService.getUserCache().remove(cacheKey);
  incrementConfigVersion_();

  if (existingId !== null) {
    Sheets.Spreadsheets.batchUpdate({
      requests: [{
        updateDeveloperMetadata: {
          dataFilters: [{
            developerMetadataLookup: { metadataId: existingId }
          }],
          developerMetadata: { metadataValue: configStr },
          fields: 'metadataValue'
        }
      }]
    }, ssId);
  } else {
    Sheets.Spreadsheets.batchUpdate({
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
  }

  return { success: true };
}
