// ==========================================================
// シンプルなインメモリキャッシュ。
// Google Sheets APIへのアクセス回数を抑えつつ、
// 「あくまで目安」の空き状況を配信するための仕組み。
// 複雑な永続化キャッシュ(Redis等)はあえて使わない。
// ==========================================================

const config = require('../config/config');

let cachedGridData = null;
let cachedOverrides = null;
let cachedAt = 0;

function isFresh() {
  if (!cachedGridData) return false;
  const ageMs = Date.now() - cachedAt;
  return ageMs < config.server.cacheMinutes * 60 * 1000;
}

function get() {
  return isFresh() ? cachedGridData : null;
}

function set(data) {
  cachedGridData = data;
  cachedAt = Date.now();
}

function getOverrides() {
  return isFresh() ? cachedOverrides : null;
}

function setOverrides(data) {
  cachedOverrides = data;
}

function clear() {
  cachedGridData = null;
  cachedOverrides = null;
  cachedAt = 0;
}

function getCachedAt() {
  return cachedAt;
}

module.exports = { get, set, getOverrides, setOverrides, clear, isFresh, getCachedAt };
