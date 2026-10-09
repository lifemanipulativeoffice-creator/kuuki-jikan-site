// =========================================================
// スプレッドシート(CMYK臨時予約表)からの取り込み
// 移行時に使う。外部ライブラリなしで Google Sheets API を読む。
// 既存サイトと同じ環境変数 GOOGLE_SPREADSHEET_ID / GOOGLE_SHEET_NAME /
// GOOGLE_SERVICE_ACCOUNT_KEY を使う（読み取り専用の権限だけ要求）。
// =========================================================
import { createSign } from 'node:crypto';
import { GRID, isGridTime, minutesToTime, cleanName, addDays } from './core.mjs';
import { httpError } from './auth.mjs';

const LAYOUT = { hourHeaderRow: 1, minuteHeaderRow: 2, dataStartRow: 3 };

/* ---------- 色 → 予約ちゃんの色（既存 classifyColor と同じ境界値） ---------- */
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

// 戻り値：null(空き/白) | 'pink' | 'red' | 'blue' | 'gray' と、想定外だったかどうか（薄い水色は区切りなので白にする）
export function mapSheetColor(color) {
  if (!color || typeof color !== 'object') return { c: null };
  if (color.red === undefined && color.green === undefined && color.blue === undefined) return { c: null };
  // Sheets API は 0 の成分を省略して返すので 0 で補う
  const { h, s, l } = rgbToHsl(color.red ?? 0, color.green ?? 0, color.blue ?? 0);
  if (l >= 0.90) return { c: null };
  if (s <= 0.08) return { c: l >= 0.75 ? null : 'gray' };
  if ((h >= 0 && h <= 15) || (h >= 345 && h <= 360)) return { c: 'red' };
  if (h >= 300 && h < 345) return { c: 'pink' };
  if (h >= 180 && h <= 260) return { c: l >= 0.80 ? null : 'blue' };
  return { c: 'gray', unexpected: true }; // 想定外の色は埋まり扱い(安全側)でグレーに
}

/* ---------- 見出し → 時刻の対応表 ---------- */
function parseHour(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export function buildColumnTimes(hourRow, minuteRow) {
  const map = new Map(); // 列番号(0始まり) → "HH:MM"
  let cur = null;
  const last = Math.max(hourRow.length, minuteRow.length);
  for (let c = 1; c < last; c++) {
    const h = parseHour(hourRow[c]);
    if (h !== null) cur = h;
    const off = Number(String(minuteRow[c] ?? '').trim());
    if (cur === null || !String(minuteRow[c] ?? '').trim() || Number.isNaN(off)) continue;
    const t = minutesToTime(cur + off - 10);
    if (isGridTime(t)) map.set(c, t);
  }
  return map;
}

function serialToDate(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* ---------- 1行分のセル → 予約ちゃんの1日分 ---------- */
export function rowToDay(cells, columnTimes, stats) {
  const day = { closed: false, cells: {} };
  for (const [col, t] of columnTimes) {
    const cell = cells[col] || {};
    const { c, unexpected } = mapSheetColor(cell.bg);
    if (unexpected) stats.unexpectedColors++;
    const n = cleanName(cell.text || '');
    if (cell.text && Array.from(String(cell.text).trim()).length > 20) stats.truncatedNames++;
    if (c || n) day.cells[t] = Object.assign({}, c ? { c } : {}, n ? { n } : {});
  }
  return day;
}

/* ---------- Google 認証（サービスアカウントのJWT） ---------- */
async function accessToken() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
  if (!raw.startsWith('{')) throw httpError(500, '取り込み用の GOOGLE_SERVICE_ACCOUNT_KEY（JSON）が設定されていません。');
  const key = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  });
  const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
  });
  const json = await res.json();
  if (!res.ok) throw httpError(502, 'Google認証に失敗しました：' + (json.error_description || json.error || res.status));
  return json.access_token;
}

async function sheetsGet(token, ranges, fields) {
  const id = process.env.GOOGLE_SPREADSHEET_ID;
  if (!id) throw httpError(500, 'GOOGLE_SPREADSHEET_ID が設定されていません。');
  const qs = new URLSearchParams({ includeGridData: 'true', fields });
  ranges.forEach(r => qs.append('ranges', r));
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?${qs}`, {
    headers: { authorization: 'Bearer ' + token },
  });
  const json = await res.json();
  if (!res.ok) throw httpError(502, 'シートを読めませんでした：' + (json.error?.message || res.status));
  return json.sheets?.[0]?.data || [];
}

function q(name) { return "'" + name.replace(/'/g, "''") + "'"; }

// from〜to（YYYY-MM-DD）の日付を取り込み、{ days: {日付: 1日分}, stats } を返す
export async function readSheetRange(from, to) {
  const sheet = q(process.env.GOOGLE_SHEET_NAME || 'CMYK臨時予約表');
  const token = await accessToken();

  // ① 日付列だけ読み、対象日の行番号を探す（同じ日付が複数あれば最後の行）
  const [colA] = await sheetsGet(token, [`${sheet}!A${LAYOUT.dataStartRow}:A`],
    'sheets.data.rowData.values(effectiveValue,formattedValue,effectiveFormat.numberFormat)');
  const rowOf = new Map();
  (colA?.rowData || []).forEach((row, i) => {
    const cell = row.values?.[0] || {};
    const num = cell.effectiveValue?.numberValue;
    let date = null;
    if (cell.effectiveFormat?.numberFormat?.type === 'DATE' && typeof num === 'number') {
      date = serialToDate(num);
    } else {
      const m = /^(\d{1,2})月(\d{1,2})日/.exec(String(cell.formattedValue || ''));
      if (m) {
        for (const y of new Set([from.slice(0, 4), to.slice(0, 4)])) {
          const cand = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
          if (cand >= from && cand <= to) date = cand;
        }
      }
    }
    if (date && date >= from && date <= to) rowOf.set(date, LAYOUT.dataStartRow + i);
  });

  const stats = { days: 0, cells: 0, unexpectedColors: 0, truncatedNames: 0, missingDates: [], perDay: [] };
  if (rowOf.size === 0) return { days: {}, stats };

  const rows = [...rowOf.values()];
  const minRow = Math.min(...rows), maxRow = Math.max(...rows);

  // ② 見出し行と対象範囲の行をまとめて取得
  const fields = 'sheets.data.rowData.values(formattedValue,effectiveFormat.backgroundColor)';
  const [head, body] = await sheetsGet(token, [`${sheet}!A1:ZZ2`, `${sheet}!A${minRow}:ZZ${maxRow}`], fields);
  const toCells = r => (r?.values || []).map(v => ({ text: v.formattedValue ?? '', bg: v.effectiveFormat?.backgroundColor }));
  const headRows = head?.rowData || [];
  const columnTimes = buildColumnTimes(toCells(headRows[0]).map(c => c.text), toCells(headRows[1]).map(c => c.text));
  if (columnTimes.size === 0) throw httpError(422, 'シートの1〜2行目から時刻を読み取れませんでした。');

  const bodyRows = body?.rowData || [];
  const days = {};
  for (const [date, row] of rowOf) {
    const day = rowToDay(toCells(bodyRows[row - minRow]), columnTimes, stats);
    days[date] = day;
    stats.days++;
    stats.cells += Object.keys(day.cells).length;
    stats.perDay.push({ date, cells: Object.keys(day.cells).length, names: Object.values(day.cells).filter(c => c.n).length });
  }
  stats.perDay.sort((a, b) => a.date.localeCompare(b.date));
  for (let d = from; d <= to; d = addDays(d, 1)) if (!rowOf.has(d)) stats.missingDates.push(d);
  return { days, stats };
}

export { GRID };
