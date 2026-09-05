# 空き時間確認サイト（東村山LIFE整体院）

Google スプレッドシートの予約管理表を正本とし、外部には「日付・時間・○/要相談/×」だけを
表示する空き時間確認サイトです。予約機能は一切持たせていません。実際の予約は
公式LINEに誘導します。

## 全体構成

```
Googleスプレッドシート（正本）
   ↓（読み取り専用・サービスアカウント）
Express アプリ（server.js）
   ↓（○/要相談/×のみに変換したJSON）
ブラウザ（public/index.html, public/admin.html）
   ↓
公式LINEへ誘導
```

- Webサイト側にデータベースは持たない（手動○×設定のみNetlify Blobsに保存）
- スプレッドシートへの書き込みは一切行わない
- 患者名などの個人情報はサーバー内部でのみ扱い、API・HTMLには一切出力しない

## 実行環境による自動切り替え

| | ローカル（Termux等） | Netlify（本番） |
|---|---|---|
| 起動方法 | `node server.js` | Netlify Functionsが自動起動 |
| Google認証情報 | `service-account-key.json`（ファイル） | `GOOGLE_SERVICE_ACCOUNT_KEY`環境変数（JSON文字列） |
| 静的ファイル配信 | Express (`express.static`) | Netlifyが直接配信 |
| 手動○×設定の保存先 | `manual-overrides.json`（ローカルファイル） | Netlify Blobs（永続ストレージ） |

## ローカル（Termux）でのセットアップ

```bash
cp .env.example .env
# .env を編集し、GOOGLE_SHEET_NAME 等を実際の値に合わせる
# service-account-key.json をこのフォルダに配置する

npm install
node server.js
```

## Netlifyへのデプロイ

### 1. 環境変数の設定（Netlify管理画面から）

- `GOOGLE_SPREADSHEET_ID`
- `GOOGLE_SHEET_NAME`
- `GOOGLE_SERVICE_ACCOUNT_KEY` … サービスアカウントのJSONキーを1行の文字列にして貼り付け
- `ADMIN_PASSWORD`
- `LINE_URL`
- `NETLIFY_API_TOKEN` … Personal access tokenを発行して設定
- `NETLIFY_SITE_ID` … このサイトのSite ID

### 2. 手動○×設定の永続化について

Netlify Functionsは実行のたびに使い捨ての環境で動くため、通常のファイル書き込みは
次の呼び出しには残りません。そのため、手動○×設定は **Netlify Blobs**
（`@netlify/blobs`）に保存しています。また、`netlify/functions/api.js`は
V1形式のFunctionとして実装しているため、Blobsのサイト情報が自動注入されず、
`NETLIFY_API_TOKEN`と`NETLIFY_SITE_ID`を明示的に渡す必要があります。

## 動作確認

- `/api/debug/sheet` … シートが正しく読めているか確認（トラブルシューティング用）
- `/index.html` … 患者向け空き時間確認画面
- `/admin.html` … 管理者画面（パスワードは`ADMIN_PASSWORD`）

## 作っていないもの（意図的に除外）

- Web上からの予約機能・予約フォーム
- 患者情報の入力・表示・会員登録・ログイン
- オンライン決済
- WebサイトからGoogleスプレッドシートへの書き込み

## 今後の課題

- スプレッドシート取得範囲の絞り込み（現状は毎回シート全体を再取得しており速度改善の余地あり）
