'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const config = require('./config');
const availability = require('./availability');
const manualOverridesStore = require('./manualOverridesStore');

const app = express();
app.use(express.json());

// ローカル実行（Termux等）ではpublicフォルダを直接配信する。
// Netlify上ではnetlify.tomlのpublish設定でNetlify自身が配信するため、
// この行はNetlify Functions実行時には呼ばれないが、害もない。
app.use(express.static(path.join(__dirname, 'public')));


/* =========================================================
   Google Sheets 接続
   - GOOGLE_SERVICE_ACCOUNT_KEY が「{ で始まるJSON文字列」ならそれを直接使う（Netlify向け）
   - そうでなければ、従来通りファイルパスとして読み込む（Termux向け）
========================================================= */
let sheetsClient = null;

function loadCredentials() {
  const raw = config.google.serviceAccountKeyJson;

  const trimmed = (raw || '').trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }

  const keyPath = path.resolve(__dirname, raw);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`サービスアカウントキーが見つかりません: ${keyPath}`);
  }
  return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
}

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  if (!config.google.serviceAccountKeyJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません。');
  }

  const credentials = loadCredentials();

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}


// 列番号(1始まり)を "A" "B" ... "AA" のような列記号に変換する
function columnNumberToLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/*
 * 日付列だけを軽量に読み取り、「今日から2週間前」以降のデータが
 * 何行目から始まるかを調べる。
 * 日付列がシリアル値（本物の日付形式）で入っている前提。
 * 万が一シリアル値が1件も見つからない場合は、安全のため
 * dataStartRow（＝これまで通り全件読み込み）にフォールバックする。
 */
async function findRecentStartRow(sheets) {
  const layout = config.sheetLayout;
  const dateColLetter = columnNumberToLetter(layout.dateColumn);

  const response = await sheets.spreadsheets.get({
    spreadsheetId: config.google.spreadsheetId,
    ranges: [`${config.google.sheetName}!${dateColLetter}:${dateColLetter}`],
    includeGridData: true,
    fields: 'sheets.data.rowData.values(effectiveValue,effectiveFormat.numberFormat)',
  });

  const rowData = response.data.sheets?.[0]?.data?.[0]?.rowData || [];

  const now = new Date();
  const todaySerial = availability.ymdToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const thresholdSerial = todaySerial - 14; // 2週間前

  for (let r = layout.dataStartRow - 1; r < rowData.length; r++) {
    const cell = (rowData[r]?.values || [])[0] || {};
    const isDateFormatted = cell.effectiveFormat?.numberFormat?.type === 'DATE';
    const numberValue = cell.effectiveValue?.numberValue;

    if (isDateFormatted && typeof numberValue === 'number' && numberValue >= thresholdSerial) {
      return r + 1; // 1始まりの実際の行番号
    }
  }

  // シリアル値が見つからなかった（日付が文字列のみ等）場合は、
  // 安全のため従来通り全件読み込みにフォールバックする。
  return layout.dataStartRow;
}

/*
 * シート全体を取得する。
 * 各セルについて、表示値・背景色に加えて「日付シリアル値」も保持する。
 *
 * パフォーマンスのため、実際に必要な範囲だけを読み込む：
 * 　①見出し行（1〜2行目）
 * 　②「今日の2週間前」以降のデータ行（それより古い行は読み込まない）
 * を1回のAPI呼び出しで取得する（事前に日付列だけ軽量スキャンして開始行を特定）。
 */
async function fetchSheetData() {
  const sheets = getSheetsClient();

  if (!config.google.spreadsheetId) {
    throw new Error('GOOGLE_SPREADSHEET_ID が設定されていません。');
  }

  const layout = config.sheetLayout;
  const headerLastRow = layout.dataStartRow - 1; // 見出し行の最終行（例: 2）

  const recentStartRow = await findRecentStartRow(sheets);
  // 見出し範囲とデータ開始行が重ならないようにする
  const effectiveStartRow = Math.max(recentStartRow, layout.dataStartRow);

  const ranges = [
    `${config.google.sheetName}!A1:ZZ${headerLastRow}`, // 見出し行
    `${config.google.sheetName}!A${effectiveStartRow}:ZZ`, // 直近〜未来のデータ行（末尾は指定しない＝最後まで）
  ];

  const response = await sheets.spreadsheets.get({
    spreadsheetId: config.google.spreadsheetId,
    ranges,
    includeGridData: true,
    fields:
      'sheets.data.rowData.values(' +
      'effectiveValue,' +
      'formattedValue,' +
      'effectiveFormat.backgroundColor,' +
      'effectiveFormat.numberFormat' +
      ')',
  });

  const rangeResults = response.data.sheets?.[0]?.data || [];
  const headerRowData = rangeResults[0]?.rowData || [];
  const dataRowData = rangeResults[1]?.rowData || [];

  const gridData = [];

  function pushRow(cells) {
    const row = [];
    const colors = [];
    const dateSerials = [];

    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c] || {};

      let value = cell.formattedValue ?? '';
      if (value === '' && cell.effectiveValue?.stringValue !== undefined) {
        value = cell.effectiveValue.stringValue;
      }

      row[c] = value;
      colors[c] = cell.effectiveFormat?.backgroundColor || {};

      const isDateFormatted = cell.effectiveFormat?.numberFormat?.type === 'DATE';
      const numberValue = cell.effectiveValue?.numberValue;
      if (isDateFormatted && typeof numberValue === 'number') {
        dateSerials[c] = numberValue;
      }
    }

    Object.defineProperty(row, '_backgroundColors', { value: colors, enumerable: false, writable: true });
    Object.defineProperty(row, '_dateSerials', { value: dateSerials, enumerable: false, writable: true });

    gridData.push(row);
  }

  // 見出し行（インデックス 0 〜 headerLastRow-1）
  for (let r = 0; r < headerLastRow; r++) {
    pushRow(headerRowData[r]?.values || []);
  }

  // effectiveStartRow が dataStartRow より後ろの場合、間の行は
  // 「読み込んでいない古い行」として空行を詰めておく（インデックスの整合性のため）。
  // ※ findDayRows は空行を検出すると continue するだけなので、
  //   ここに古いデータが実際に存在していても検索対象から外れるだけで安全。
  const skippedRows = effectiveStartRow - layout.dataStartRow;
  for (let i = 0; i < skippedRows; i++) {
    gridData.push([]);
  }

  // 直近〜未来のデータ行
  for (let r = 0; r < dataRowData.length; r++) {
    pushRow(dataRowData[r]?.values || []);
  }

  return gridData;
}


/* =========================================================
   手動○×設定（30分単位。○／要相談(△)／×／自動(空文字)を許可）
========================================================= */
const TIME_PATTERN = /^([01]\d|2[0-3]):(00|30)$/;
const VALID_STATUSES = ['○', '△', '×', ''];

app.get('/api/manual-overrides', async (req, res) => {
  try {
    const rawDate = String(req.query.date || '').trim();
    const date = (rawDate.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || rawDate;
    const overrides = await manualOverridesStore.readManualOverrides();
    res.json({ ok: true, date, data: overrides[date] || {} });
  } catch (error) {
    console.error('[MANUAL OVERRIDE GET ERROR]', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/manual-overrides', async (req, res) => {
  try {
    const rawDate = String(req.body?.date || '').trim();
    // "2026-09-10T00:00:00.000Z" のような、末尾に時刻が付いた形式も許容する
    const date = (rawDate.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || rawDate;
    const time = String(req.body?.time || '').trim();
    const status = String(req.body?.status || '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        ok: false,
        error: `日付が正しくありません。（受信した値: "${rawDate}"）`,
      });
    }
    if (!TIME_PATTERN.test(time)) {
      return res.status(400).json({ ok: false, error: '時間は30分単位（例: 10:00, 10:30）で指定してください。' });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ ok: false, error: '表示は○、要相談(△)、×、空欄のみ指定できます。' });
    }

    const overrides = await manualOverridesStore.readManualOverrides();
    if (!overrides[date]) overrides[date] = {};

    if (status === '') {
      delete overrides[date][time];
    } else {
      overrides[date][time] = status;
    }

    if (Object.keys(overrides[date]).length === 0) delete overrides[date];

    await manualOverridesStore.writeManualOverrides(overrides);
    res.json({ ok: true, date, time, status });

  } catch (error) {
    console.error('[MANUAL OVERRIDE WRITE ERROR]', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});


/* =========================================================
   管理者ログイン（簡易パスワード照合。セッションは持たない）
========================================================= */
app.post('/api/admin/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (password === config.admin.password) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'パスワードが違います。' });
  }
});


/* =========================================================
   空き状況API
========================================================= */
app.get('/api/availability/day', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ ok: false, error: 'date が指定されていません。' });
    }

    const gridData = await fetchSheetData();
    const allManualOverrides = await manualOverridesStore.readManualOverrides();
    const manualOverrides = allManualOverrides[date] || {};

    const detail = availability.buildDayDetail(gridData, date, manualOverrides);
    res.json({ ok: true, data: detail });

  } catch (error) {
    console.error('[DAY API ERROR]', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// トラブルシューティング用：シートの生データを確認する
app.get('/api/debug/sheet', async (req, res) => {
  try {
    const gridData = await fetchSheetData();
    res.json({
      ok: true,
      sheetName: config.google.sheetName,
      isNetlify: manualOverridesStore.IS_NETLIFY,
      rows: gridData.length,
      cols: gridData[0] ? gridData[0].length : 0,
      hourRow: gridData[config.sheetLayout.hourHeaderRow - 1] || null,
      minuteRow: gridData[config.sheetLayout.minuteHeaderRow - 1] || null,
      firstDataRows: gridData.slice(config.sheetLayout.dataStartRow - 1, config.sheetLayout.dataStartRow + 4),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, stack: error.stack });
  }
});


// このファイルが直接実行された場合（Termux等でのローカル起動）だけ
// listenする。Netlify Functionsからrequireされた場合はlistenせず、
// exportされたexpressアプリをそのままserverless-httpに渡す。
if (require.main === module) {
  app.listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port}`);
  });
}

module.exports = app;
