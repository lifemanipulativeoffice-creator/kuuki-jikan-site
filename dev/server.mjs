// ローカル確認用サーバー（Netlifyに上げる前の動作確認だけに使う）
// 使い方: YOYAKU_PASSWORD=xxxxxxxx YOYAKU_SECRET=(32文字以上) node dev/server.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.YOYAKU_LOCAL_DIR ||= path.join(root, 'dev', 'data');
const { handle } = await import('../lib/router.mjs');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const r = await handle(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(path.join(root, 'public'))) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(process.env.PORT || 8888, () => console.log('予約ちゃん http://localhost:' + (process.env.PORT || 8888)));
