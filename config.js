require('dotenv').config();

module.exports = {

  google: {
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    sheetName: process.env.GOOGLE_SHEET_NAME || 'シート1',
    serviceAccountKeyJson: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './service-account-key.json',
  },

  admin: {
    password: process.env.ADMIN_PASSWORD || '0000',
  },

  links: {
    lineUrl: process.env.LINE_URL || 'https://lin.ee/61mRZYN',
  },

  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
  },

  sheetLayout: {
    hourHeaderRow: 1,
    minuteHeaderRow: 2,
    dateColumn: 1,
    dataStartRow: 3,
    timeStartColumn: 2,
    slotMinutes: 10,
  },

  business: {
    startHour: 10,
    endHour: 21,
    displaySlotMinutes: 30,
    treatmentMinutes: 60,
    bufferMinutes: 30,
  },

  manualOverrideFile: './manual-overrides.json',

  cellColorRules: {
    whiteLightnessMin: 0.90,
    grayscaleSaturationMax: 0.08,
    grayLightnessThreshold: 0.75,
    redHueRanges: [[0, 15], [345, 360]],
    pinkHueRange: [300, 345],
    blueHueRange: [180, 260],
    lightBlueLightnessMin: 0.80,
  },
};
