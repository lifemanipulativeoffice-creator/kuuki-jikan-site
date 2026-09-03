// ==========================================================
// ○△×判定ロジック
// 【重要】この先の戻り値には「日付」「時刻」「status(○/△/×)」以外の
// 情報（患者名・性別・色の種類など）を絶対に含めない。
// ==========================================================

const config = require('../config/config');

function colorDistance(c1, c2) {
  const r = (c1.red || 0) - (c2.red || 0);
  const g = (c1.green || 0) - (c2.green || 0);
  const b = (c1.blue || 0) - (c2.blue || 0);
  return Math.sqrt(r * r + g * g + b * b);
}

/**
 * セルの背景色から「空きか、空きでないか」だけを判定する。
 * 白＝空き。グレー・ピンク・青・赤はすべて「空きなし」として扱う
 * （外部サイトでは色の種類を一切区別しない）。
 */
function isFreeColor(backgroundColor) {
  const { white, tolerance } = config.cellColors;
  return colorDistance(backgroundColor, white) <= tolerance;
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 生のグリッドデータ（行=日付、列=時間）から、
 * 「日付ごとの、営業時間内・10分刻みの空き/空きなし配列」を作る。
 * ここではまだ患者名等は捨てていないが、次の関数以降には一切渡さない。
 */
function buildDailySlotMaps(gridData) {
  const layout = config.sheetLayout;
  const headerRow = gridData[layout.timeHeaderRow - 1] || [];

  // 時間ヘッダー行から「列番号→時刻文字列」のマップを作る
  const columnToTime = {};
  for (let col = layout.timeStartColumn - 1; col < headerRow.length; col++) {
    const cell = headerRow[col];
    if (cell && cell.value) {
      columnToTime[col] = normalizeTimeLabel(cell.value);
    }
  }

  const businessStart = timeToMinutes(layout.businessStartTime);
  const businessEnd = timeToMinutes(layout.businessEndTime);

  const result = {}; // { 'YYYY-MM-DD': { '10:00': true/false, ... } }

  for (let row = layout.dataStartRow - 1; row < gridData.length; row++) {
    const rowCells = gridData[row];
    if (!rowCells) continue;
    const dateCell = rowCells[layout.dateColumn - 1];
    if (!dateCell || !dateCell.value) continue;

    const isoDate = normalizeDateLabel(dateCell.value);
    if (!isoDate) continue;

    const slotMap = {};
    Object.keys(columnToTime).forEach((colStr) => {
      const col = Number(colStr);
      const timeLabel = columnToTime[col];
      const mins = timeToMinutes(timeLabel);
      if (mins < businessStart || mins >= businessEnd) return;

      const cell = rowCells[col];
      const free = cell ? isFreeColor(cell.backgroundColor) : true;
      slotMap[timeLabel] = free;
    });

    result[isoDate] = slotMap;
  }

  return result;
}

// スプレッドシート側の日付表記ゆれ（2026/9/1, 2026-09-01 など）を
// YYYY-MM-DD に正規化する。パースできなければ null。
function normalizeDateLabel(raw) {
  const trimmed = String(raw).trim();
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 時間ヘッダーの表記ゆれ（9:00, 09:00 など）を HH:MM に正規化する
function normalizeTimeLabel(raw) {
  const trimmed = String(raw).trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return trimmed;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * 1日分の10分刻みslotMapを解析し、「連続して空いている区間（ラン）」の一覧を作る。
 * 各ランには、
 *   ・lengthMinutes: そのランの連続空き分数
 *   ・boxedBothSides: そのランの直前・直後の両方が「予約あり」で挟まれているか
 *     （営業開始・終業時刻に接している側は「挟まれている」に含めない）
 * を付与する。
 *
 * 「30分/60分だけ空いていても、前後を予約で挟まれていたら○にしない」という
 * ルールは、このboxedBothSidesの情報を使って判定する。
 */
function analyzeFreeRuns(slotMap, slotMinutes) {
  const times = Object.keys(slotMap).sort();
  const runs = [];
  let current = null;

  times.forEach((t, idx) => {
    if (slotMap[t]) {
      if (!current) current = { times: [], startIdx: idx };
      current.times.push(t);
    } else if (current) {
      current.lengthMinutes = current.times.length * slotMinutes;
      current.boxedBefore = current.startIdx > 0;
      current.boxedAfter = true; // ここで途切れた＝直後の枠(idx)は予約あり
      current.boxedBothSides = current.boxedBefore && current.boxedAfter;
      runs.push(current);
      current = null;
    }
  });

  if (current) {
    current.lengthMinutes = current.times.length * slotMinutes;
    current.boxedBefore = current.startIdx > 0;
    current.boxedAfter = false; // 営業終了時刻まで空きが続いている＝後ろは挟まれていない
    current.boxedBothSides = current.boxedBefore && current.boxedAfter;
    runs.push(current);
  }

  const timeToRun = {};
  runs.forEach((run) => {
    run.times.forEach((t) => { timeToRun[t] = run; });
  });

  return { runs, timeToRun };
}

/**
 * 月間カレンダー用: 1日分のslotMapから ○/△/× を判定する。
 * 判定基準は config.availabilityThresholds.monthly を参照するのみで、
 * ロジック自体は基準値を変えるだけで挙動が変わる。
 */
function judgeDayStatus(slotMap) {
  const layout = config.sheetLayout;
  const th = config.availabilityThresholds.monthly;

  const hasAnyFree = Object.values(slotMap).some(Boolean);
  if (!hasAnyFree) return '×';

  const maxRun = maxConsecutiveFreeMinutes(slotMap, layout.slotMinutes);

  if (maxRun >= th.circleMinConsecutiveMinutes) return '○';
  if (maxRun >= th.triangleMinConsecutiveMinutes) return '△';
  return '△'; // 空きはあるが基準に満たない → △
}

/**
 * 日別詳細（本日の空き情報など）用: 30分刻みの ○/△/× 配列を作る。
 *
 * 基本ルール: 30分内の10分コマがすべて空き→○、すべて埋まり→×、それ以外→△
 *
 * 追加ルール（孤立した空きの格下げ）:
 * 「30分/60分だけ空いていても、前後を予約で挟まれていたら○にしない」。
 * 例）12:00予約あり／13:00予約なし／14:00予約ありの場合、
 *     13:00の枠は単体では全コマ空きだが、前後を予約に挟まれているため○ではなく△とする。
 * ただし、挟まれた空き区間が長い場合（config.availabilityThresholds.daily.
 * isolatedGapMaxMinutesToDowngrade を超える場合）は、実用上十分な空きとみなし○のままにする。
 */
function buildDailyDetail(slotMap) {
  const layout = config.sheetLayout;
  const dailyCfg = config.availabilityThresholds.daily;
  const displayMinutes = dailyCfg.slotDisplayMinutes;
  const slotsPerDisplay = displayMinutes / layout.slotMinutes;
  const isolatedMaxMinutes = dailyCfg.isolatedGapMaxMinutesToDowngrade;

  const times = Object.keys(slotMap).sort();
  const { timeToRun } = analyzeFreeRuns(slotMap, layout.slotMinutes);

  const detail = [];

  for (let i = 0; i < times.length; i += slotsPerDisplay) {
    const chunk = times.slice(i, i + slotsPerDisplay);
    if (chunk.length === 0) continue;
    const freeCount = chunk.filter((t) => slotMap[t]).length;

    let status;
    if (freeCount === chunk.length) {
      // 全コマ空き。ただし前後を予約に挟まれた短い孤立区間なら△に格下げする。
      const run = timeToRun[chunk[0]];
      const isIsolatedShortGap = run && run.boxedBothSides && run.lengthMinutes <= isolatedMaxMinutes;
      status = isIsolatedShortGap ? '△' : '○';
    } else if (freeCount === 0) {
      status = '×';
    } else {
      status = '△';
    }

    const startTime = chunk[0];
    const endMinutes = timeToMinutes(chunk[chunk.length - 1]) + layout.slotMinutes;
    detail.push({
      start: startTime,
      end: minutesToTime(endMinutes),
      status,
    });
  }

  return detail;
}

/**
 * 月間カレンダー用データを組み立てる（外部公開用・個人情報一切含まず）。
 * overrides（「手動設定」タブの内容）があれば、自動計算より優先して採用する。
 * 戻り値: { '2026-09-01': '○', '2026-09-02': '△', ... }
 */
function buildMonthlyForecast(gridData, year, month /* 1-12 */, overrides = {}) {
  const dailyMaps = buildDailySlotMaps(gridData);
  const result = {};

  Object.keys(dailyMaps).forEach((isoDate) => {
    const [y, m] = isoDate.split('-').map(Number);
    if (y === year && m === month) {
      result[isoDate] = judgeDayStatus(dailyMaps[isoDate]);
    }
  });

  // 手動設定を自動計算より優先して上書き（対象月の日付のみ）
  Object.keys(overrides).forEach((isoDate) => {
    const [y, m] = isoDate.split('-').map(Number);
    if (y === year && m === month) {
      result[isoDate] = overrides[isoDate];
    }
  });

  return result;
}

/**
 * 指定日の30分刻み詳細データを組み立てる（外部公開用）。
 */
function buildDayDetail(gridData, isoDate) {
  const dailyMaps = buildDailySlotMaps(gridData);
  const slotMap = dailyMaps[isoDate];
  if (!slotMap) return [];
  return buildDailyDetail(slotMap);
}

module.exports = {
  buildDailySlotMaps,
  buildMonthlyForecast,
  buildDayDetail,
  judgeDayStatus,
};
