'use strict';

// ==========================================================
// 手動○×設定の保存先を、実行環境によって自動的に切り替える。
//
// - Netlify Functions上で動いている場合 → Netlify Blobs（永続ストレージ）
// - それ以外（Termux等でのローカル実行） → 従来通りローカルのJSONファイル
//
// 【重要】このプロジェクトのnetlify/functions/api.jsは「V1形式」の
// Netlify Functionとして書かれている。V1形式ではBlobsのサイト情報が
// 自動注入されないため、NETLIFY_API_TOKENとNETLIFY_SITE_IDを
// 環境変数として明示的に渡す必要がある（公式ドキュメントで確認済み）。
// ==========================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');

const IS_NETLIFY = Boolean(
  process.env.NETLIFY ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

const LOCAL_FILE = path.resolve(__dirname, config.manualOverrideFile);
const BLOB_STORE_NAME = 'manual-overrides';
const BLOB_KEY = 'overrides';

function getBlobStore() {
  const { getStore } = require('@netlify/blobs');

  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;

  if (siteID && token) {
    return getStore({ name: BLOB_STORE_NAME, siteID, token });
  }

  // 自動注入される環境（V2 Functions等）ならこちらでも動く
  return getStore(BLOB_STORE_NAME);
}

async function readManualOverrides() {
  if (IS_NETLIFY) {
    const store = getBlobStore();
    const data = await store.get(BLOB_KEY, { type: 'json' });
    return data || {};
  }

  try {
    if (!fs.existsSync(LOCAL_FILE)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8') || '{}');
  } catch (error) {
    console.error('[MANUAL OVERRIDE READ ERROR]', error);
    return {};
  }
}

async function writeManualOverrides(data) {
  if (IS_NETLIFY) {
    const store = getBlobStore();
    await store.setJSON(BLOB_KEY, data);
    return;
  }

  fs.writeFileSync(LOCAL_FILE, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  IS_NETLIFY,
  readManualOverrides,
  writeManualOverrides,
};
