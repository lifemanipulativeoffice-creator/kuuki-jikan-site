// ==========================================================
// Google Sheets からデータを読み取るだけのモジュール。
// 【重要】書き込みは一切行わない（読み取り専用）。
// 【重要】患者名などのセル内テキストはここでは取得するが、
//         上位のロジック（availability.js）から先には絶対に渡さない。
// ==========================================================

const { google } = require('googleapis');
const config = require('../config/config');

let cachedAuthClient = null;

function getAuthClient() {
  if (cachedAuthClient) return cachedAuthClient;

  if (!config.google.serviceAccountKeyJson) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません。.env を確認してください。'
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(config.google.serviceAccountKeyJson);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY のJSONが不正です。');
  }

  cachedAuthClient = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return cachedAuthClient;
}

/**
 * スプレッドシートから、セルの値と背景色をまとめて取得する。
 * 戻り値は「行ごとの配列（各セル { value, backgroundColor }）」というシンプルな構造。
 */
async function fetchSheetGridData() {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const { sheetName } = config.google;

  const res = await sheets.spreadsheets.get({
    spreadsheetId: config.google.spreadsheetId,
    ranges: [sheetName],
    includeGridData: true,
    fields:
      'sheets.data.rowData.values(formattedValue,effectiveFormat.backgroundColor)',
  });

  const sheetData = res.data.sheets && res.data.sheets[0] && res.data.sheets[0].data;
  if (!sheetData || !sheetData[0]) {
    throw new Error('スプレッドシートのデータを取得できませんでした。');
  }

  const rowData = sheetData[0].rowData || [];

  // 行ごとに { value, backgroundColor } の配列へ変換
  return rowData.map((row) => {
    const values = row.values || [];
    return values.map((cell) => ({
      value: cell.formattedValue || '',
      // 背景色が設定されていない場合は白扱い（デフォルトは白背景のため）
      backgroundColor: cell.effectiveFormat && cell.effectiveFormat.backgroundColor
        ? cell.effectiveFormat.backgroundColor
        : { red: 1, green: 1, blue: 1 },
    }));
  });
}

/**
 * 「手動設定」タブから、管理者が上書き入力した ○/△/× を取得する。
 * タブが存在しない・空の場合はエラーにせず空オブジェクトを返す
 * （手動設定は任意機能であり、未設定でも自動計算だけで正常に動作させるため）。
 * 戻り値: { 'YYYY-MM-DD': '○' | '△' | '×' }
 */
async function fetchManualOverrides() {
  const { sheetName, startRow, dateColumn, statusColumn } = config.overrideSheet;
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.google.spreadsheetId,
      range: `${sheetName}!A${startRow}:C`,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const rows = res.data.values || [];
    const overrides = {};

    rows.forEach((row) => {
      const rawDate = row[dateColumn - 1];
      const rawStatus = row[statusColumn - 1];
      if (!rawDate || !rawStatus) return;

      const status = String(rawStatus).trim();
      if (!['○', '△', '×'].includes(status)) return;

      const d = new Date(String(rawDate).trim());
      if (isNaN(d.getTime())) return;
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

      overrides[iso] = status;
    });

    return overrides;
  } catch (err) {
    // 「手動設定」タブが存在しない場合など。自動計算のみで動作を継続する。
    console.warn('手動設定タブの読み取りをスキップしました:', err.message);
    return {};
  }
}

module.exports = { fetchSheetGridData, fetchManualOverrides };
