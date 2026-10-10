// =========================================================
// 設定・キャンセル記録・固定予約・週のコピー
// =========================================================
import { COLORS, GRID_TIMES, isGridTime, isValidDate, addDays, weekday, cleanName, normalizeDay, minutesToTime, timeToMinutes, todayJst, PUBLIC_DAYS_AHEAD } from './core.mjs';
import { getKey, updateKey, updateDay, getDay, listDates } from './store.mjs';
import { httpError } from './auth.mjs';

/* ---------- 設定（予約の長さの選択肢） ---------- */
export const LENGTH_CHOICES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 150, 180, 'all'];
export const DEFAULT_SETTINGS = { lengths: [10, 20, 30, 60, 90, 120, 'all'], defaultLength: 60 };

export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  let lengths = Array.isArray(s.lengths) ? s.lengths.filter(v => LENGTH_CHOICES.includes(v)) : DEFAULT_SETTINGS.lengths;
  lengths = LENGTH_CHOICES.filter(v => lengths.includes(v));
  if (!lengths.length) lengths = DEFAULT_SETTINGS.lengths;
  const defaultLength = lengths.includes(s.defaultLength) ? s.defaultLength : (lengths.includes(60) ? 60 : lengths[0]);
  return { lengths, defaultLength };
}
export async function readSettings() { return normalizeSettings((await getKey('meta/settings'))?.data); }
export async function saveSettings(body) {
  const next = normalizeSettings(body);
  await updateKey('meta/settings', () => next);
  return next;
}

/* ---------- 予約1件の取り出し ---------- */
function isBlockingCell(cell) { return !!cell && ((cell.c && COLORS[cell.c].blocks) || !!cell.n); }

// times の枠を1件の予約として読み取る（先頭のセルの色と名前）
function describe(day, times) {
  const first = day.cells[times[0]] || {};
  return { color: first.c || '', name: first.n || '', start: times[0], minutes: times.length * 10 };
}

/* ---------- キャンセル（予約表から消して、記録に残す） ---------- */
export async function cancelBooking(date, times) {
  if (!isValidDate(date)) throw httpError(400, '日付が正しくありません。');
  if (!Array.isArray(times) || !times.length || !times.every(isGridTime)) throw httpError(400, '時刻の指定が正しくありません。');
  let info = null;
  const saved = await updateDay(date, current => {
    const day = normalizeDay(current);
    if (!day.cells[times[0]]) throw httpError(409, 'この予約はすでに消えています。画面を更新してください。');
    info = describe(day, times);
    times.forEach(t => delete day.cells[t]);
    return day;
  });
  const entry = { date, ...info, at: new Date().toISOString() };
  await updateKey('cancels/' + date.slice(0, 7), cur => [...(Array.isArray(cur) ? cur : []), entry].slice(-2000));
  return { day: normalizeDay(saved), entry };
}

// キャンセルを取り消して予約表に戻す（その時間が空いているときだけ）
export async function restoreCancel(date, start, at) {
  if (!isValidDate(date) || !isGridTime(start) || typeof at !== 'string') throw httpError(400, '戻す予約の指定が正しくありません。');
  const key = 'cancels/' + date.slice(0, 7);
  const list = (await getKey(key))?.data;
  const entry = Array.isArray(list) ? list.find(x => x.date === date && x.start === start && x.at === at) : null;
  if (!entry) throw httpError(404, 'このキャンセル記録は見つかりません。画面を更新してください。');
  const s0 = timeToMinutes(entry.start);
  const times = [];
  for (let m = s0; m < s0 + entry.minutes; m += 10) { const t = minutesToTime(m); if (isGridTime(t)) times.push(t); }
  const saved = await updateDay(date, current => {
    const day = normalizeDay(current);
    const hit = times.find(t => isBlockingCell(day.cells[t]));
    if (hit) {
      const c = day.cells[hit];
      throw httpError(409, hit + ' に' + (c.n ? '「' + c.n + '」の' : 'ほかの') + '予約が入っているため戻せません。');
    }
    times.forEach((t, i) => { day.cells[t] = Object.assign({}, entry.color ? { c: entry.color } : {}, i === 0 && entry.name ? { n: entry.name } : {}); });
    return day;
  });
  await updateKey(key, cur => (Array.isArray(cur) ? cur : []).filter(x => !(x.date === date && x.start === start && x.at === at)));
  return { day: normalizeDay(saved), entry };
}

export async function readCancels(month) {
  const r = await getKey('cancels/' + month);
  return Array.isArray(r?.data) ? r.data : [];
}

/* ---------- まとめて入れる（固定予約・週のコピー共通） ---------- */
// bookings: [{ start, minutes, color, name }]。重なるものは入れずに skipped に回す
async function placeOnDay(date, bookings, result, force = false) {
  await updateDay(date, current => {
    const day = normalizeDay(current);
    if (day.closed) { bookings.forEach(b => result.skipped.push({ date, start: b.start, name: b.name, reason: '休診日' })); return day; }
    for (const b of bookings) {
      const s = timeToMinutes(b.start);
      const times = [];
      for (let m = s; m < s + b.minutes; m += 10) { const t = minutesToTime(m); if (isGridTime(t)) times.push(t); }
      if (!times.length) continue;
      const first = day.cells[times[0]];
      const same = first && first.c === (b.color || undefined) && (first.n || '') === b.name &&
        times.slice(1).every(t => day.cells[t] && day.cells[t].c === first.c && !day.cells[t].n);
      if (same) { result.existing++; continue; }
      const hit = times.find(t => isBlockingCell(day.cells[t]));
      if (hit && !force) { result.skipped.push({ date, start: b.start, name: b.name, reason: hit + ' に別の予約' }); continue; }
      if (force) {
        // 強制上書き：重なる予約を丸ごと消してから入れる（消した予約は結果に載せる）
        for (const t of times) {
          const c = day.cells[t];
          if (!c) continue;
          const run = runAt(day, t);
          const head = day.cells[run[0]] || {};
          if (isBlockingCell(c)) result.overwritten.push({ date, start: run[0], minutes: run.length * 10, name: head.n || '', color: head.c || '' });
          run.forEach(x => delete day.cells[x]);
        }
      }
      times.forEach((t, i) => { day.cells[t] = Object.assign({}, COLORS[b.color] ? { c: b.color } : {}, i === 0 && b.name ? { n: b.name } : {}, i === 0 && b.s ? { s: b.s } : {}, i === 0 && b.x ? { x: 1 } : {}); });
      result.placed++;
    }
    return day;
  });
}

const newResult = () => ({ placed: 0, existing: 0, skipped: [], overwritten: [] });

// t を含む1件の予約が使っている枠（名前なしの同じ色の続きは同じ予約）
function runAt(day, t) {
  const i = GRID_TIMES.indexOf(t);
  const c = day.cells[t];
  if (i < 0 || !c) return [];
  let a = i;
  while (a > 0 && !day.cells[GRID_TIMES[a]].n && !day.cells[GRID_TIMES[a]].s && c.c) {
    const prev = day.cells[GRID_TIMES[a - 1]];
    if (!prev || prev.c !== c.c) break;
    a--;
  }
  const start = day.cells[GRID_TIMES[a]];
  let z = a;
  while (z + 1 < GRID_TIMES.length && start.c) {
    const n = day.cells[GRID_TIMES[z + 1]];
    if (!n || n.n || n.s || n.c !== start.c) break;
    z++;
  }
  return GRID_TIMES.slice(a, z + 1);
}

/* ---------- 固定予約 ---------- */
function normalizeRule(r) {
  const name = cleanName(r?.name);
  const color = COLORS[r?.color] ? r.color : 'pink';
  const wd = Number(r?.weekday);
  const start = isGridTime(r?.start) ? r.start : null;
  const minutes = Math.max(10, Math.min(780, Math.round(Number(r?.minutes) / 10) * 10 || 60));
  const from = isValidDate(r?.from) ? r.from : null;
  const to = isValidDate(r?.to) ? r.to : '';
  if (!name || !(wd >= 1 && wd <= 6) || !start || !from) return null;
  return { id: String(r.id || Math.random().toString(36).slice(2, 10)).slice(0, 20), name, color, weekday: wd, start, minutes, from, to, memo: cleanName(r?.memo) };
}
export async function readRules() {
  const r = await getKey('meta/fixed');
  return Array.isArray(r?.data) ? r.data.map(normalizeRule).filter(Boolean) : [];
}
export async function saveRules(list) {
  if (!Array.isArray(list) || list.length > 300) throw httpError(400, '固定予約の形式が正しくありません。');
  const rules = list.map(normalizeRule);
  if (rules.some(r => !r)) throw httpError(400, '名前・曜日（月〜土）・時刻・開始日は必須です。');
  await updateKey('meta/fixed', () => rules);
  return rules;
}

// 固定予約を from〜to の期間に反映
export async function applyRules(ids, from, to) {
  if (!isValidDate(from) || !isValidDate(to) || to < from) throw httpError(400, '期間が正しくありません。');
  if (to > addDays(from, 370)) throw httpError(400, '一度に反映できるのは約1年分までです。');
  const rules = (await readRules()).filter(r => !ids || ids.includes(r.id));
  const perDay = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = weekday(d);
    for (const r of rules) {
      if (r.weekday !== wd || d < r.from || (r.to && d > r.to)) continue;
      if (!perDay.has(d)) perDay.set(d, []);
      perDay.get(d).push({ start: r.start, minutes: r.minutes, color: r.color, name: r.name, s: 'f:' + r.id });
    }
  }
  const result = newResult();
  for (const [d, list] of perDay) await placeOnDay(d, list, result);
  return result;
}

/* ---------- 週のコピー（月〜土） ---------- */
function bookingsOf(day) {
  const out = [];
  let cur = null;
  GRID_TIMES.forEach(t => {
    const c = day.cells[t];
    const cont = cur && c && c.c && c.c === cur.color && !c.n && !c.x && timeToMinutes(t) === timeToMinutes(cur.start) + cur.minutes;
    if (cont) { cur.minutes += 10; return; }
    if (cur) out.push(cur);
    cur = c ? Object.assign({ start: t, minutes: 10, color: c.c || '', name: c.n || '' }, c.x ? { x: 1 } : {}) : null;
  });
  if (cur) out.push(cur);
  return out;
}

// 週のコピー。weeks が null なら無期限（患者向けに表示する範囲まで自動で先へ延ばし続ける）
const newId = () => Math.random().toString(36).slice(2, 10);
const copyKey = (id, dayIndex, b) => 'w:' + id + ':' + (dayIndex + 1) + '-' + b.start;

export async function copyWeek(source, firstTarget, weeks) {
  if (!isValidDate(source) || weekday(source) !== 1) throw httpError(400, 'コピー元は月曜日の日付で指定してください。');
  if (!isValidDate(firstTarget) || weekday(firstTarget) !== 1) throw httpError(400, '反映先は月曜日の日付で指定してください。');
  const unlimited = weeks === null || weeks === 0 || weeks === 'unlimited';
  const n = unlimited ? null : Math.round(Number(weeks));
  if (!unlimited && !(n >= 1 && n <= 52)) throw httpError(400, '繰り返す週数は1〜52か「無期限」で指定してください。');
  if (firstTarget <= addDays(source, 6) && firstTarget >= source) throw httpError(400, 'コピー元と同じ週には反映できません。');
  const nextMonday = addDays(todayJst(), ((8 - weekday(todayJst())) % 7) || 7);
  if (firstTarget < nextMonday) throw httpError(400, '反映先は来週（' + nextMonday + '）以降の週にしてください。');
  const id = newId();
  const template = [];
  for (let i = 0; i < 6; i++) {
    template.push(bookingsOf(normalizeDay((await getDay(addDays(source, i)))?.data))
      .filter(b => b.color !== 'light' || b.name)
      .map(b => ({ ...b, s: copyKey(id, i, b) })));
  }
  if (!template.some(d => d.length)) throw httpError(400, 'コピー元の週に予約がありません。');
  const rule = { id, source, target: firstTarget, weeks: n, template, filledUntil: addDays(firstTarget, -1), createdAt: new Date().toISOString() };
  await updateKey('meta/copies', cur => [...(Array.isArray(cur) ? cur : []), rule].slice(-100));
  return fillCopy(id, unlimited ? horizon() : addDays(firstTarget, n * 7 - 1), true);
}

function horizon() { return addDays(todayJst(), PUBLIC_DAYS_AHEAD + 7); }

// コピー規則を until まで反映して、どこまで入れたかを記録する
async function fillCopy(id, until, force = false) {
  const rules = (await getKey('meta/copies'))?.data || [];
  const rule = rules.find(r => r.id === id);
  const result = newResult();
  if (!rule) return result;
  const last = rule.weeks ? addDays(rule.target, rule.weeks * 7 - 1) : until;
  const end = until < last ? until : last;
  for (let monday = rule.target; monday <= end; monday = addDays(monday, 7)) {
    if (addDays(monday, 6) <= rule.filledUntil) continue;
    for (let i = 0; i < 6; i++) {
      const d = addDays(monday, i);
      if (d <= rule.filledUntil || d > end || !rule.template[i].length) continue;
      await placeOnDay(d, rule.template[i], result, force);
    }
  }
  if (end > rule.filledUntil) {
    await updateKey('meta/copies', cur => (Array.isArray(cur) ? cur : []).map(r => r.id === id ? { ...r, filledUntil: end } : r));
  }
  return result;
}

// 無期限のコピーを先へ延ばす（画面を開いたときに呼ばれる。1日1回程度しか実際の書き込みは起きない）
export async function extendUnlimitedCopies() {
  const rules = (await getKey('meta/copies'))?.data;
  if (!Array.isArray(rules)) return;
  const h = horizon();
  for (const r of rules) {
    if (r.weeks === null && r.filledUntil < addDays(h, -7)) await fillCopy(r.id, h);
  }
}

export async function readCopies() {
  const rules = (await getKey('meta/copies'))?.data;
  return (Array.isArray(rules) ? rules : []).map(r => ({
    id: r.id, source: r.source, target: r.target, weeks: r.weeks, filledUntil: r.filledUntil,
    count: r.template.reduce((a, d) => a + d.length, 0),
  }));
}

/* ---------- 繰り返し予約を今日以降すべて削除 ---------- */
// series：1件の繰り返し予約の目印（w:規則:曜日-時刻 / f:固定予約ID）または rule:規則ID（そのコピー全部）
export async function deleteSeries(series) {
  const today = todayJst();
  const isRule = typeof series === 'string' && series.startsWith('rule:');
  const prefix = isRule ? 'w:' + series.slice(5) + ':' : null;
  if (!isRule && !/^[wf]:[\w:.-]{1,60}$/.test(String(series))) throw httpError(400, '繰り返し予約の指定が正しくありません。');
  const match = s => s && (isRule ? s.startsWith(prefix) : s === series);
  let removed = 0;
  const dates = (await listDates()).filter(d => d >= today);
  for (const d of dates) {
    const cur = await getDay(d);
    const day = normalizeDay(cur?.data);
    if (!Object.values(day.cells).some(c => match(c.s))) continue;
    await updateDay(d, current => {
      const dd = normalizeDay(current);
      GRID_TIMES.forEach((t, i) => {
        const c = dd.cells[t];
        if (!c || !match(c.s)) return;
        removed++;
        delete dd.cells[t];
        for (let j = i + 1; j < GRID_TIMES.length; j++) {
          const n = dd.cells[GRID_TIMES[j]];
          if (!n || n.n || n.s || n.c !== c.c) break;
          delete dd.cells[GRID_TIMES[j]];
        }
      });
      return dd;
    });
  }
  // これから先に自動で入らないよう、元の登録も止める
  if (series.startsWith('f:')) {
    const id = series.slice(2);
    await updateKey('meta/fixed', cur => (Array.isArray(cur) ? cur : []).map(r => r.id === id ? { ...r, to: addDays(today, -1) < r.from ? r.from : addDays(today, -1), stopped: true } : r).filter(r => !(r.id === id && addDays(today, -1) < r.from)));
  } else {
    const ruleId = isRule ? series.slice(5) : series.split(':')[1];
    await updateKey('meta/copies', cur => (Array.isArray(cur) ? cur : []).map(r => {
      if (r.id !== ruleId) return r;
      if (isRule) return null;
      return { ...r, template: r.template.map(d => d.filter(b => b.s !== series)) };
    }).filter(r => r && r.template.some(d => d.length)));
  }
  return { removed };
}
