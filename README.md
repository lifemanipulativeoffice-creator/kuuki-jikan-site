# 空き時間確認サイト（予約機能なし）

Googleスプレッドシートの予約管理表を正本とし、外部には「日付・時間・○△×」だけを
表示する空き時間確認サイトです。予約機能は一切持たせていません。実際の予約は
公式LINEに誘導します。

## 全体構成

```
Googleスプレッドシート（正本）
   ↓（読み取り専用・サービスアカウント）
Node.js / Express サーバー（server.js）
   ↓（○△×のみに変換したJSON）
ブラウザ（public/index.html, app.js）
   ↓
公式LINEへ誘導
```

- Webサイト側にデータベースは持たない
- スプレッドシートへの書き込みは一切行わない
- 個人情報（患者名・性別・注意事項の有無）はサーバー内部でのみ扱い、
  API・HTML・JavaScriptには一切出力しない

## セットアップ手順

### 1. Google Cloud側の準備

1. Google Cloud Consoleでプロジェクトを作成（既存でも可）
2. 「Google Sheets API」を有効化
3. サービスアカウントを作成し、JSONキーをダウンロード
4. 対象のスプレッドシート（`1HL7zWdpXmoY0H-3uHVLrYBwuUTckA_71moylVukp6Ig`）の
   共有設定で、サービスアカウントのメールアドレスに「閲覧者」権限を付与
   ※書き込み権限は不要（読み取り専用のため）

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を開き、以下を設定してください。

- `GOOGLE_SPREADSHEET_ID`：スプレッドシートID（設定済み）
- `GOOGLE_SHEET_NAME`：実際のシート（タブ）名
- `GOOGLE_SERVICE_ACCOUNT_KEY`：ダウンロードしたJSONキーを1行の文字列にして貼り付け
- `LINE_URL`：公式LINEの友だち追加・トークURL
- `OFFICIAL_SITE_URL`：公式ホームページURL（設定済み）
- `ADMIN_REFRESH_TOKEN`：手動キャッシュ更新用の任意のランダム文字列

`.env` は `.gitignore` に含め、絶対にGit管理しないでください。

### 3. スプレッドシートの構造に合わせる（重要）

現時点ではまだ「色分けルールが未適用」とのことですので、実際に色分けを
適用した後、`config/config.js` の `sheetLayout` を必ず実際のシートに合わせて
調整してください。

```js
sheetLayout: {
  timeHeaderRow: 1,      // 時間（10:00, 10:10...）が書かれている行
  dateColumn: 1,         // 日付が書かれている列
  dataStartRow: 2,       // 日付データが始まる行
  timeStartColumn: 2,    // 時間データが始まる列
  slotMinutes: 10,
  businessStartTime: '09:00',
  businessEndTime: '20:00',
}
```

行・列番号をコードに直書きせず、すべてこの設定ファイルに集約しているため、
将来シートの構造が変わってもここを直すだけで対応できます。

色の判定（白／グレー／ピンク／青／赤）も `config/config.js` の
`cellColors` で調整可能です。実際にセルへ色を塗った後、
一度 `/api/monthly` の結果を見て、意図通りに○△×へ変換されているか
確認することをおすすめします。

### 4. インストールと起動

```bash
npm install
npm start
```

`http://localhost:3000` で確認できます。

### 5. 本番公開について

Vercel / Render / さくらのVPS など、Node.jsが動く環境であればどこでも
デプロイ可能です。デプロイ先の環境変数設定画面で `.env` と同じ内容を
設定してください（`GOOGLE_SERVICE_ACCOUNT_KEY` は改行を含むため、
1行のJSON文字列にしてから設定します）。

## ○△×の判定基準を変えたい場合

`config/config.js` の `availabilityThresholds` を編集してください。
コード（`lib/availability.js`）は変更不要です。

```js
availabilityThresholds: {
  monthly: {
    circleMinConsecutiveMinutes: 60,   // これ以上連続で空いていれば○
    triangleMinConsecutiveMinutes: 30, // これ以上連続で空いていれば△
  },
  daily: {
    slotDisplayMinutes: 30,
    isolatedGapMaxMinutesToDowngrade: 60, // 下記「孤立した空きの格下げルール」参照
  },
}
```

### 孤立した空きの格下げルール（本日の空き情報 / 日別詳細のみ）

例えば「12:00に予約あり、13:00は予約なし、14:00に予約あり」という場合、
13:00の枠は単体では全コマ空きですが、前後を予約に挟まれているため、
○ではなく△として表示されます。

ただし、挟まれた空き区間が `isolatedGapMaxMinutesToDowngrade`（デフォルト60分）
より長い場合は、実用上十分な空きとみなし○のまま表示されます
（例：12:00に予約、13:00〜15:00の2時間が空き、15:00に予約 → ○のまま）。

営業開始・終了時刻に接している空き（前や後ろに予約が存在しない場合）は
「挟まれている」とはみなさず、通常どおり○になります。

このルールは月間カレンダー（○△×の日次判定）には適用していません。
月間側はすでに「連続空き分数」で判定しているため、孤立した短い空きは
自然と△以下になります。月間側にも同様のルールを適用したい場合はご相談ください。

## Netlifyへのデプロイ（推奨・準備済み）

Netlify上に以下のサイトを作成済みです。

- サイト名: `life-seitai-kuuki-jikan`
- 公開URL: `http://life-seitai-kuuki-jikan.netlify.app`
- 管理画面: `https://app.netlify.com/projects/life-seitai-kuuki-jikan`

以下の環境変数はすでに設定済みです（機密情報ではないもの）。

- `GOOGLE_SPREADSHEET_ID`
- `GOOGLE_SHEET_NAME`
- `LINE_URL`
- `OFFICIAL_SITE_URL`
- `CACHE_MINUTES`

### あなたが行う手順

**① 機密情報を管理画面から追加する**

上記の管理画面 →「Site configuration」→「Environment variables」で、以下の2つを追加してください（この2つだけは、セキュリティのためチャットでは扱わず、必ずご自身でNetlifyの画面から直接入力してください）。

- `GOOGLE_SERVICE_ACCOUNT_KEY`：サービスアカウントのJSONキーを1行の文字列にしたもの
- `ADMIN_REFRESH_TOKEN`：管理者用の推測されにくい任意の文字列

**② このフォルダをデプロイする**

ZIPを展開し、そのフォルダの中で以下を実行してください（Node.jsが必要です）。

```bash
npm install -g netlify-cli
netlify login
netlify link --id 26940017-a2c5-4bf6-b34e-aa4fc957b09f
netlify deploy --prod
```

初回は`netlify login`でブラウザ認証が求められます。それ以降、コードを更新するたびに
`netlify deploy --prod`を実行するだけで反映されます。

**③ 動作確認**

`http://life-seitai-kuuki-jikan.netlify.app` を開いて表示を確認し、
スマートフォンのブラウザで開いて「ホーム画面に追加」すればアプリのように使えます。

### サーバーレス特有の注意点（正直な補足）

Netlify Functionsは「必要なときだけ起動する」サーバーレス方式のため、
これまでのメモリキャッシュ（`CACHE_MINUTES`）が毎回のアクセスで
必ずしも保持されるとは限りません（起動のたびにリセットされることがあります）。
その場合、Google Sheets APIへの呼び出し回数がRenderなどの常時起動型より
やや増えますが、個人利用の頻度であればGoogleの無料枠の範囲内で問題ありません。

## キャッシュについて

`CACHE_MINUTES`（デフォルト5分）の間はGoogle Sheets APIへ再アクセスせず、
メモリ上のデータを使い回します。至急最新化したい場合は、以下を管理者権限で
呼び出すとキャッシュがクリアされます。

```bash
curl -X POST http://localhost:3000/api/admin/refresh \
  -H "x-admin-token: あなたのADMIN_REFRESH_TOKEN"
```

## 作っていないもの（意図的に除外）

- Web上からの予約機能・予約フォーム
- 患者情報の入力・表示・会員登録・ログイン
- オンライン決済
- WebサイトからGoogleスプレッドシートへの書き込み

これらはすべて仕様上、意図的に実装していません。

## 補足：実装上の判断（要確認）

- 「それ以降の予約状況はこちら」ボタンは、別ページを作らずSPA内で
  月送りを1回進める形にしています。数か月先まで見せたい場合は
  ボタンを複数回押すか、必要であれば「年月を直接指定するプルダウン」の
  追加をご検討ください（実装可能です）。
- 日付・時刻の表記ゆれ（`2026/9/1` と `2026-09-01` など）は自動で
  正規化していますが、スプレッドシート側の表記が大きく変わる場合は
  `lib/availability.js` の `normalizeDateLabel` / `normalizeTimeLabel` の
  調整が必要になる可能性があります。
