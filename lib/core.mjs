// =========================================================
// 予約ちゃん：設定と空き判定（サーバー側でだけ使う）
// 判定ルールは既存の空き時間確認サイト(availability.js)と同じ。
// =========================================================

export const GRID = {
  startMinutes: 9 * 60,        // 編集表は 9:00 から
  endMinutes: 22 * 60,         // 21:50 の枠まで（22:00 は含まない）
  step: 10,                    // 10分刻み（スプレッドシートと同じ）
};

export const BUSINESS = {
  startHour: 10,
  endHour: 22,   // 営業は 10:00〜22:00（21時台も正規の時間）
  displaySlotMinutes: 30,
  treatmentMinutes: 60,
  bufferMinutes: 30,
};

// 色：埋まり扱い(blocks:true) / 空き(blocks:false)。薄水色は隣の予約と区別するための区切りで、予約ではない
export const COLORS = {
  pink:  { label: 'ピンク', blocks: true },
  blue:  { label: '青',     blocks: true },
  red:   { label: '赤',     blocks: true },
  gray:  { label: 'グレー', blocks: true },
  light: { label: '薄水色', blocks: false },
};

export const NAME_MAX = 20;
// 患者向けに表示する範囲（今日から何日先まで）。それより先は「－」
export const PUBLIC_DAYS_AHEAD = Number(process.env.PUBLIC_DAYS_AHEAD || 90);

export function pad(n) { return String(n).padStart(2, '0'); }
export function minutesToTime(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
export function timeToMinutes(t) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const GRID_TIMES = [];
for (let m = GRID.startMinutes; m < GRID.endMinutes; m += GRID.step) GRID_TIMES.push(minutesToTime(m));
const GRID_TIME_SET = new Set(GRID_TIMES);
export function isGridTime(t) { return GRID_TIME_SET.has(t); }

export function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
}

export function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// 日本時間の今日
export function todayJst() {
  if (process.env.YOYAKU_TODAY && isValidDate(process.env.YOYAKU_TODAY)) return process.env.YOYAKU_TODAY; // テスト用
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

export function emptyDay() { return { closed: false, cells: {} }; }

// 保存データを正規化（壊れたデータが来ても安全な形にそろえる）
export function normalizeDay(raw) {
  const day = emptyDay();
  if (!raw || typeof raw !== 'object') return day;
  day.closed = raw.closed === true;
  const cells = raw.cells && typeof raw.cells === 'object' ? raw.cells : {};
  for (const [t, cell] of Object.entries(cells)) {
    if (!isGridTime(t) || !cell || typeof cell !== 'object') continue;
    const c = COLORS[cell.c] ? cell.c : null;
    const n = cleanName(cell.n);
    const sr = typeof cell.s === 'string' && /^[wf]:[\w:.-]{1,60}$/.test(cell.s) ? cell.s : '';
    if (c || n) day.cells[t] = Object.assign({}, c ? { c } : {}, n ? { n } : {}, sr ? { s: sr } : {});
  }
  return day;
}

export function cleanName(v) {
  if (typeof v !== 'string') return '';
  // 制御文字を除去し、前後の空白を落として最大文字数で切る
  return Array.from(v.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, NAME_MAX).join('');
}

/* ---------- 空き判定 ---------- */
function isOccupied(day, t) {
  const cell = day.cells[minutesToTime(t)];
  if (!cell) return false;
  if (cell.c && COLORS[cell.c].blocks) return true;
  // 営業時間外は「完全な空白」だけを空きとして扱う（既存サイトと同じ）。ただし薄水色の区切りは常に空き
  const inBusiness = t >= BUSINESS.startHour * 60 && t < BUSINESS.endHour * 60;
  const onlyDivider = cell.c === 'light' && !cell.n;
  if (!inBusiness && !onlyDivider && (cell.c || cell.n)) return true;
  return false;
}

function rangeOccupied(day, start, end) {
  for (let t = start; t < end; t += GRID.step) {
    if (t < GRID.startMinutes || t >= GRID.endMinutes) continue;
    if (isOccupied(day, t)) return true;
  }
  return false;
}

function evaluateSlot(day, start) {
  const { treatmentMinutes: tm, bufferMinutes: bm } = BUSINESS;
  if (rangeOccupied(day, start, start + tm)) return 'full';
  if (rangeOccupied(day, start - bm, start) || rangeOccupied(day, start + tm, start + tm + bm)) return 'consult';
  return 'available';
}

export const DISPLAY_TIMES = [];
// 患者向けの最後の枠は「施術が営業終了までに終わる時刻」（22:00終了なら21:00開始）
for (let m = BUSINESS.startHour * 60; m <= BUSINESS.endHour * 60 - BUSINESS.treatmentMinutes; m += BUSINESS.displaySlotMinutes) {
  DISPLAY_TIMES.push(minutesToTime(m));
}

// 患者向け：名前を含まない ○△× だけの結果を作る
export function publicDay(dateStr, rawDay, today = todayJst()) {
  const day = normalizeDay(rawDay);
  const tooFar = dateStr > addDays(today, PUBLIC_DAYS_AHEAD);
  const sunday = weekday(dateStr) === 0;
  const closed = sunday || day.closed;
  return {
    date: dateStr,
    closed,
    open: !tooFar,
    slots: DISPLAY_TIMES.map(time => ({
      time,
      status: tooFar ? 'none' : closed ? 'full' : evaluateSlot(day, timeToMinutes(time)),
    })),
  };
}
