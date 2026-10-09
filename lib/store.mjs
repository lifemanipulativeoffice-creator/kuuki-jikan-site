// =========================================================
// 保存先
// - Netlify 上：Netlify Blobs（日付ごとのキー days/YYYY-MM-DD）
// - ローカル確認用：YOYAKU_LOCAL_DIR に JSON ファイル
// 書き込みは ETag を使った条件付き保存。ほかの端末が同じ日を
// 同時に保存しても、後から来た方が読み直してやり直すので上書き事故が起きない。
// =========================================================
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const STORE_NAME = 'yoyaku-chan';
const PREFIX = 'days/';

function localDir() { return process.env.YOYAKU_LOCAL_DIR || ''; }

async function blobStore() {
  const { getStore } = await import('@netlify/blobs');
  // V2形式の Netlify Functions ではサイト情報が自動で渡されるので引数は名前だけでよい
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function hash(text) { return createHash('sha1').update(text).digest('hex'); }

/* ---------- ローカル(確認用)：キーの / を __ にしてファイル名にする ---------- */
const fileOf = key => path.join(localDir(), key.replace(/\//g, '__') + '.json');
async function localGet(key) {
  try {
    const text = await fs.readFile(fileOf(key), 'utf8');
    return { data: JSON.parse(text), etag: hash(text) };
  } catch { return null; }
}
async function localSet(key, data, etag) {
  const cur = await localGet(key);
  if (etag === null && cur) return false;
  if (etag && (!cur || cur.etag !== etag)) return false;
  await fs.mkdir(localDir(), { recursive: true });
  await fs.writeFile(fileOf(key), JSON.stringify(data), 'utf8');
  return true;
}
async function localList(prefix) {
  const pre = prefix.replace(/\//g, '__');
  try {
    return (await fs.readdir(localDir())).filter(f => f.startsWith(pre) && f.endsWith('.json'))
      .map(f => f.slice(0, -5).replace(/__/g, '/')).sort();
  } catch { return []; }
}

/* ---------- キー単位の読み書き ---------- */
// 戻り値：{ data, etag } または null
export async function getKey(key) {
  if (localDir()) return localGet(key);
  const store = await blobStore();
  const r = await store.getWithMetadata(key, { type: 'json' });
  return r ? { data: r.data, etag: r.etag } : null;
}

// etag: 読んだときの値 / null = 新規作成 / undefined = 無条件。保存できたら true
export async function setKey(key, data, etag) {
  if (localDir()) {
    if (etag === undefined) { await fs.mkdir(localDir(), { recursive: true }); await fs.writeFile(fileOf(key), JSON.stringify(data)); return true; }
    return localSet(key, data, etag);
  }
  const store = await blobStore();
  const opts = etag === undefined ? {} : etag === null ? { onlyIfNew: true } : { onlyIfMatch: etag };
  const r = await store.setJSON(key, data, opts);
  return r && typeof r.modified === 'boolean' ? r.modified : true;
}

export async function listKeys(prefix) {
  if (localDir()) return localList(prefix);
  const store = await blobStore();
  const { blobs } = await store.list({ prefix });
  return blobs.map(b => b.key).sort();
}

// 読み込み→変更→条件付き保存。競合したら最大5回やり直す
export async function updateKey(key, mutate) {
  for (let i = 0; i < 5; i++) {
    const cur = await getKey(key);
    const next = mutate(cur ? cur.data : null);
    if (await setKey(key, next, cur ? cur.etag : null)) return next;
    await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
  }
  const err = new Error('ほかの端末と同時に保存されたため保存できませんでした。もう一度お試しください。');
  err.status = 409;
  throw err;
}

/* ---------- 日ごとの予約 ---------- */
export const getDay = date => getKey(PREFIX + date);
export const setDay = (date, data, etag) => setKey(PREFIX + date, data, etag);
export const updateDay = (date, mutate) => updateKey(PREFIX + date, mutate);
export async function listDates() { return (await listKeys(PREFIX)).map(k => k.slice(PREFIX.length)); }
