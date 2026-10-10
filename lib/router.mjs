// =========================================================
// API の振り分け
//   公開（名前を返さない）: GET  /api/week?start=YYYY-MM-DD
//   ログイン              : POST /api/login
//   編集（毎回トークン確認）: GET  /api/edit/week   POST /api/edit/cells
//                           POST /api/edit/day    GET  /api/edit/export
//                           POST /api/edit/restore POST /api/edit/import-sheet
// =========================================================
import {
  COLORS, GRID_TIMES, isGridTime, isValidDate, addDays, cleanName,
  normalizeDay, emptyDay, publicDay, todayJst,
} from './core.mjs';
import { getDay, setDay, listDates, updateDay, getKey, setKey, listKeys } from './store.mjs';
import { login, verify, httpError, authStatus, changePassword } from './auth.mjs';
import { readSheetRange } from './sheetImport.mjs';
import { readSettings, saveSettings, cancelBooking, restoreCancel, readCancels, readRules, saveRules, applyRules, copyWeek, extendUnlimitedCopies, readCopies, deleteSeries } from './features.mjs';

const SECURITY_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex',
};

// 同時に動かす数を制限して順番に処理する（Netlifyの時間制限・負荷対策）
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
  }));
  return out;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 2_000_000) throw httpError(413, 'データが大きすぎます。');
  try { return text ? JSON.parse(text) : {}; } catch { throw httpError(400, 'JSONの形式が正しくありません。'); }
}

function requireDate(v, label = '日付') {
  if (!isValidDate(v)) throw httpError(400, `${label}は YYYY-MM-DD 形式で指定してください。`);
  return v;
}

// 重なり判定の対象：埋まり色の枠、または名前の入った枠（薄水色だけの枠は上書きしてよい）
function isBlockingCell(cell) {
  return !!cell && ((cell.c && COLORS[cell.c].blocks) || !!cell.n);
}

async function loadWeek(start, n = 7) {
  const dates = Array.from({ length: n }, (_, i) => addDays(start, i));
  const loaded = await Promise.all(dates.map(d => getDay(d)));
  return dates.map((date, i) => ({ date, day: normalizeDay(loaded[i]?.data) }));
}

export async function handle(request) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  try {
    /* ---------- 公開 ---------- */
    if (p === '/api/week' && method === 'GET') {
      const start = requireDate(url.searchParams.get('start'), 'start');
      const today = todayJst();
      await extendUnlimitedCopies().catch(e => console.error('[extend copies]', e));
      const week = await loadWeek(start);
      return json({ ok: true, days: week.map(({ date, day }) => publicDay(date, day, today)) });
    }

    if (p === '/api/login' && method === 'POST') {
      const body = await readBody(request);
      return json({ ok: true, ...(await login(String(body.password || ''))) });
    }

    /* ---------- ここから下は編集用：毎回トークンを確認 ---------- */
    if (!p.startsWith('/api/edit/')) throw httpError(404, 'Not found');
    await verify(request);

    if (p === '/api/edit/week' && method === 'GET') {
      const start = requireDate(url.searchParams.get('start'), 'start');
      await extendUnlimitedCopies().catch(e => console.error('[extend copies]', e));
      // 何日分返すか（スマホ1週・タブレット2週・PC4週。最大5週）
      const n = Math.min(42, Math.max(7, Math.round(Number(url.searchParams.get('days')) || 7)));
      const [days, settings, auth] = await Promise.all([loadWeek(start, n), readSettings(), authStatus()]);
      return json({ ok: true, times: GRID_TIMES, colors: COLORS, settings, auth, days });
    }

    // パスワード変更（ほかの端末はログアウトされる）
    if (p === '/api/edit/password' && method === 'POST') {
      const body = await readBody(request);
      return json({ ok: true, ...(await changePassword(body.current, body.next)) });
    }

    // 設定
    if (p === '/api/edit/settings' && method === 'GET') return json({ ok: true, settings: await readSettings() });
    if (p === '/api/edit/settings' && method === 'POST') return json({ ok: true, settings: await saveSettings(await readBody(request)) });

    // キャンセル（予約表から消して記録に残す）
    if (p === '/api/edit/cancel' && method === 'POST') {
      const body = await readBody(request);
      const r = await cancelBooking(body.date, body.times);
      return json({ ok: true, date: body.date, ...r });
    }
    if (p === '/api/edit/cancel/restore' && method === 'POST') {
      const body = await readBody(request);
      const r = await restoreCancel(body.date, body.start, body.at);
      return json({ ok: true, date: body.date, ...r });
    }
    if (p === '/api/edit/cancels' && method === 'GET') {
      const month = String(url.searchParams.get('month') || '');
      if (!/^\d{4}-\d{2}$/.test(month)) throw httpError(400, 'month は YYYY-MM 形式で指定してください。');
      return json({ ok: true, month, cancels: await readCancels(month) });
    }

    // 固定予約
    if (p === '/api/edit/fixed' && method === 'GET') return json({ ok: true, rules: await readRules() });
    if (p === '/api/edit/fixed' && method === 'POST') return json({ ok: true, rules: await saveRules((await readBody(request)).rules) });
    if (p === '/api/edit/fixed/apply' && method === 'POST') {
      const body = await readBody(request);
      return json({ ok: true, result: await applyRules(Array.isArray(body.ids) ? body.ids : null, body.from, body.to) });
    }
    // 週のコピー
    if (p === '/api/edit/copy-week' && method === 'POST') {
      const body = await readBody(request);
      return json({ ok: true, result: await copyWeek(body.source, body.target, body.weeks) });
    }
    if (p === '/api/edit/copies' && method === 'GET') return json({ ok: true, copies: await readCopies() });
    // 繰り返し予約（週のコピー・固定予約）を今日以降すべて削除
    if (p === '/api/edit/series/delete' && method === 'POST') {
      const body = await readBody(request);
      return json({ ok: true, ...(await deleteSeries(String(body.series || ''))) });
    }

    // 1か月分（予約記録の出力用）
    if (p === '/api/edit/month' && method === 'GET') {
      const month = String(url.searchParams.get('month') || '');
      if (!/^\d{4}-\d{2}$/.test(month) || !isValidDate(month + '-01')) throw httpError(400, 'month は YYYY-MM 形式で指定してください。');
      const dates = [];
      for (let d = month + '-01'; d.startsWith(month); d = addDays(d, 1)) dates.push(d);
      const loaded = await Promise.all(dates.map(d => getDay(d)));
      return json({ ok: true, month, times: GRID_TIMES, days: dates.map((date, i) => ({ date, day: normalizeDay(loaded[i]?.data) })) });
    }

    // 枠の保存：指定した日・時刻のセルだけを書き換える
    if (p === '/api/edit/cells' && method === 'POST') {
      const body = await readBody(request);
      const date = requireDate(body.date);
      const times = Array.isArray(body.times) ? body.times : [];
      if (!times.length || times.length > 78 || !times.every(isGridTime)) throw httpError(400, '時刻の指定が正しくありません。');
      const color = body.color === null || body.color === '' ? null : body.color;
      if (color !== null && !COLORS[color]) throw httpError(400, '色の指定が正しくありません。');
      const name = cleanName(body.name);
      // ownTimes：編集中の予約がもともと使っていた枠（長さを変えたときに古い枠を消すため）
      const ownTimes = Array.isArray(body.ownTimes) ? body.ownTimes.filter(isGridTime) : [];
      const own = new Set(ownTimes);
      const writing = !!(color || name);
      const exclude = body.exclude === true; // 統計から除外（休憩・打ち合わせなど）

      const saved = await updateDay(date, current => {
        const day = normalizeDay(current);
        // ほかの予約と重なるなら保存しない（別の端末が先に入れた場合もここで止まる）
        if (writing) {
          const conflicts = times.filter(t => !own.has(t) && isBlockingCell(day.cells[t]));
          if (conflicts.length) {
            const first = day.cells[conflicts[0]];
            throw httpError(409, `${conflicts[0]} から${first.n ? '「' + first.n + '」の' : 'ほかの'}予約があるため入りません。長さを短くするか、時間を変えてください。`);
          }
        }
        const keepS = day.cells[times[0]] && day.cells[times[0]].s && (day.cells[times[0]].n || '') === name ? day.cells[times[0]].s : '';
        ownTimes.forEach(t => { if (!times.includes(t)) delete day.cells[t]; });
        times.forEach((t, i) => {
          const n = i === 0 ? name : '';
          if (!color && !n) delete day.cells[t];
          else day.cells[t] = Object.assign({}, color ? { c: color } : {}, n ? { n } : {}, i === 0 && keepS ? { s: keepS } : {}, i === 0 && exclude ? { x: 1 } : {});
        });
        return day;
      });
      return json({ ok: true, date, day: normalizeDay(saved) });
    }

    // 休診日の切り替え
    if (p === '/api/edit/day' && method === 'POST') {
      const body = await readBody(request);
      const date = requireDate(body.date);
      const saved = await updateDay(date, current => ({ ...normalizeDay(current), closed: body.closed === true }));
      return json({ ok: true, date, day: normalizeDay(saved) });
    }

    // バックアップ（全データ）
    if (p === '/api/edit/export' && method === 'GET') {
      const dates = await listDates();
      const days = {};
      const loaded = await mapLimit(dates, 20, d => getDay(d));
      dates.forEach((d, i) => {
        const day = normalizeDay(loaded[i]?.data);
        if (day.closed || Object.keys(day.cells).length) days[d] = day;
      });
      // 設定・固定予約・キャンセル記録も一緒に保存する
      const extraKeys = ['meta/settings', 'meta/fixed', 'meta/copies', ...(await listKeys('cancels/'))]; // パスワード(meta/auth)は入れない
      const extra = {};
      for (const k of extraKeys) { const v = await getKey(k); if (v) extra[k] = v.data; }
      return json({ app: 'yoyaku-chan', version: 2, exportedAt: new Date().toISOString(), days, extra });
    }

    // 復元：バックアップに含まれる日だけを上書き
    if (p === '/api/edit/restore' && method === 'POST') {
      const body = await readBody(request);
      if (body.app !== 'yoyaku-chan' || !body.days || typeof body.days !== 'object') {
        throw httpError(400, '予約ちゃんのバックアップファイルではありません。');
      }
      const entries = Object.entries(body.days).filter(([d]) => isValidDate(d));
      if (entries.length > 120) throw httpError(413, '一度に送れるのは120日分までです。');
      await mapLimit(entries, 10, ([d, raw]) => setDay(d, normalizeDay(raw)));
      if (body.extra && typeof body.extra === 'object') {
        for (const [k, v] of Object.entries(body.extra)) {
          if (k === 'meta/settings' || k === 'meta/fixed' || k === 'meta/copies' || /^cancels\/\d{4}-\d{2}$/.test(k)) await setKey(k, v);
        }
      }
      return json({ ok: true, restoredDays: entries.length });
    }

    // 取り込みの準備ができているか（Googleの設定があるか）
    if (p === '/api/edit/import-status' && method === 'GET') {
      return json({ ok: true, configured: !!(process.env.GOOGLE_SPREADSHEET_ID && (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim().startsWith('{')),
        sheetName: process.env.GOOGLE_SHEET_NAME || 'CMYK臨時予約表' });
    }

    // スプレッドシートから取り込み（指定期間の日を上書き）
    if (p === '/api/edit/import-sheet' && method === 'POST') {
      const body = await readBody(request);
      const from = requireDate(body.from, '開始日');
      const to = requireDate(body.to, '終了日');
      if (to < from) throw httpError(400, '終了日は開始日以降にしてください。');
      if (to > addDays(from, 400)) throw httpError(400, '一度に取り込めるのは約1年分までです。');
      const { days, stats } = await readSheetRange(from, to);
      // 予約ちゃん側にすでに入っている日（上書きされる日）を数える
      const existing = await Promise.all(stats.perDay.map(x => getDay(x.date)));
      stats.perDay.forEach((x, i) => { const d = normalizeDay(existing[i]?.data); x.existing = Object.keys(d.cells).length; });
      stats.overwriteDays = stats.perDay.filter(x => x.existing > 0).length;
      if (body.dryRun !== true) {
        for (const [d, day] of Object.entries(days)) await setDay(d, day);
      }
      return json({ ok: true, dryRun: body.dryRun === true, stats });
    }

    throw httpError(404, 'Not found');
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[yoyaku-chan]', error);
    return json({ ok: false, error: status >= 500 && !error.status ? 'サーバーでエラーが起きました。' : error.message }, status);
  }
}

export { emptyDay };
