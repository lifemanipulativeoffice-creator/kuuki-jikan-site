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


/*
 * シート全体を取得する。
 * 各セルについて、表示値・背景色に加えて「日付シリアル値」も保持する。
 */
async function fetchSheetData() {
  const sheets = getSheetsClient();

  if (!config.google.spreadsheetId) {
    throw new Error('GOOGLE_SPREADSHEET_ID が設定されていません。');
  }

  const response = await sheets.spreadsheets.get({
    spreadsheetId: config.google.spreadsheetId,
    ranges: [config.google.sheetName + '!A:ZZ'],
    includeGridData: true,
    fields:
      'sheets.data.rowData.values(' +
      'effectiveValue,' +
      'formattedValue,' +
      'effectiveFormat.backgroundColor,' +
      'effectiveFormat.numberFormat' +
      ')',
  });

  const rowData = response.data.sheets?.[0]?.data?.[0]?.rowData || [];
  const gridData = [];

  for (let r = 0; r < rowData.length; r++) {
    const cells = rowData[r]?.values || [];
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

  return gridData;
}


/* =========================================================
   手動○×設定（30分単位。○／要相談(△)／×／自動(空文字)を許可）
========================================================= */
const TIME_PATTERN = /^([01]\d|2[0-3]):(00|30)$/;
const VALID_STATUSES = ['○', '△', '×', ''];

app.get('/api/manual-overrides', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    const overrides = await manualOverridesStore.readManualOverrides();
    res.json({ ok: true, date, data: overrides[date] || {} });
  } catch (error) {
    console.error('[MANUAL OVERRIDE GET ERROR]', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/manual-overrides', async (req, res) => {
  try {
    const date = String(req.body?.date || '').trim();
    const time = String(req.body?.time || '').trim();
    const status = String(req.body?.status || '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: '日付が正しくありません。' });
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
