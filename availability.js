'use strict';

const config = require('./config');

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// "9:00" のような時刻ラベルを「0時からの経過分」に変換する
function parseHourLabelToMinutes(label) {
  const s = text(label);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return hour * 60 + minute;
}

/*
 * ヘッダーは2行構成。
 * 1行目：時刻ラベル（"9:00"等）が各時間ブロックの先頭列だけに書かれる
 * 2行目：分オフセット（10,20,30,40,50,60）が列ごとに書かれる
 * 実際の時刻 = 直前に出てきた時刻ラベル + (その列の分オフセット - 10)
 */
function buildColumnTimeMap(hourRow, minuteRow, timeStartColumnIndex) {
  const map = new Map();

  if (!Array.isArray(hourRow) || !Array.isArray(minuteRow)) return map;

  let currentHourMinutes = null;
  const lastCol = Math.max(hourRow.length, minuteRow.length);

  for (let c = timeStartColumnIndex; c < lastCol; c++) {
    const hourLabel = parseHourLabelToMinutes(hourRow[c]);
    if (hourLabel !== null) {
      currentHourMinutes = hourLabel;
    }

    const minuteOffsetText = text(minuteRow[c]);
    if (minuteOffsetText === '' || currentHourMinutes === null) continue;

    const minuteOffset = Number(minuteOffsetText);
    if (Number.isNaN(minuteOffset)) continue;

    map.set(currentHourMinutes + minuteOffset - 10, c);
  }

  return map;
}

/* =========================================================
   日付の一致判定
========================================================= */
function serialToYmd(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + Math.round(serial) * 86400000;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function parseMonthDayFromText(value) {
  const s = text(value).replace(/\s/g, '');
  if (!s) return null;

  let m = s.match(/^(\d{1,2})月(\d{1,2})日/);
  if (m) return { month: Number(m[1]), day: Number(m[2]) };

  m = s.match(/^\d{4}[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return { month: Number(m[1]), day: Number(m[2]) };

  m = s.match(/^(\d{1,2})[\/](\d{1,2})(?!\d)/);
  if (m) return { month: Number(m[1]), day: Number(m[2]) };

  return null;
}

function findDayRows(gridData, dateColumnIndex, dataStartRowIndex, targetDate) {
  if (!Array.isArray(gridData)) return [];

  const m = text(targetDate).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return [];

  const targetYear = Number(m[1]);
  const targetMonth = Number(m[2]);
  const targetDay = Number(m[3]);

  const result = [];
  const skipped = [];

  for (let r = dataStartRowIndex; r < gridData.length; r++) {
    const row = Array.isArray(gridData[r]) ? gridData[r] : [];
    if (!row.length) continue;

    const rawDateCell = row[dateColumnIndex];
    const serial = row._dateSerials ? row._dateSerials[dateColumnIndex] : undefined;

    let candidate = null;

    if (typeof serial === 'number') {
      const ymd = serialToYmd(serial);
      candidate = { ...ymd, source: 'serial' };
    } else {
      const parsed = parseMonthDayFromText(rawDateCell);
      if (parsed) {
        candidate = { year: targetYear, month: parsed.month, day: parsed.day, source: 'text' };
      }
    }

    if (!candidate) continue;
    if (candidate.month !== targetMonth || candidate.day !== targetDay) continue;

    if (candidate.source === 'serial' && candidate.year !== targetYear) {
      skipped.push({ rowIndex: r, rawDate: rawDateCell, reason: '年が一致しない', found: candidate.year });
      continue;
    }

    result.push({ rowIndex: r, rawDate: rawDateCell, row });
  }

  if (result.length === 0 && skipped.length > 0) {
    console.warn(`[findDayRows] ${targetDate} は候補行はあったが年不一致等で除外:`, skipped);
  }

  if (result.length > 1) {
    return [result[result.length - 1]];
  }

  return result;
}

/* =========================================================
   色判定（HSL方式）
========================================================= */
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
    case g: h = ((b - r) / d + 2); break;
    default: h = ((r - g) / d + 4); break;
  }
  h *= 60;

  return { h, s, l };
}

function inHueRange(hue, range) {
  return hue >= range[0] && hue <= range[1];
}

function classifyColor(color) {
  if (!color || typeof color !== 'object') return 'free';

  if (color.red === undefined && color.green === undefined && color.blue === undefined) {
    return 'free';
  }

  // Google Sheets APIはRGB各成分が0の場合キー自体を省略して返すため、
  // ??1ではなく??0でデフォルト値を補う（0省略を白と誤認しないための重要な補正）
  const r = color.red ?? 0;
  const g = color.green ?? 0;
  const b = color.blue ?? 0;

  const { h, s, l } = rgbToHsl(r, g, b);
  const rules = config.cellColorRules;

  if (l >= rules.whiteLightnessMin) return 'free';

  if (s <= rules.grayscaleSaturationMax) {
    return l >= rules.grayLightnessThreshold ? 'free' : 'occupied';
  }

  if (rules.redHueRanges.some(range => inHueRange(h, range))) return 'occupied';
  if (inHueRange(h, rules.pinkHueRange)) return 'occupied';

  if (inHueRange(h, rules.blueHueRange)) {
    return l >= rules.lightBlueLightnessMin ? 'free' : 'occupied';
  }

  // 想定外の色は安全側（占有）に倒す
  return 'occupied';
}

function isCellOccupied(row, columnIndex, isBusinessHours) {
  const color = row._backgroundColors ? row._backgroundColors[columnIndex] : null;
  const classification = classifyColor(color);

  if (classification === 'occupied') return true;

  // 営業時間外は「完全な空白」だけを空きとして扱う
  if (!isBusinessHours) {
    const value = row[columnIndex];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return true;
    }
  }

  return false;
}

/* =========================================================
   30分枠の判定
========================================================= */
function checkRangeOccupied(row, columnTimeMap, rangeStart, rangeEnd) {
  const { startHour, endHour } = config.business;
  const businessStartMinutes = startHour * 60;
  const businessEndMinutes = endHour * 60;
  const slotMinutesStep = config.sheetLayout.slotMinutes;

  for (let t = rangeStart; t < rangeEnd; t += slotMinutesStep) {
    const columnIndex = columnTimeMap.get(t);
    if (columnIndex === undefined) continue;

    const isBusinessHours = t >= businessStartMinutes && t < businessEndMinutes;
    if (isCellOccupied(row, columnIndex, isBusinessHours)) {
      return true;
    }
  }
  return false;
}

// 後方互換用：120分全体をまとめてチェックする（二値判定）
function isThirtyMinuteSlotOccupied(row, columnTimeMap, slotStartMinutes) {
  const { treatmentMinutes, bufferMinutes } = config.business;
  const rangeStart = slotStartMinutes - bufferMinutes;
  const rangeEnd = slotStartMinutes + treatmentMinutes + bufferMinutes;
  return checkRangeOccupied(row, columnTimeMap, rangeStart, rangeEnd);
}

/*
 * 30分枠を「前バッファ」「施術本体」「後バッファ」の3区間に分けて判定する。
 * 戻り値: 'available'（全部空き） | 'consult'（施術本体は空きだが前後バッファのどちらかが埋まっている） | 'full'（施術本体自体が埋まっている）
 */
function evaluateThirtyMinuteSlot(row, columnTimeMap, slotStartMinutes) {
  const { treatmentMinutes, bufferMinutes } = config.business;

  const beforeStart = slotStartMinutes - bufferMinutes;
  const beforeEnd = slotStartMinutes;
  const treatmentStart = slotStartMinutes;
  const treatmentEnd = slotStartMinutes + treatmentMinutes;
  const afterStart = treatmentEnd;
  const afterEnd = treatmentEnd + bufferMinutes;

  const treatmentOccupied = checkRangeOccupied(row, columnTimeMap, treatmentStart, treatmentEnd);
  if (treatmentOccupied) return 'full';

  const beforeOccupied = checkRangeOccupied(row, columnTimeMap, beforeStart, beforeEnd);
  const afterOccupied = checkRangeOccupied(row, columnTimeMap, afterStart, afterEnd);

  if (beforeOccupied || afterOccupied) return 'consult';

  return 'available';
}

function buildThirtyMinuteSlots(row, columnTimeMap, manualOverrides, forceClosedByDefault) {
  const { startHour, endHour, displaySlotMinutes } = config.business;
  const slots = [];

  for (let minutes = startHour * 60; minutes <= endHour * 60; minutes += displaySlotMinutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const time = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');

    let status = forceClosedByDefault
      ? 'full'
      : evaluateThirtyMinuteSlot(row, columnTimeMap, minutes);

    const manualStatus = manualOverrides && manualOverrides[time];
    if (manualStatus === '○') status = 'available';
    if (manualStatus === '△') status = 'consult';
    if (manualStatus === '×') status = 'full';

    slots.push({
      time,
      available: status === 'available',
      status,
      manual: manualStatus === '○' || manualStatus === '△' || manualStatus === '×',
    });
  }

  return slots;
}

// 対象日が休診日（日曜）かどうかを、シートではなく実際の曜日から判定する
function isClosedDay(targetDate) {
  const m = text(targetDate).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getDay() === 0; // 0 = 日曜
}

function buildDayDetail(gridData, targetDate, manualOverrides = {}) {
  const layout = config.sheetLayout;

  const dateColumnIndex = layout.dateColumn - 1;
  const dataStartRowIndex = layout.dataStartRow - 1;
  const hourHeaderRowIndex = layout.hourHeaderRow - 1;
  const minuteHeaderRowIndex = layout.minuteHeaderRow - 1;
  const timeStartColumnIndex = layout.timeStartColumn - 1;

  const hourRow = gridData[hourHeaderRowIndex];
  const minuteRow = gridData[minuteHeaderRowIndex];
  const columnTimeMap = buildColumnTimeMap(hourRow, minuteRow, timeStartColumnIndex);

  const matches = findDayRows(gridData, dateColumnIndex, dataStartRowIndex, targetDate);
  const closed = isClosedDay(targetDate);

  const result = {
    date: targetDate,
    found: matches.length > 0 || closed,
    closed,
    slots: [],
  };

  if (closed) {
    const row = matches.length ? matches[0].row : [];
    result.slots = buildThirtyMinuteSlots(row, columnTimeMap, manualOverrides, true);
    return result;
  }

  if (!matches.length) return result;

  result.slots = buildThirtyMinuteSlots(matches[0].row, columnTimeMap, manualOverrides, false);
  return result;
}

module.exports = {
  text,
  parseHourLabelToMinutes,
  buildColumnTimeMap,
  serialToYmd,
  parseMonthDayFromText,
  findDayRows,
  classifyColor,
  checkRangeOccupied,
  isThirtyMinuteSlotOccupied,
  evaluateThirtyMinuteSlot,
  buildThirtyMinuteSlots,
  isClosedDay,
  buildDayDetail,
};
