// ==========================================================
// フロントエンドロジック
// このファイルはブラウザ上で動くため、
// サーバーAPIから受け取るのは「日付・時刻・○△×」のみ。
// 説明文（空きがあります 等）はこちらで状態から機械的に生成する。
// ==========================================================

const state = {
  viewYear: null,
  viewMonth: null, // 1-12
  publicConfig: null,
};

const STATUS_CLASS = { '○': 'status-circle', '△': 'status-triangle', '×': 'status-cross' };
const STATUS_DESC = {
  '○': '空きがあります',
  '△': '一部のコースのみ空きがあります',
  '×': '空きがありません',
};
const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土'];

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('取得に失敗しました');
  return res.json();
}

async function loadPublicConfig() {
  state.publicConfig = await fetchJson('/api/public-config');
  document.getElementById('line-cta-btn').href = state.publicConfig.lineUrl || '#';
  document.getElementById('official-site-link').href = state.publicConfig.officialSiteUrl || '#';
}

function renderDailyList(containerId, slots) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!slots || slots.length === 0) {
    container.innerHTML = '<tr><td colspan="3" class="small-note">この日のデータはありません。</td></tr>';
    return;
  }
  slots.forEach((slot) => {
    const row = document.createElement('tr');
    row.className = STATUS_CLASS[slot.status] || '';
    row.innerHTML = `
      <td class="col-time">${slot.start} ～ ${slot.end}</td>
      <td class="col-status"><span class="row-symbol">${slot.status}</span></td>
      <td class="col-desc">${STATUS_DESC[slot.status] || ''}</td>
    `;
    container.appendChild(row);
  });
}

async function loadTodayPanel() {
  const iso = todayIso();
  const d = new Date(iso);
  const label = `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_JP[d.getDay()]}）`;
  document.getElementById('today-date').textContent = label;
  try {
    const data = await fetchJson(`/api/daily?date=${iso}`);
    renderDailyList('today-list', data.slots);
  } catch (e) {
    document.getElementById('today-list').innerHTML = '<tr><td colspan="3" class="small-note">読み込みに失敗しました。時間をおいて再度お試しください。</td></tr>';
  }
}

async function loadMonthlyCalendar(year, month) {
  state.viewYear = year;
  state.viewMonth = month;
  document.getElementById('month-title').textContent = `${year}年 ${month}月`;

  let days = {};
  try {
    const data = await fetchJson(`/api/monthly?year=${year}&month=${month}`);
    days = data.days || {};
  } catch (e) {
    // 取得失敗時は空のまま描画（エラーは静かに扱い、目安表示の趣旨を保つ）
  }

  renderCalendarGrid(year, month, days);
}

function renderCalendarGrid(year, month, days) {
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  const firstDay = new Date(year, month - 1, 1);
  // 月曜始まりにするためのオフセット計算（0=月曜 ... 6=日曜）
  const jsDay = firstDay.getDay(); // 0=日曜
  const offset = (jsDay + 6) % 7;

  const daysInMonth = new Date(year, month, 0).getDate();

  for (let i = 0; i < offset; i++) {
    const empty = document.createElement('div');
    empty.className = 'day-cell empty';
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const status = days[iso] || '×';
    const weekday = new Date(year, month - 1, day).getDay(); // 0=日曜, 6=土曜

    const cell = document.createElement('div');
    let cls = `day-cell ${STATUS_CLASS[status] || ''}`;
    if (weekday === 6) cls += ' is-sat';
    if (weekday === 0) cls += ' is-sun';
    cell.className = cls;
    cell.innerHTML = `<span class="date-num">${day}</span><span class="status-symbol">${status}</span>`;
    cell.addEventListener('click', () => openDailyModal(iso, year, month, day));
    grid.appendChild(cell);
  }
}

async function openDailyModal(iso, year, month, day) {
  document.getElementById('modal-title').textContent = `${month}月${day}日の空き情報`;
  document.getElementById('modal-list').innerHTML = '<tr><td colspan="3" class="small-note">読み込み中です…</td></tr>';
  document.getElementById('modal-overlay').classList.add('open');

  try {
    const data = await fetchJson(`/api/daily?date=${iso}`);
    renderDailyList('modal-list', data.slots);
  } catch (e) {
    document.getElementById('modal-list').innerHTML = '<tr><td colspan="3" class="small-note">読み込みに失敗しました。時間をおいて再度お試しください。</td></tr>';
  }
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function changeMonth(diff) {
  let { viewYear, viewMonth } = state;
  viewMonth += diff;
  if (viewMonth > 12) { viewMonth = 1; viewYear += 1; }
  if (viewMonth < 1) { viewMonth = 12; viewYear -= 1; }
  loadMonthlyCalendar(viewYear, viewMonth);
}

function init() {
  const today = new Date();

  loadPublicConfig();
  loadMonthlyCalendar(today.getFullYear(), today.getMonth() + 1);
  loadTodayPanel();

  document.getElementById('prev-month').addEventListener('click', () => changeMonth(-1));
  document.getElementById('next-month').addEventListener('click', () => changeMonth(1));

  // 「それ以降のご予約状況はこちら」→ 翌月の月間予報へ進む（同一カレンダーUIを利用）
  document.getElementById('future-btn').addEventListener('click', () => {
    changeMonth(1);
    document.getElementById('monthly-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
}

document.addEventListener('DOMContentLoaded', init);
