// ==========================================================
// 設定ファイル
// スプレッドシートの構造が変わっても、基本的にはこのファイルの
// 数値・文字列を変更するだけで対応できるようにしています。
// ==========================================================

require('dotenv').config();

module.exports = {
  // ---------------- Google Sheets 接続情報 ----------------
  google: {
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    sheetName: process.env.GOOGLE_SHEET_NAME || 'シート1',
    // サービスアカウントキー(JSON文字列)。.envで1行のJSONとして設定する。
    serviceAccountKeyJson: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
  },

  // ---------------- 外部リンク ----------------
  links: {
    lineUrl: process.env.LINE_URL || '',
    officialSiteUrl: process.env.OFFICIAL_SITE_URL || '',
  },

  // ---------------- サーバー設定 ----------------
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    cacheMinutes: process.env.CACHE_MINUTES ? Number(process.env.CACHE_MINUTES) : 5,
    adminRefreshToken: process.env.ADMIN_REFRESH_TOKEN || '',
  },

  // ---------------- シートのレイアウト設定 ----------------
  // ★ここが実際のスプレッドシートの行・列に合わせて変更する箇所です。
  // 「〇〇行目から始まる」のような値をコードに直書きせず、すべてここに集約しています。
  sheetLayout: {
    // 時間ヘッダー（10:00, 10:10, 10:20...）が書かれている行番号（1始まり）
    timeHeaderRow: 1,

    // 日付が書かれている列番号（1始まり。A列=1）
    dateColumn: 1,

    // データ（日付の行）が始まる行番号（1始まり）
    dataStartRow: 2,

    // 時間の列が始まる列番号（1始まり。時間ヘッダーの最初の列）
    timeStartColumn: 2,

    // 1コマの分数（10分刻み）
    slotMinutes: 10,

    // 営業開始・終了時刻（この範囲だけを判定・表示対象にする）
    businessStartTime: '09:00',
    businessEndTime: '20:00',

    // 一度に読み込む最大日数（パフォーマンスとAPI呼び出し量のバランス調整用）
    maxDaysPerFetch: 120,
  },

  // ---------------- 管理者による手動○△×設定（同一スプレッドシート内の別タブ） ----------------
  // 院長がこのタブに日付と記号を入力すると、自動計算より優先して表示される。
  // GASや別システムを追加せず、既存のスプレッドシートだけで完結させるための仕組み。
  overrideSheet: {
    // 手動設定用シート（タブ）名。存在しない場合は無視され、自動計算のみが使われる。
    sheetName: '手動設定',
    // 1行目は見出し想定。2行目からデータ。
    startRow: 2,
    dateColumn: 1,  // A列: 日付（例 2026-09-05 など。Date型セルでも可）
    statusColumn: 2, // B列: ○ / △ / × のいずれか
    memoColumn: 3,   // C列: メモ（任意。表示には使わない）
  },

  // ---------------- セル背景色の定義 ----------------
  // Google Sheets APIが返す色は 0〜1 の小数(RGB)。
  // 実際の色と多少の誤差が出るため、tolerance（許容誤差）で判定する。
  cellColors: {
    tolerance: 0.08,
    // 白＝空き
    white: { red: 1, green: 1, blue: 1 },
    // グレー＝私用封鎖
    gray: { red: 0.85, green: 0.85, blue: 0.85 },
    // ピンク＝女性患者予約済み
    pink: { red: 0.96, green: 0.8, blue: 0.86 },
    // 青＝男性患者予約済み
    blue: { red: 0.78, green: 0.86, blue: 0.97 },
    // 赤＝注意事項のある患者予約済み
    red: { red: 0.96, green: 0.6, blue: 0.6 },
  },

  // ---------------- ○△×判定ロジックの基準値 ----------------
  // ここを変更するだけで判定の厳しさを調整できる（コードのロジック自体は変更不要）。
  availabilityThresholds: {
    // 月間カレンダー（日単位）の判定
    monthly: {
      // 連続してこの分数以上空いていれば「○」の条件を満たす
      circleMinConsecutiveMinutes: 60,
      // 連続してこの分数以上空いていれば「△」の条件を満たす（○の条件を満たさない場合）
      triangleMinConsecutiveMinutes: 30,
    },
    // 本日・日別の30分刻み判定
    daily: {
      slotDisplayMinutes: 30, // 外部表示の単位（30分刻み）
      // slotDisplayMinutes ÷ slotMinutes 個の内部コマのうち、
      // 何個以上空いていれば ○ / △ とするか
      // （デフォルト: 全部空き=○, 全部埋まり=×, それ以外=△）

      // 【孤立した空きの格下げルール】
      // 例）12:00予約あり／13:00予約なし／14:00予約ありの場合、
      // 13:00の枠は単体では全コマ空きだが、前後を予約に挟まれているため
      // ○ではなく△として表示する。
      // この値（分）以下の「前後を予約に挟まれた空き区間」だけを△に格下げする。
      // これより長い空き区間は、前後に予約があっても実用上十分とみなし○のままにする。
      isolatedGapMaxMinutesToDowngrade: 60,
    },
  },
};
