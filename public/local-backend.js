'use strict';
// =========================================================
// 端末の中だけで動く予約データ（予約ちゃん2用）
// サーバーと同じ /api/... の呼び出しに、この端末のブラウザ保存領域で答える。通信はしない。
// =========================================================
function makeLocalBackend(DATA_KEY, DEMO_PASSWORD) {
  const COLORS = { pink: { label: 'ピンク', blocks: true }, blue: { label: '青', blocks: true }, red: { label: '赤', blocks: true }, gray: { label: 'グレー', blocks: true }, light: { label: '薄水色', blocks: false } };
  const p2 = n => String(n).padStart(2, '0');
  const toT = m => p2(Math.floor(m / 60)) + ':' + p2(m % 60);
  const toM = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const TIMES = []; for (let m = 540; m < 1320; m += 10) TIMES.push(toT(m));
  const DISPLAY = []; for (let m = 600; m <= 1260; m += 30) DISPLAY.push(toT(m));
  const ymd = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const addD = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
  const wday = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };

  function sample() {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const w = t.getDay(); const mon = ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + (w === 0 ? -6 : 1 - w)));
    const days = {};
    const put = (dOff, time, len, c, n) => {
      const d = addD(mon, dOff); days[d] = days[d] || { closed: false, cells: {} };
      for (let m = toM(time), i = 0; m < toM(time) + len; m += 10, i++) days[d].cells[toT(m)] = Object.assign({ c }, i === 0 && n ? { n } : {});
    };
    put(0, '10:00', 60, 'pink', '例)山田'); put(0, '13:00', 60, 'blue', '例)No.102'); put(0, '18:30', 60, 'pink', '例)佐藤');
    put(1, '11:00', 90, 'red', '例)鈴木'); put(1, '15:00', 60, 'pink', '例)高橋'); put(1, '17:00', 30, 'light', '');
    put(2, '12:00', 60, 'gray', '昼休み'); put(2, '19:00', 60, 'pink', '例)田中');
    put(3, '10:30', 60, 'pink', '例)伊藤'); put(3, '14:00', 60, 'blue', '例)渡辺'); put(3, '16:30', 60, 'pink', '例)中村');
    put(4, '13:00', 60, 'pink', '例)小林'); put(4, '20:00', 60, 'red', '例)加藤');
    put(5, '10:00', 120, 'gray', '研修');
    return days;
  }
  let store;
  try { store = JSON.parse(localStorage.getItem(DATA_KEY) || 'null'); } catch { store = null; }
  if (!store) store = {};
  const save = () => { try { localStorage.setItem(DATA_KEY, JSON.stringify(store)); return true; } catch { return false; } };
  const reset = () => { store = {}; save(); };
  let extendCopies = null;

  const getDay = d => (d !== '__meta' && store[d]) || { closed: false, cells: {} };
  function occupied(day, t) {
    const c = day.cells[toT(t)]; if (!c) return false;
    if (c.c && COLORS[c.c].blocks) return true;
    return (t < 600 || t >= 1320) && !(c.c === 'light' && !c.n) && !!(c.c || c.n);
  }
  const rangeOcc = (day, a, b) => { for (let t = a; t < b; t += 10) { if (t >= 540 && t < 1320 && occupied(day, t)) return true; } return false; };
  const publicWeek = start => Array.from({ length: 7 }, (_, i) => {
    const date = addD(start, i), day = getDay(date), closed = wday(date) === 0 || day.closed;
    return { date, closed, slots: DISPLAY.map(time => {
      const s = toM(time);
      const st = closed ? 'full' : rangeOcc(day, s, s + 60) ? 'full' : (rangeOcc(day, s - 30, s) || rangeOcc(day, s + 60, s + 90)) ? 'consult' : 'available';
      return { time, status: st };
    }) };
  });

  const reply = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  const handler = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://local.invalid/');
    await new Promise(r => setTimeout(r, 120));
    const body = init.body ? JSON.parse(init.body) : {};
    const auth = (init.headers && init.headers.authorization) || '';
    if (url.pathname === '/api/login') {
      return body.password === DEMO_PASSWORD ? reply({ ok: true, token: 'demo-token' }) : reply({ ok: false, error: 'パスワードが違います。' }, 401);
    }
    if (auth !== 'Bearer demo-token') return reply({ ok: false, error: 'ログインしてください。' }, 401);
    if (url.pathname === '/api/edit/week') {
      const start = url.searchParams.get('start');
      const nDays = Math.min(42, Math.max(7, Math.round(Number(url.searchParams.get('days')) || 7)));
      extendCopies && extendCopies();
      return reply({ ok: true, times: TIMES, colors: COLORS, settings: (store.__meta && store.__meta.settings) || { lengths: [10, 20, 30, 60, 90, 120, 'all'], defaultLength: 60 }, days: Array.from({ length: nDays }, (_, i) => { const d = addD(start, i); return { date: d, day: JSON.parse(JSON.stringify(getDay(d))) }; }) });
    }
    if (url.pathname === '/api/edit/month') {
      const month = url.searchParams.get('month'); const ds = [];
      for (let d = month + '-01'; d.startsWith(month); d = addD(d, 1)) ds.push({ date: d, day: JSON.parse(JSON.stringify(getDay(d))) });
      return reply({ ok: true, month, times: TIMES, days: ds });
    }
    if (url.pathname === '/api/edit/cells') {
      const day = JSON.parse(JSON.stringify(getDay(body.date)));
      const name = String(body.name || '').trim().slice(0, 20);
      const own = new Set(body.ownTimes || []);
      if (body.color || name) {
        const hit = body.times.find(t => !own.has(t) && day.cells[t] && ((day.cells[t].c && COLORS[day.cells[t].c].blocks) || day.cells[t].n));
        if (hit) return reply({ ok: false, error: hit + ' からほかの予約があるため入りません。' }, 409);
      }
      (body.ownTimes || []).forEach(t => { if (!body.times.includes(t)) delete day.cells[t]; });
      body.times.forEach((t, i) => {
        const n = i === 0 ? name : '';
        if (!body.color && !n) delete day.cells[t];
        else day.cells[t] = Object.assign({}, body.color ? { c: body.color } : {}, n ? { n } : {});
      });
      store[body.date] = day; save();
      return reply({ ok: true, date: body.date, day });
    }
    if (url.pathname === '/api/edit/day') {
      const day = JSON.parse(JSON.stringify(getDay(body.date))); day.closed = body.closed === true;
      store[body.date] = day; save();
      return reply({ ok: true, date: body.date, day });
    }
    if (url.pathname === '/api/edit/export') {
      const m0 = store.__meta || {};
      const days = {}; Object.keys(store).filter(k => k !== '__meta').sort().forEach(k => { const d = store[k]; if (d.closed || Object.keys(d.cells || {}).length) days[k] = d; });
      const extra = {};
      if (m0.settings) extra['meta/settings'] = m0.settings;
      if (m0.rules) extra['meta/fixed'] = m0.rules;
      if (m0.copies) extra['meta/copies'] = m0.copies;
      (m0.cancels || []).forEach(c => { const k = 'cancels/' + c.date.slice(0, 7); (extra[k] = extra[k] || []).push(c); });
      return reply({ app: 'yoyaku-chan', version: 2, exportedAt: new Date().toISOString(), days, extra });
    }
    if (url.pathname === '/api/edit/restore') {
      if (body.app !== 'yoyaku-chan') return reply({ ok: false, error: '予約ちゃんのバックアップファイルではありません。' }, 400);
      const ds = Object.entries(body.days || {}).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      ds.forEach(([d, day]) => { store[d] = day; });
      if (body.extra) {
        const m0 = store.__meta || (store.__meta = { settings: { lengths: [10, 20, 30, 60, 90, 120, 'all'], defaultLength: 60 }, cancels: [], rules: [] });
        Object.entries(body.extra).forEach(([k, v]) => {
          if (k === 'meta/settings') m0.settings = v;
          else if (k === 'meta/fixed') m0.rules = v;
          else if (k === 'meta/copies') m0.copies = v;
          else if (/^cancels\/\d{4}-\d{2}$/.test(k)) m0.cancels = (m0.cancels || []).filter(c => !c.date.startsWith(k.slice(8))).concat(v);
        });
      }
      const ok = save();
      return reply(Object.assign({ ok: true, restoredDays: ds.length }, ok ? {} : { warning: 'この画面ではブラウザに保存できなかったため、取り込んだ内容はページを開き直すと消えます（お試し版だけの制限です。本番はサーバーに保存されます）。' }));
    }
    if (url.pathname === '/api/edit/import-status') return reply({ ok: true, configured: false, demo: true, sheetName: 'CMYK臨時予約表' });
    // ---- 設定 ----
    const meta = store.__meta || (store.__meta = { settings: { lengths: [10, 20, 30, 60, 90, 120, 'all'], defaultLength: 60 }, cancels: [], rules: [] });
    if (url.pathname === '/api/edit/settings') {
      if ((init.method || 'GET') === 'POST') {
        const all = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 150, 180, 'all'];
        const lengths = all.filter(v => (body.lengths || []).includes(v));
        meta.settings = { lengths: lengths.length ? lengths : meta.settings.lengths, defaultLength: lengths.includes(body.defaultLength) ? body.defaultLength : lengths[0] };
        save();
      }
      return reply({ ok: true, settings: meta.settings });
    }
    // ---- キャンセル ----
    if (url.pathname === '/api/edit/cancel') {
      const day = JSON.parse(JSON.stringify(getDay(body.date)));
      const first = day.cells[body.times[0]];
      if (!first) return reply({ ok: false, error: 'この予約はすでに消えています。' }, 409);
      const entry = { date: body.date, start: body.times[0], minutes: body.times.length * 10, color: first.c || '', name: first.n || '', at: new Date().toISOString() };
      body.times.forEach(t => delete day.cells[t]);
      store[body.date] = day; meta.cancels.push(entry); save();
      return reply({ ok: true, date: body.date, day, entry });
    }
    if (url.pathname === '/api/edit/cancel/restore') {
      const i = meta.cancels.findIndex(x => x.date === body.date && x.start === body.start && x.at === body.at);
      if (i < 0) return reply({ ok: false, error: 'このキャンセル記録は見つかりません。' }, 404);
      const e = meta.cancels[i];
      const day = JSON.parse(JSON.stringify(getDay(e.date)));
      const ts = []; for (let m = toM(e.start); m < toM(e.start) + e.minutes; m += 10) ts.push(toT(m));
      const hit = ts.find(t => day.cells[t] && ((day.cells[t].c && COLORS[day.cells[t].c].blocks) || day.cells[t].n));
      if (hit) return reply({ ok: false, error: hit + ' に' + (day.cells[hit].n ? '「' + day.cells[hit].n + '」の' : 'ほかの') + '予約が入っているため戻せません。' }, 409);
      ts.forEach((t, k) => { day.cells[t] = Object.assign({}, e.color ? { c: e.color } : {}, k === 0 && e.name ? { n: e.name } : {}); });
      store[e.date] = day; meta.cancels.splice(i, 1); save();
      return reply({ ok: true, date: e.date, day, entry: e });
    }
    if (url.pathname === '/api/edit/cancels') {
      const m = url.searchParams.get('month');
      return reply({ ok: true, month: m, cancels: meta.cancels.filter(c => c.date.startsWith(m)) });
    }
    // ---- まとめて入れる ----
    const place = (date, list, res, force) => {
      const day = JSON.parse(JSON.stringify(getDay(date)));
      if (day.closed) { list.forEach(b => res.skipped.push({ date, start: b.start, name: b.name, reason: '休診日' })); return; }
      list.forEach(b => {
        const ts = []; for (let m = toM(b.start); m < toM(b.start) + b.minutes; m += 10) if (m < 1320) ts.push(toT(m));
        const f = day.cells[ts[0]];
        if (f && f.c === (b.color || undefined) && (f.n || '') === b.name && ts.slice(1).every(t => day.cells[t] && day.cells[t].c === f.c && !day.cells[t].n)) { res.existing++; return; }
        const hit = ts.find(t => day.cells[t] && ((day.cells[t].c && COLORS[day.cells[t].c].blocks) || day.cells[t].n));
        if (hit && !force) { res.skipped.push({ date, start: b.start, name: b.name, reason: hit + ' に別の予約' }); return; }
        if (force) ts.forEach(t => {
          if (!day.cells[t]) return;
          let a = TIMES.indexOf(t); const c0 = day.cells[t];
          while (a > 0 && !day.cells[TIMES[a]].n && !day.cells[TIMES[a]].s && c0.c && day.cells[TIMES[a - 1]] && day.cells[TIMES[a - 1]].c === c0.c) a--;
          const head = day.cells[TIMES[a]]; let z = a;
          while (z + 1 < TIMES.length && head.c && day.cells[TIMES[z + 1]] && !day.cells[TIMES[z + 1]].n && !day.cells[TIMES[z + 1]].s && day.cells[TIMES[z + 1]].c === head.c) z++;
          if ((c0.c && COLORS[c0.c].blocks) || c0.n) (res.overwritten = res.overwritten || []).push({ date, start: TIMES[a], minutes: (z - a + 1) * 10, name: head.n || '', color: head.c || '' });
          for (let k = a; k <= z; k++) delete day.cells[TIMES[k]];
        });
        ts.forEach((t, i) => { day.cells[t] = Object.assign({}, b.color ? { c: b.color } : {}, i === 0 && b.name ? { n: b.name } : {}, i === 0 && b.s ? { s: b.s } : {}); });
        res.placed++;
      });
      store[date] = day;
    };
    if (url.pathname === '/api/edit/fixed') {
      if ((init.method || 'GET') === 'POST') {
        const bad = (body.rules || []).some(r => !r.name || !(r.weekday >= 1 && r.weekday <= 6) || !r.start || !r.from);
        if (bad) return reply({ ok: false, error: '名前・曜日（月〜土）・時刻・開始日は必須です。' }, 400);
        meta.rules = body.rules.map(r => Object.assign({ id: r.id || Math.random().toString(36).slice(2, 10), color: 'pink', minutes: 60, to: '' }, r));
        save();
      }
      return reply({ ok: true, rules: meta.rules });
    }
    if (url.pathname === '/api/edit/fixed/apply') {
      const res = { placed: 0, existing: 0, skipped: [] };
      const rs = meta.rules.filter(r => !body.ids || body.ids.includes(r.id));
      for (let d = body.from; d <= body.to; d = addD(d, 1)) {
        const list = rs.filter(r => r.weekday === wday(d) && d >= r.from && (!r.to || d <= r.to)).map(r => ({ start: r.start, minutes: r.minutes, color: r.color, name: r.name, s: 'f:' + r.id }));
        if (list.length) place(d, list, res);
      }
      save();
      return reply({ ok: true, result: res });
    }
    const todayStr = ymd(new Date());
    const horizon = () => addD(todayStr, 97);
    const fill = (rule, until, res, force) => {
      const last = rule.weeks ? addD(rule.target, rule.weeks * 7 - 1) : until;
      const end = until < last ? until : last;
      for (let mon = rule.target; mon <= end; mon = addD(mon, 7)) for (let i = 0; i < 6; i++) {
        const d = addD(mon, i);
        if (d <= rule.filledUntil || d > end || !rule.template[i].length) continue;
        place(d, rule.template[i], res, force);
      }
      if (end > rule.filledUntil) rule.filledUntil = end;
    };
    meta.copies = meta.copies || [];
    if (url.pathname === '/api/edit/copy-week') {
      if (body.target >= body.source && body.target <= addD(body.source, 6)) return reply({ ok: false, error: 'コピー元と同じ週には反映できません。' }, 400);
      const nm = addD(todayStr, ((8 - wday(todayStr)) % 7) || 7);
      if (body.target < nm) return reply({ ok: false, error: '反映先は来週（' + nm + '）以降の週にしてください。' }, 400);
      const id = Math.random().toString(36).slice(2, 10);
      const template = [];
      for (let i = 0; i < 6; i++) {
        const day = getDay(addD(body.source, i)); const out = []; let cur = null;
        TIMES.forEach(t => {
          const c = day.cells[t];
          if (cur && c && c.c && c.c === cur.color && !c.n && toM(t) === toM(cur.start) + cur.minutes) { cur.minutes += 10; return; }
          if (cur) out.push(cur);
          cur = c ? { start: t, minutes: 10, color: c.c || '', name: c.n || '' } : null;
        });
        if (cur) out.push(cur);
        template.push(out.filter(b => b.color !== 'light' || b.name).map(b => Object.assign(b, { s: 'w:' + id + ':' + (i + 1) + '-' + b.start })));
      }
      if (!template.some(d => d.length)) return reply({ ok: false, error: 'コピー元の週に予約がありません。' }, 400);
      const rule = { id, source: body.source, target: body.target, weeks: body.weeks || null, template, filledUntil: addD(body.target, -1) };
      meta.copies.push(rule);
      const res = { placed: 0, existing: 0, skipped: [], overwritten: [] };
      fill(rule, rule.weeks ? addD(rule.target, rule.weeks * 7 - 1) : horizon(), res, true);
      save();
      return reply({ ok: true, result: res });
    }
    extendCopies = () => { const h = horizon(); (meta.copies || []).forEach(r => { if (r.weeks === null && r.filledUntil < addD(h, -7)) fill(r, h, { placed: 0, existing: 0, skipped: [] }); }); save(); };
    if (url.pathname === '/api/edit/copies') {
      return reply({ ok: true, copies: meta.copies.map(r => ({ id: r.id, source: r.source, target: r.target, weeks: r.weeks, filledUntil: r.filledUntil, count: r.template.reduce((a, d) => a + d.length, 0) })) });
    }
    if (url.pathname === '/api/edit/series/delete') {
      const series = String(body.series || ''); const isRule = series.startsWith('rule:');
      const match = x => x && (isRule ? x.startsWith('w:' + series.slice(5) + ':') : x === series);
      let removed = 0;
      Object.keys(store).filter(d => d !== '__meta' && d >= todayStr).forEach(d => {
        const day = store[d];
        TIMES.forEach((t, i) => {
          const c = day.cells[t]; if (!c || !match(c.s)) return;
          removed++; delete day.cells[t];
          for (let j = i + 1; j < TIMES.length; j++) { const n = day.cells[TIMES[j]]; if (!n || n.n || n.s || n.c !== c.c) break; delete day.cells[TIMES[j]]; }
        });
      });
      if (series.startsWith('f:')) { const r = meta.rules.find(x => x.id === series.slice(2)); if (r) r.to = addD(todayStr, -1); }
      else {
        const rid = isRule ? series.slice(5) : series.split(':')[1];
        meta.copies = meta.copies.map(r => r.id !== rid ? r : isRule ? null : Object.assign(r, { template: r.template.map(d => d.filter(b => b.s !== series)) })).filter(r => r && r.template.some(d => d.length));
      }
      save();
      return reply({ ok: true, removed });
    }
    return reply({ ok: false, error: 'この画面では使えない機能です。' }, 404);
  };
  return { fetch: handler, reset, publicWeek };
}
