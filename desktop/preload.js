// ページから使えるのは「PDFで保存」だけ（パソコンのほかの機能には触れさせない）
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('yoyakuDesktop', {
  savePdf: (filename) => ipcRenderer.invoke('yoyaku:save-pdf', String(filename || '予約記録.pdf')),
});
