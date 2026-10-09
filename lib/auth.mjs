// =========================================================
// 編集用の認証（サーバー側で毎回確認する）
// - パスワードは画面から変更できる（ハッシュ化して保存）。初期値は 0000
// - ログインすると「1年間有効の署名トークン」を発行し、端末に保存する
//   → 次回からは起動するとそのまま本体が開く。ログアウトしたときだけログイン画面
// - パスワードを変えると、ほかの端末のログインはすべて無効になる
// - 続けて10回間違えると15分ロック（0000のような短いパスワードの総当たり対策）
// =========================================================
import { createHmac, timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';
import { getKey, updateKey } from './store.mjs';

const TOKEN_DAYS = 365;
const AUTH_KEY = 'meta/auth';
const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const FAIL_DELAY_MS = Number(process.env.YOYAKU_FAIL_DELAY_MS ?? 1000);

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
const hashPw = (pw, salt) => scryptSync(String(pw), salt, 32).toString('hex');
const defaultPassword = () => process.env.YOYAKU_PASSWORD || '0000';

async function readAuth() { return (await getKey(AUTH_KEY))?.data || {}; }

// 署名の鍵：環境変数があればそれ、なければ初回に自動で作って保存
async function getSecret() {
  const env = process.env.YOYAKU_SECRET || '';
  if (env.length >= 32) return env;
  const a = await readAuth();
  if (a.secret) return a.secret;
  const saved = await updateKey(AUTH_KEY, cur => (cur && cur.secret) ? cur : { ...(cur || {}), secret: randomBytes(32).toString('hex') });
  return saved.secret;
}

async function checkPassword(pw, a) {
  if (a.hash && a.salt) return safeEqual(hashPw(pw, a.salt), a.hash);
  return safeEqual(pw, defaultPassword());
}

export async function authStatus() {
  const a = await readAuth();
  return { isDefault: !a.hash && defaultPassword() === '0000' };
}

async function issueToken(version) {
  const payload = b64url(JSON.stringify({ exp: Date.now() + TOKEN_DAYS * 86400 * 1000, v: version, n: randomBytes(6).toString('hex') }));
  const sig = b64url(createHmac('sha256', await getSecret()).update(payload).digest());
  return payload + '.' + sig;
}

export async function login(password) {
  const a = await readAuth();
  if (a.lockUntil && a.lockUntil > Date.now()) {
    const min = Math.ceil((a.lockUntil - Date.now()) / 60000);
    throw httpError(429, `続けて間違えたため、あと${min}分ほどログインできません。`);
  }
  if (!(await checkPassword(password || '', a))) {
    const now = Date.now();
    await updateKey(AUTH_KEY, cur => {
      const c = { ...(cur || {}) };
      const fails = (Array.isArray(c.fails) ? c.fails : []).filter(t => now - t < WINDOW_MS);
      fails.push(now);
      if (fails.length >= MAX_FAILS) { c.lockUntil = now + WINDOW_MS; c.fails = []; }
      else c.fails = fails;
      return c;
    });
    await new Promise(r => setTimeout(r, FAIL_DELAY_MS));
    throw httpError(401, 'パスワードが違います。');
  }
  if ((a.fails && a.fails.length) || a.lockUntil) await updateKey(AUTH_KEY, cur => ({ ...(cur || {}), fails: [], lockUntil: 0 }));
  return { token: await issueToken(a.v || 0), isDefault: !a.hash && defaultPassword() === '0000' };
}

export async function verify(request) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw httpError(401, 'ログインしてください。');
  const expected = b64url(createHmac('sha256', await getSecret()).update(payload).digest());
  if (!safeEqual(sig, expected)) throw httpError(401, 'ログインしてください。');
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw httpError(401, 'ログインしてください。'); }
  if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) throw httpError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。');
  const a = await readAuth();
  if ((data.v || 0) !== (a.v || 0)) throw httpError(401, 'パスワードが変更されたため、もう一度ログインしてください。');
}

export async function changePassword(current, next) {
  const a = await readAuth();
  if (!(await checkPassword(String(current || ''), a))) {
    await new Promise(r => setTimeout(r, FAIL_DELAY_MS));
    throw httpError(400, '今のパスワードが違います。');
  }
  const pw = String(next || '');
  if ([...pw].length < 4 || [...pw].length > 64) throw httpError(400, '新しいパスワードは4〜64文字にしてください。');
  if (/[\u0000-\u001f]/.test(pw)) throw httpError(400, '使えない文字が入っています。');
  if (pw === 'test') throw httpError(400, '「test」は予約ちゃん2用のため使えません。');
  const salt = randomBytes(16).toString('hex');
  const saved = await updateKey(AUTH_KEY, cur => ({ ...(cur || {}), salt, hash: hashPw(pw, salt), v: ((cur && cur.v) || 0) + 1, fails: [], lockUntil: 0 }));
  return { token: await issueToken(saved.v) };
}
