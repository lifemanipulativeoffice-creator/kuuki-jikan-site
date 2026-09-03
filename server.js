// ==========================================================
// サーバー本体
// - Google Sheetsへの認証情報はここ(サーバー側)だけで扱う
// - 外部公開するAPIレスポンスには 日付・時刻・○△× 以外を含めない
// - Webサイト→Google Sheetsへの書き込みは一切行わない
// ==========================================================

const express = require('express');
const path = require('path');
const config = require('./config/config');
const cache = require('./lib/cache');
const { fetchSheetGridData, fetchManualOverrides } = require('./lib/googleSheetsClient');
const { buildMonthlyForecast, buildDayDetail } = require('./lib/availability');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

// 公開設定（LINE URLなどフロントで使う値。秘密情報は含まない）
app.get('/api/public-config', (req, res) => {
  res.json({
    lineUrl: config.links.lineUrl,
    officialSiteUrl: config.links.officialSiteUrl,
    businessStartTime: config.sheetLayout.businessStartTime,
    businessEndTime: config.sheetLayout.businessEndTime,
  });
});

async function getGridData() {
  const cached = cache.get();
  if (cached) return cached;
  const fresh = await fetchSheetGridData();
  cache.set(fresh);
  return fresh;
}

async function getOverrides() {
  const cached = cache.getOverrides();
  if (cached) return cached;
  const fresh = await fetchManualOverrides();
  cache.setOverrides(fresh);
  return fresh;
}

// 月間空き予報（例: /api/monthly?year=2026&month=9）
app.get('/api/monthly', async (req, res) => {
  try {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: 'year, month が不正です。' });
    }
    const gridData = await getGridData();
    const overrides = await getOverrides();
    const forecast = buildMonthlyForecast(gridData, year, month, overrides);
    res.json({ year, month, days: forecast });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '空き状況の取得に失敗しました。' });
  }
});

// 日別詳細（例: /api/daily?date=2026-09-01）
app.get('/api/daily', async (req, res) => {
  try {
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date は YYYY-MM-DD 形式で指定してください。' });
    }
    const gridData = await getGridData();
    const slots = buildDayDetail(gridData, date);
    res.json({ date, slots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '空き状況の取得に失敗しました。' });
  }
});

// 管理者用: キャッシュを手動でクリアして即座に最新化する
app.post('/api/admin/refresh', express.json(), (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!config.server.adminRefreshToken || token !== config.server.adminRefreshToken) {
    return res.status(403).json({ error: '権限がありません。' });
  }
  cache.clear();
  res.json({ ok: true, message: 'キャッシュをクリアしました。次回アクセス時に最新データを取得します。' });
});

// このファイルを直接 `node server.js` で実行したときだけサーバーを起動する。
// Netlify Functions（netlify/functions/api.js）から require されたときは
// app.listen を呼ばず、Express アプリ本体だけを渡す。
if (require.main === module) {
  app.listen(config.server.port, () => {
    console.log(`空き時間確認サイトを起動しました: http://localhost:${config.server.port}`);
  });
}

module.exports = app;
