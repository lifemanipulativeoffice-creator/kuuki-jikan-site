// 簡易テスト：node dev/test.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.YOYAKU_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yoyaku-'));
process.env.YOYAKU_PASSWORD = 'test-pass-1234';
process.env.YOYAKU_SECRET = 'x'.repeat(40);
process.env.YOYAKU_FAIL_DELAY_MS = '0';
process.env.YOYAKU_TODAY = '2026-10-09'; // テストは日付を固定

const { handle } = await import('../lib/router.mjs');
const { mapSheetColor, buildColumnTimes, rowToDay } = await import('../lib/sheetImport.mjs');
const { publicDay } = await import('../lib/core.mjs');

const call = async (method, p, body, token) => {
  const r = await handle(new Request('http://x' + p, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: token ? { authorization: 'Bearer ' + token } : {},
  }));
  return { status: r.status, body: await r.json() };
};

// 1) 認証なしの編集は拒否
assert.equal((await call('POST', '/api/edit/cells', { date: '2026-10-09', times: ['10:00'], color: 'pink' })).status, 401);
assert.equal((await call('GET', '/api/edit/week?start=2026-10-05', null, 'abc.def')).status, 401);
assert.equal((await call('POST', '/api/login', { password: 'wrong' })).status, 401);

const { body: lg } = await call('POST', '/api/login', { password: 'test-pass-1234' });
const token = lg.token;
assert.ok(token);

// 2) 枠保存：60分の予約（名前は先頭だけ）
let r2; let r = await call('POST', '/api/edit/cells', { date: '2026-10-09', times: ['13:00', '13:10', '13:20', '13:30', '13:40', '13:50'], color: 'pink', name: '山田' }, token);
assert.equal(r.status, 200);
assert.deepEqual(r.body.day.cells['13:00'], { c: 'pink', n: '山田' });
assert.deepEqual(r.body.day.cells['13:50'], { c: 'pink' });

// 別端末が同じ日の別の枠を保存しても、先の予約は消えない
await call('POST', '/api/edit/cells', { date: '2026-10-09', times: ['16:00'], color: 'red', name: '佐藤' }, token);
r = await call('GET', '/api/edit/week?start=2026-10-05', null, token);
const fri = r.body.days.find(d => d.date === '2026-10-09').day;
assert.equal(fri.cells['13:00'].n, '山田');
assert.equal(fri.cells['16:00'].n, '佐藤');

// 3) 公開APIに名前が含まれない・判定が正しい
r = await call('GET', '/api/week?start=2026-10-05');
const pubText = JSON.stringify(r.body);
assert.ok(!pubText.includes('山田') && !pubText.includes('佐藤'), '公開APIに名前が出ている');
const pf = r.body.days.find(d => d.date === '2026-10-09');
const st = t => pf.slots.find(s => s.time === t).status;
assert.equal(st('13:00'), 'full');     // 施術時間が埋まり
assert.equal(st('12:30'), 'full');     // 施術12:30-13:30に13:00が重なる
assert.equal(st('12:00'), 'consult');  // 施術は空き、後ろのバッファ(13:00-)が埋まり
assert.equal(st('11:30'), 'available');
assert.equal(st('10:00'), 'available');
assert.equal(r.body.days.find(d => d.date === '2026-10-11').closed, true); // 日曜

// 4) 休診日
await call('POST', '/api/edit/day', { date: '2026-10-10', closed: true }, token);
r = await call('GET', '/api/week?start=2026-10-05');
assert.ok(r.body.days.find(d => d.date === '2026-10-10').slots.every(s => s.status === 'full'));

// 5) バックアップ→復元
const exp = (await call('GET', '/api/edit/export', null, token)).body;
assert.equal(exp.app, 'yoyaku-chan');
assert.ok(exp.days['2026-10-09']);
await call('POST', '/api/edit/cells', { date: '2026-10-09', times: ['13:00'], color: null, name: '' }, token);
await call('POST', '/api/edit/restore', exp, token);
r = await call('GET', '/api/edit/week?start=2026-10-05', null, token);
assert.equal(r.body.days.find(d => d.date === '2026-10-09').day.cells['13:00'].n, '山田');

// 6) 不正入力
assert.equal((await call('POST', '/api/edit/cells', { date: '2026-02-30', times: ['10:00'], color: 'pink' }, token)).status, 400);
assert.equal((await call('POST', '/api/edit/cells', { date: '2026-10-09', times: ['10:05'], color: 'pink' }, token)).status, 400);
assert.equal((await call('POST', '/api/edit/cells', { date: '2026-10-09', times: ['10:00'], color: 'green' }, token)).status, 400);

// 7) シートの色の割り当て（実シートで確認した色）
const C = (red, green, blue) => ({ red, green, blue });
assert.equal(mapSheetColor(C(1, 1, 1)).c, null);                         // 白
assert.equal(mapSheetColor({}).c, null);                                  // 色なし
assert.equal(mapSheetColor({ red: 1, blue: 1 }).c, 'pink');               // マゼンタ
assert.equal(mapSheetColor({ red: 1 }).c, 'red');                         // 赤
assert.equal(mapSheetColor(C(0.4, 0.4, 0.4)).c, 'gray');                  // 濃いグレー
assert.equal(mapSheetColor(C(0.2901961, 0.5254902, 0.9098039)).c, 'blue');// 青
assert.equal(mapSheetColor({ green: 1, blue: 1 }).c, 'blue');             // シアン
assert.equal(mapSheetColor({ blue: 1 }).c, 'blue');                       // 純青
assert.equal(mapSheetColor(C(0.8156863, 0.8784314, 0.8901961)).c, null); // 薄い水色（区切り）は白として取り込む
assert.equal(mapSheetColor(C(1, 0.9, 0.2)).unexpected, true);             // 想定外→グレー

// 見出しの読み取り（9:00〜21:50、10分刻み）
const hourRow = ['1'], minuteRow = [''];
for (let h = 9; h <= 21; h++) for (let k = 1; k <= 6; k++) { hourRow.push(k === 1 ? h + ':00' : ''); minuteRow.push(String(k * 10)); }
hourRow.push('来院数'); minuteRow.push('');
const ct = buildColumnTimes(hourRow, minuteRow);
assert.equal(ct.size, 78);
assert.equal(ct.get(1), '09:00');
assert.equal(ct.get(78), '21:50');
const stats = { unexpectedColors: 0, truncatedNames: 0 };
const cells = []; cells[7] = { text: '田中', bg: { red: 1, blue: 1 } }; cells[8] = { bg: { red: 1, blue: 1 } };
const day = rowToDay(cells, ct, stats);
assert.deepEqual(day.cells['10:00'], { c: 'pink', n: '田中' });
assert.deepEqual(day.cells['10:10'], { c: 'pink' });

// 保存済みの薄水色は白（空き）になる。名前つきなら名前だけ残る
const lightDay = { cells: { '09:30': { c: 'light' }, '10:00': { c: 'light' }, '10:10': { c: 'light', n: 'メモ' } } };
assert.equal(publicDay('2026-10-09', lightDay, '2026-10-01').slots[0].status, 'available');
const { normalizeDay } = await import('../lib/core.mjs');
assert.deepEqual(normalizeDay(lightDay).cells, { '10:10': { n: 'メモ' } });

// 8) 重なり防止：13:00〜山田がいる日に 12:30 から120分は入らない
const T = (start, len) => { const out = []; const [h, m] = start.split(':').map(Number); for (let x = h * 60 + m; x < h * 60 + m + len; x += 10) out.push(String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0')); return out; };
r = await call('POST', '/api/edit/cells', { date: '2026-10-09', times: T('12:30', 120), color: 'pink', name: '木村' }, token);
assert.equal(r.status, 409);
assert.ok(r.body.error.includes('13:00'));
r = await call('GET', '/api/edit/week?start=2026-10-05', null, token);
assert.equal(r.body.days.find(d => d.date === '2026-10-09').day.cells['13:00'].n, '山田'); // 上書きされていない
// 30分なら入る
assert.equal((await call('POST', '/api/edit/cells', { date: '2026-10-09', times: T('12:30', 30), color: 'pink', name: '木村' }, token)).status, 200);
// 山田の予約を60→30分に短くすると、残りの30分は消える
r = await call('POST', '/api/edit/cells', { date: '2026-10-09', times: T('13:00', 30), ownTimes: T('13:00', 60), color: 'pink', name: '山田' }, token);
assert.equal(r.status, 200);
assert.ok(!r.body.day.cells['13:30'] && !r.body.day.cells['13:50']);
// 自分の予約を延ばす（後ろが空いていれば可）
assert.equal((await call('POST', '/api/edit/cells', { date: '2026-10-09', times: T('13:00', 90), ownTimes: T('13:00', 30), color: 'pink', name: '山田' }, token)).status, 200);
// 薄水色は選べない（白にする）
assert.equal((await call('POST', '/api/edit/cells', { date: '2026-10-08', times: T('17:00', 30), color: 'light', name: '' }, token)).status, 400);
assert.equal((await call('POST', '/api/edit/cells', { date: '2026-10-08', times: T('17:00', 60), color: 'pink', name: '森' }, token)).status, 200);

// 9) 1か月分
r = await call('GET', '/api/edit/month?month=2026-10', null, token);
assert.equal(r.body.days.length, 31);
assert.equal((await call('GET', '/api/edit/month?month=2026-13', null, token)).status, 400);
assert.equal((await call('GET', '/api/edit/month?month=2026-10')).status, 401);

// 10) 設定
r = await call('GET', '/api/edit/settings', null, token);
assert.deepEqual(r.body.settings.lengths, [10, 20, 30, 60, 90, 120, 'all']);
r = await call('POST', '/api/edit/settings', { lengths: [30, 60, 'all', 999], defaultLength: 30 }, token);
assert.deepEqual(r.body.settings, { lengths: [30, 60, 'all'], defaultLength: 30 });

// 11) キャンセル：予約表から消えて記録に残る
await call('POST', '/api/edit/cells', { date: '2026-10-15', times: T('11:00', 60), color: 'pink', name: '岡田' }, token);
r = await call('POST', '/api/edit/cancel', { date: '2026-10-15', times: T('11:00', 60) }, token);
assert.equal(r.status, 200);
assert.ok(!r.body.day.cells['11:00']);
r = await call('GET', '/api/edit/cancels?month=2026-10', null, token);
assert.equal(r.body.cancels.length, 1);
assert.equal(r.body.cancels[0].name, '岡田');
assert.equal(r.body.cancels[0].minutes, 60);
assert.equal((await call('POST', '/api/edit/cancel', { date: '2026-10-15', times: T('11:00', 60) }, token)).status, 409);

// 12) 固定予約：毎週火曜10:00 60分、重なりはスキップ
await call('POST', '/api/edit/cells', { date: '2026-10-20', times: T('10:30', 30), color: 'red', name: '先約' }, token);
r = await call('POST', '/api/edit/fixed', { rules: [{ name: '固定さん', color: 'blue', weekday: 2, start: '10:00', minutes: 60, from: '2026-10-01' }] }, token);
assert.equal(r.body.rules.length, 1);
r = await call('POST', '/api/edit/fixed/apply', { from: '2026-10-01', to: '2026-10-31' }, token);
assert.equal(r.body.result.placed, 3);          // 10/6, 10/13, 10/27
assert.equal(r.body.result.skipped.length, 1);  // 10/20 は先約
r = await call('POST', '/api/edit/fixed/apply', { from: '2026-10-01', to: '2026-10-31' }, token);
assert.equal(r.body.result.existing, 3);        // 2回目は重複して入れない
assert.equal((await call('POST', '/api/edit/fixed', { rules: [{ name: '', weekday: 2, start: '10:00', from: '2026-10-01' }] }, token)).status, 400);

// 13) 週のコピー：10/5の週 → 11/2から2週
await call('POST', '/api/edit/cells', { date: '2026-11-06', times: T('13:20', 30), color: 'blue', name: '先約さん' }, token);
r = await call('POST', '/api/edit/copy-week', { source: '2026-10-05', target: '2026-11-02', weeks: 2 }, token);
assert.equal(r.status, 200);
assert.ok(r.body.result.overwritten.some(x => x.name === '先約さん' && x.minutes === 30)); // 強制上書きされ、結果に載る
assert.equal(r.body.result.skipped.length, 0);
assert.equal((await call('POST', '/api/edit/copy-week', { source: '2026-10-05', target: '2026-10-05', weeks: 1 }, token)).status, 400);
assert.equal((await call('POST', '/api/edit/copy-week', { source: '2026-09-28', target: '2026-10-05', weeks: 1 }, token)).status, 400); // 今週は不可
r2 = await call('GET', '/api/edit/week?start=2026-11-02', null, token);
const src = (await call('GET', '/api/edit/week?start=2026-10-05', null, token)).body.days;
const strip = cells => Object.fromEntries(Object.entries(cells).map(([t, c]) => [t, { ...c, s: undefined }].map(x => x)).map(([t, c]) => { const { s, ...rest } = c; return [t, rest]; }));
assert.deepEqual(strip(r2.body.days[4].day.cells), strip(src[4].day.cells)); // 金曜が同じ
assert.ok(r2.body.days[4].day.cells['13:00'].s.startsWith('w:'));
assert.equal((await call('POST', '/api/edit/copy-week', { source: '2026-10-06', target: '2026-11-02', weeks: 1 }, token)).status, 400);

// 14) バックアップに設定・固定予約・キャンセル記録が入る
const exp2 = (await call('GET', '/api/edit/export', null, token)).body;
assert.ok(exp2.extra['meta/settings'] && exp2.extra['meta/fixed'] && exp2.extra['cancels/2026-10']);
await call('POST', '/api/edit/fixed', { rules: [] }, token);
await call('POST', '/api/edit/restore', exp2, token);
assert.equal((await call('GET', '/api/edit/fixed', null, token)).body.rules.length, 1);

// 15) スプレッドシート取り込み（Googleの応答を模擬）
{
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal((await call('GET', '/api/edit/import-status', null, token)).body.configured, false);
  process.env.GOOGLE_SPREADSHEET_ID = 'sheet-id';
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  assert.equal((await call('GET', '/api/edit/import-status', null, token)).body.configured, true);
  const hdr1 = [{ formattedValue: '1' }], hdr2 = [{}];
  for (let h = 9; h <= 21; h++) for (let k = 1; k <= 6; k++) { hdr1.push(k === 1 ? { formattedValue: h + ':00' } : {}); hdr2.push({ formattedValue: String(k * 10) }); }
  const serial = d => (Date.UTC(...d.split('-').map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(1899, 11, 30)) / 86400000;
  const dateCell = d => ({ formattedValue: 'x', effectiveValue: { numberValue: serial(d) }, effectiveFormat: { numberFormat: { type: 'DATE' } } });
  const row = cells => ({ values: cells });
  const mag = { effectiveFormat: { backgroundColor: { red: 1, blue: 1 } } };
  const r1 = [{}]; for (let i = 0; i < 78; i++) r1.push({ effectiveFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } });
  r1[7] = { formattedValue: '下村', ...mag }; for (let i = 8; i <= 12; i++) r1[i] = mag;          // 10:00〜 60分
  r1[20] = { formattedValue: '景山', effectiveFormat: { backgroundColor: { red: 0.29, green: 0.525, blue: 0.91 } } }; // 12:10 青
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, opt) => {
    u = String(u);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'tok' }));
    const ranges = new URL(u).searchParams.getAll('ranges');
    if (ranges.length === 1) return new Response(JSON.stringify({ sheets: [{ data: [{ rowData: [row([dateCell('2026-11-02')]), row([dateCell('2026-11-03')])] }] }] }));
    return new Response(JSON.stringify({ sheets: [{ data: [{ rowData: [row(hdr1), row(hdr2)] }, { rowData: [row(r1), row([{}])] }] }] }));
  };
  r = await call('POST', '/api/edit/import-sheet', { from: '2026-11-01', to: '2026-11-07', dryRun: true }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stats.days, 2);
  assert.equal(r.body.stats.perDay[0].names, 2);
  assert.ok(r.body.stats.overwriteDays >= 1); // 11/2 は週のコピーで予約あり
  r = await call('POST', '/api/edit/import-sheet', { from: '2026-11-01', to: '2026-11-07' }, token);
  const nov = (await call('GET', '/api/edit/week?start=2026-11-02', null, token)).body.days[0].day.cells;
  assert.deepEqual(nov['10:00'], { c: 'pink', n: '下村' });
  assert.deepEqual(nov['10:50'], { c: 'pink' });
  assert.deepEqual(nov['12:10'], { c: 'blue', n: '景山' });
  assert.equal(Object.keys(nov).length, 7);
  globalThis.fetch = realFetch;
}

// 16) 無期限の週のコピー → 1人分だけ今日以降をすべて削除
await call('POST', '/api/edit/cells', { date: '2026-12-07', times: T('10:00', 60), color: 'pink', name: '無期限さん' }, token);
await call('POST', '/api/edit/cells', { date: '2026-12-08', times: T('15:00', 60), color: 'blue', name: '残る人' }, token);
r = await call('POST', '/api/edit/copy-week', { source: '2026-12-07', target: '2026-12-14', weeks: null }, token);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.result.placed, 10); // 12/14〜1/11 の5週 × 2人
r = await call('GET', '/api/edit/copies', null, token);
const unl = r.body.copies.find(c => c.weeks === null);
assert.ok(unl && unl.count === 2);
let wk = (await call('GET', '/api/edit/week?start=2027-01-11', null, token)).body.days;
const ser = wk[0].day.cells['10:00'].s;
assert.ok(ser && ser.startsWith('w:'));
r = await call('POST', '/api/edit/series/delete', { series: ser }, token);
assert.equal(r.body.removed, 5);
wk = (await call('GET', '/api/edit/week?start=2027-01-11', null, token)).body.days;
assert.ok(!wk[0].day.cells['10:00'] && !wk[0].day.cells['10:50']);  // 無期限さんは消えた
assert.equal(wk[1].day.cells['15:00'].n, '残る人');                   // 同じコピーの別の人は残る
assert.equal((await call('GET', '/api/edit/copies', null, token)).body.copies.find(c => c.id === unl.id).count, 1);
// コピー全体を停止
r = await call('POST', '/api/edit/series/delete', { series: 'rule:' + unl.id }, token);
assert.equal(r.body.removed, 5);
assert.ok(!(await call('GET', '/api/edit/copies', null, token)).body.copies.find(c => c.id === unl.id));
// 固定予約：今日(10/9)以降だけ消え、登録は昨日までに
const fx = (await call('GET', '/api/edit/fixed', null, token)).body.rules[0];
r = await call('POST', '/api/edit/series/delete', { series: 'f:' + fx.id }, token);
assert.equal(r.body.removed, 2);  // 10/13, 10/27（10/6は過去なので残す）
assert.equal((await call('GET', '/api/edit/week?start=2026-10-05', null, token)).body.days[1].day.cells['10:00'].n, '固定さん');
assert.equal((await call('GET', '/api/edit/fixed', null, token)).body.rules[0].to, '2026-10-08');

// 17) キャンセルを戻す
await call('POST', '/api/edit/cells', { date: '2026-10-16', times: T('14:00', 60), color: 'blue', name: '戻し太郎' }, token);
r = await call('POST', '/api/edit/cancel', { date: '2026-10-16', times: T('14:00', 60) }, token);
const ent = r.body.entry;
// 空いた時間に別の予約が入ると戻せない
await call('POST', '/api/edit/cells', { date: '2026-10-16', times: T('14:30', 30), color: 'pink', name: '後から' }, token);
assert.equal((await call('POST', '/api/edit/cancel/restore', { date: ent.date, start: ent.start, at: ent.at }, token)).status, 409);
await call('POST', '/api/edit/cells', { date: '2026-10-16', times: T('14:30', 30), ownTimes: T('14:30', 30), color: null, name: '' }, token);
r = await call('POST', '/api/edit/cancel/restore', { date: ent.date, start: ent.start, at: ent.at }, token);
assert.equal(r.status, 200);
assert.deepEqual(r.body.day.cells['14:00'], { c: 'blue', n: '戻し太郎' });
assert.deepEqual(r.body.day.cells['14:50'], { c: 'blue' });
assert.ok(!(await call('GET', '/api/edit/cancels?month=2026-10', null, token)).body.cancels.some(x => x.name === '戻し太郎'));
assert.equal((await call('POST', '/api/edit/cancel/restore', { date: ent.date, start: ent.start, at: ent.at }, token)).status, 404);

// 18) パスワード変更：古いトークンは無効、新しいパスワードで入れる
assert.equal((await call('POST', '/api/edit/password', { current: 'wrong', next: 'abcd' }, token)).status, 400);
assert.equal((await call('POST', '/api/edit/password', { current: 'test-pass-1234', next: 'abc' }, token)).status, 400);
r = await call('POST', '/api/edit/password', { current: 'test-pass-1234', next: 'newpass99' }, token);
assert.equal(r.status, 200);
const token2 = r.body.token;
assert.equal((await call('GET', '/api/edit/week?start=2026-10-05', null, token)).status, 401);   // 古いログインは無効
assert.equal((await call('GET', '/api/edit/week?start=2026-10-05', null, token2)).status, 200);  // 変えた端末はそのまま
assert.equal((await call('POST', '/api/login', { password: 'test-pass-1234' })).status, 401);
assert.equal((await call('POST', '/api/login', { password: 'newpass99' })).status, 200);
// バックアップにパスワード情報は入らない
const exp3 = (await call('GET', '/api/edit/export', null, token2)).body;
assert.ok(!JSON.stringify(exp3).includes('"hash"') && !exp3.extra['meta/auth']);
assert.equal((await call('POST', '/api/edit/password', { current: 'newpass99', next: 'test' }, token2)).status, 400); // test は予約ちゃん2用
// 10回間違えるとロック（正しいパスワードでも入れない）
for (let i = 0; i < 10; i++) await call('POST', '/api/login', { password: 'nope' + i });
assert.equal((await call('POST', '/api/login', { password: 'newpass99' })).status, 429);

// 19) 患者向け：今週より前は見せない（今日=10/9(金)、今週の月曜=10/5）
{
  const { publicDay } = await import('../lib/core.mjs');
  const busy = { cells: { '10:00': { c: 'pink', n: 'x' } } };
  assert.ok(publicDay('2026-10-02', busy, '2026-10-09').slots.every(x => x.status === 'none')); // 先週
  assert.equal(publicDay('2026-10-05', busy, '2026-10-09').slots[0].status, 'full');             // 今週の月曜は見える
  assert.equal(publicDay('2026-10-12', {}, '2026-10-11').slots[0].status, 'available');        // 日曜の翌週月曜
  assert.ok(publicDay('2026-10-04', busy, '2026-10-11').slots.every(x => x.status === 'none')); // 日曜(10/11)基準の今週は10/5から
}

console.log('ALL TESTS PASSED');
