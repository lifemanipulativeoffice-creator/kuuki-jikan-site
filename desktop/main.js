// =========================================================
// 予約ちゃん PC版（Electron）
// データはパソコンに置かず、Netlify上の予約ちゃんをそのまま開くだけ。
// → スマホ（アプリ）とPC（ソフト）で同じ予約表を見られる。
// 会計くんと違ってパソコン内に患者データを保存しない。
// =========================================================
const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function loadConfig() {
  // インストール後に URL を変えたいときは、ユーザーデータフォルダの config.json が優先される
  const candidates = [path.join(app.getPath('userData'), 'config.json'), path.join(__dirname, 'config.json')];
  for (const file of candidates) {
    try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.url && /^https:\/\//.test(c.url)) return c; } catch {}
  }
  return { url: '' };
}

const config = loadConfig();
let allowedOrigin = '';
try { allowedOrigin = new URL(config.url).origin; } catch {}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    title: '予約ちゃん',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f5eee5',
    webPreferences: {
      contextIsolation: true,   // ページからパソコンの機能に触れないようにする
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 予約ちゃんのサイト以外へは移動させない（外部リンクは普段のブラウザで開く）
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(allowedOrigin + '/')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(allowedOrigin + '/')) return { action: 'allow' };
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // つながらないとき（オフライン等）は案内画面を出す
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: config.url } });
  });

  if (!allowedOrigin) win.loadFile(path.join(__dirname, 'offline.html'), { query: { setup: '1' } });
  else win.loadURL(config.url);
}

// 月の予約記録をA4横のPDFファイルとして保存（予約ちゃんのページから頼まれたときだけ）
ipcMain.handle('yoyaku:save-pdf', async (event, filename) => {
  const senderUrl = event.senderFrame ? event.senderFrame.url : '';
  if (!allowedOrigin || !senderUrl.startsWith(allowedOrigin + '/')) throw new Error('許可されていないページです');
  const win = BrowserWindow.fromWebContents(event.sender);
  const safeName = String(filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '予約記録.pdf';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'PDFを保存',
    defaultPath: path.join(app.getPath('documents'), safeName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { saved: false };
  const pdf = await event.sender.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true, margins: { marginType: 'none' } });
  fs.writeFileSync(filePath, pdf);
  shell.openPath(filePath);
  return { saved: true };
});

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: '表示', submenu: [
    { label: '再読み込み', accelerator: 'F5', role: 'reload' },
    { label: '拡大', role: 'zoomIn' }, { label: '縮小', role: 'zoomOut' }, { label: '標準の大きさ', role: 'resetZoom' },
    { type: 'separator' }, { label: '全画面', role: 'togglefullscreen' },
  ]},
  { label: '編集', submenu: [{ role: 'undo', label: '元に戻す' }, { role: 'cut', label: '切り取り' }, { role: 'copy', label: 'コピー' }, { role: 'paste', label: '貼り付け' }] },
]));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
