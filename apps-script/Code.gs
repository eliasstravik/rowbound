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
    .addItem('Actions', 'openOverview')
    .addItem('Settings', 'openPipelineSettings')
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

function openPipelineSettings() {
  PropertiesService.getUserProperties().setProperty('rb_view', 'settings');
  openSidebar_();
}

function openSidebar_() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Rowbound')
    .setWidth(360);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Single init call — returns everything the sidebar needs in one round-trip.
 * This replaces the 4 separate calls (loadConfig, getActiveColumnInfo,
 * getTabList, getInitialView) to eliminate loading latency.
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

  return {
    initialView: view,
    config: loadConfig(),
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

/** Returns column headers for a given tab. */
function getTabHeaders(tabName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sheet || sheet.getLastColumn() === 0) return [];
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.filter(function(h) { return h !== ''; }).map(String);
}

// ── Config read/write via Developer Metadata ────────────────────────────────

/** Reads the rowbound_config from Developer Metadata. Returns null if none. */
function loadConfig() {
  var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
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
    return JSON.parse(
      result.matchedDeveloperMetadata[0].developerMetadata.metadataValue
    );
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
