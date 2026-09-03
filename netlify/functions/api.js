// ==========================================================
// Netlify Functions 用ラッパー
// 既存の server.js（Express アプリ）を書き換えず、
// serverless-http でそのまま包んで関数として動かすだけ。
// ロジック（Google Sheets読み取り・○△×判定・個人情報保護）は
// 一切変更していない。
// ==========================================================

const serverless = require('serverless-http');
const app = require('../../server');

// Netlifyは関数を /.netlify/functions/api/... というパスで呼び出すため、
// その先頭部分を取り除き、Express側の /api/... ルート定義と一致させる。
exports.handler = serverless(app, { basePath: '/.netlify/functions/api' });
