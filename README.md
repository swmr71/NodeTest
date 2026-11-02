# task-board

動作確認・テスト用のタスク管理アプリ。Express 5 + SQLite (`node:sqlite`) で、ネイティブビルド不要。

## 必要環境
- Node.js 22.13 以上 (標準の `node:sqlite` を使用)

## 使い方
```bash
npm install
npm run seed     # (任意) デモデータ: demo / demo-pass-123
npm start        # http://localhost:3000
npm test         # node:test による APIテスト
```

環境変数: `PORT` (既定 3000) / `DB_FILE` (既定 `data/app.db`)

## 機能
- ユーザー登録・ログイン・ログアウト (scrypt + Bearerトークン、7日で期限切れ)
- タスクのCRUD (タイトル/説明/ステータス/優先度/期限)
- タグ (複数付与、タグ別絞り込み、件数表示)
- コメント
- 検索 (タイトル・説明)、ステータス絞り込み、並び替え、ページング
- 統計 (件数・期限切れ・完了率)
- 簡易UI (`public/index.html`、ダークモード対応)

## API
| メソッド | パス | 説明 |
|---|---|---|
| GET | /api/health | ヘルスチェック |
| POST | /api/register, /api/login | `{username, password}` → `{token, user}` |
| POST | /api/logout | ログアウト |
| GET | /api/me | ログイン中ユーザー |
| GET | /api/tasks | `status` `tag` `q` `sort` `order` `page` `limit` |
| POST | /api/tasks | 作成 |
| GET/PATCH/DELETE | /api/tasks/:id | 取得/更新/削除 |
| GET/POST | /api/tasks/:id/comments | コメント |
| GET | /api/tags | タグ一覧 |
| GET | /api/stats | 統計 |

認証が必要なAPIには `Authorization: Bearer <token>` を付けます。

## 構成
```
src/db.js      スキーマとトランザクション
src/auth.js    パスワードハッシュ・セッション・認証ミドルウェア
src/app.js     Expressアプリ (ルーティング)
src/server.js  起動
src/seed.js    デモデータ
public/        フロントUI
test/          APIテスト
```
