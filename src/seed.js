// デモ用データを投入する: npm run seed  (ユーザー demo / パスワード demo-pass-123)
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./db');
const { hashPassword } = require('./auth');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDb(DB_FILE);

if (db.prepare("SELECT 1 FROM users WHERE username = 'demo'").get()) {
  console.log('demo ユーザーは既にあります。スキップします。');
  process.exit(0);
}

const userId = Number(
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('demo', hashPassword('demo-pass-123')).lastInsertRowid
);

const today = new Date();
const day = (offset) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10);

const samples = [
  ['サーバーのバックアップ確認', 'PBSの結果をチェック', 'todo', 1, day(1), ['infra']],
  ['READMEを書く', '', 'doing', 2, day(3), ['docs']],
  ['テストを追加する', 'APIのテストを増やす', 'doing', 2, day(-1), ['dev', 'test']],
  ['依存パッケージの更新', '', 'todo', 3, null, ['dev']],
  ['ログの整理', '古いログを削除', 'done', 3, day(-5), ['infra']],
  ['デザイン案の作成', 'ダークモード対応', 'todo', 2, day(7), ['design']],
];

for (const [title, description, status, priority, due, tags] of samples) {
  const id = Number(
    db
      .prepare('INSERT INTO tasks (user_id, title, description, status, priority, due_date) VALUES (?,?,?,?,?,?)')
      .run(userId, title, description, status, priority, due).lastInsertRowid
  );
  for (const name of tags) {
    db.prepare('INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)').run(userId, name);
    const tag = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?').get(userId, name);
    db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(id, tag.id);
  }
}
console.log(`投入完了: demo / demo-pass-123 (${samples.length}件)`);
