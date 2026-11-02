const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let server, base, db;

before(async () => {
  db = openDb(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  db.close();
});

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function newUser(name) {
  const r = await call('/register', { method: 'POST', body: { username: name, password: 'password-123' } });
  assert.equal(r.status, 201);
  return r.body.token;
}

describe('health', () => {
  test('GET /health', async () => {
    const r = await call('/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

describe('認証', () => {
  test('登録→ログイン→me→ログアウト', async () => {
    const reg = await call('/register', { method: 'POST', body: { username: 'alice', password: 'password-123' } });
    assert.equal(reg.status, 201);

    const login = await call('/login', { method: 'POST', body: { username: 'alice', password: 'password-123' } });
    assert.equal(login.status, 200);
    const token = login.body.token;

    assert.equal((await call('/me', { token })).body.username, 'alice');
    assert.equal((await call('/logout', { method: 'POST', token })).status, 204);
    assert.equal((await call('/me', { token })).status, 401);
  });

  test('重複ユーザー名は409', async () => {
    await newUser('dupuser');
    const r = await call('/register', { method: 'POST', body: { username: 'dupuser', password: 'password-123' } });
    assert.equal(r.status, 409);
  });

  test('不正な入力は400', async () => {
    assert.equal((await call('/register', { method: 'POST', body: { username: 'a', password: 'password-123' } })).status, 400);
    assert.equal((await call('/register', { method: 'POST', body: { username: 'okname', password: 'short' } })).status, 400);
  });

  test('間違ったパスワードは401', async () => {
    await newUser('bob');
    const r = await call('/login', { method: 'POST', body: { username: 'bob', password: 'wrong-password' } });
    assert.equal(r.status, 401);
  });

  test('トークン無しは401', async () => {
    assert.equal((await call('/tasks')).status, 401);
    assert.equal((await call('/tasks', { token: 'invalid' })).status, 401);
  });

  test('期限切れセッションは401', async () => {
    const token = await newUser('expired');
    db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?").run(token);
    assert.equal((await call('/me', { token })).status, 401);
  });
});

describe('タスクCRUD', () => {
  let token;
  before(async () => { token = await newUser('crud'); });

  test('作成 (デフォルト値とタグ)', async () => {
    const r = await call('/tasks', { method: 'POST', token, body: { title: '買い物', tags: ['life', 'life', ' home '] } });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'todo');
    assert.equal(r.body.priority, 2);
    assert.deepEqual(r.body.tags, ['home', 'life']);
  });

  test('作成時のバリデーション', async () => {
    assert.equal((await call('/tasks', { method: 'POST', token, body: {} })).status, 400);
    assert.equal((await call('/tasks', { method: 'POST', token, body: { title: 'x', status: 'nope' } })).status, 400);
    assert.equal((await call('/tasks', { method: 'POST', token, body: { title: 'x', priority: 9 } })).status, 400);
    assert.equal((await call('/tasks', { method: 'POST', token, body: { title: 'x', due_date: '2026/01/01' } })).status, 400);
  });

  test('取得・更新・削除', async () => {
    const created = (await call('/tasks', { method: 'POST', token, body: { title: '更新テスト' } })).body;

    const got = await call(`/tasks/${created.id}`, { token });
    assert.equal(got.body.title, '更新テスト');

    const patched = await call(`/tasks/${created.id}`, { method: 'PATCH', token, body: { status: 'doing', tags: ['x'] } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.status, 'doing');
    assert.deepEqual(patched.body.tags, ['x']);

    assert.equal((await call(`/tasks/${created.id}`, { method: 'DELETE', token })).status, 204);
    assert.equal((await call(`/tasks/${created.id}`, { token })).status, 404);
  });

  test('存在しないIDは404', async () => {
    assert.equal((await call('/tasks/99999', { token })).status, 404);
    assert.equal((await call('/tasks/99999', { method: 'PATCH', token, body: { title: 'a' } })).status, 404);
    assert.equal((await call('/tasks/99999', { method: 'DELETE', token })).status, 404);
  });

  test('他人のタスクは見えない・触れない', async () => {
    const other = await newUser('stranger');
    const mine = (await call('/tasks', { method: 'POST', token, body: { title: '秘密' } })).body;
    assert.equal((await call(`/tasks/${mine.id}`, { token: other })).status, 404);
    assert.equal((await call(`/tasks/${mine.id}`, { method: 'DELETE', token: other })).status, 404);
    assert.equal((await call(`/tasks/${mine.id}/comments`, { token: other })).status, 404);
    assert.equal((await call('/tasks', { token: other })).body.total, 0);
  });

  test('不正なJSONは400', async () => {
    const res = await fetch(base + '/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{broken',
    });
    assert.equal(res.status, 400);
  });
});

describe('一覧の検索・絞り込み・並び替え・ページング', () => {
  let token;
  before(async () => {
    token = await newUser('lister');
    const rows = [
      { title: 'Alpha', status: 'todo', priority: 3, due_date: '2026-01-03', tags: ['a'] },
      { title: 'Bravo', status: 'doing', priority: 1, due_date: '2026-01-01', tags: ['a', 'b'] },
      { title: 'Charlie', status: 'done', priority: 2, due_date: '2026-01-02', description: 'needle here', tags: ['b'] },
      { title: 'Delta', status: 'todo', priority: 2 },
    ];
    for (const body of rows) assert.equal((await call('/tasks', { method: 'POST', token, body })).status, 201);
  });

  test('statusで絞り込み', async () => {
    const r = await call('/tasks?status=todo', { token });
    assert.deepEqual(r.body.items.map((t) => t.title).sort(), ['Alpha', 'Delta']);
    assert.equal((await call('/tasks?status=bad', { token })).status, 400);
  });

  test('タグで絞り込み', async () => {
    const r = await call('/tasks?tag=b', { token });
    assert.deepEqual(r.body.items.map((t) => t.title).sort(), ['Bravo', 'Charlie']);
  });

  test('キーワード検索 (タイトル/説明)', async () => {
    assert.equal((await call('/tasks?q=needle', { token })).body.total, 1);
    assert.equal((await call('/tasks?q=ALPHA', { token })).body.total, 1);
    assert.equal((await call('/tasks?q=zzz', { token })).body.total, 0);
  });

  test('並び替え', async () => {
    const byPrio = await call('/tasks?sort=priority&order=asc', { token });
    assert.equal(byPrio.body.items[0].title, 'Bravo');
    const byTitle = await call('/tasks?sort=title&order=asc', { token });
    assert.deepEqual(byTitle.body.items.map((t) => t.title), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  test('ページング', async () => {
    const p1 = await call('/tasks?limit=3&page=1&sort=title&order=asc', { token });
    const p2 = await call('/tasks?limit=3&page=2&sort=title&order=asc', { token });
    assert.equal(p1.body.total, 4);
    assert.equal(p1.body.items.length, 3);
    assert.deepEqual(p2.body.items.map((t) => t.title), ['Delta']);
  });

  test('SQLインジェクション風の入力でも壊れない', async () => {
    const r = await call(`/tasks?q=${encodeURIComponent("'; DROP TABLE tasks; --")}&sort=${encodeURIComponent('id; DROP TABLE tasks')}`, { token });
    assert.equal(r.status, 200);
    assert.equal((await call('/tasks', { token })).body.total, 4);
  });
});

describe('コメント・タグ・統計', () => {
  let token, taskId;
  before(async () => {
    token = await newUser('misc');
    taskId = (await call('/tasks', { method: 'POST', token, body: { title: 'コメント用', tags: ['t1'] } })).body.id;
  });

  test('コメントの追加と取得、件数反映', async () => {
    assert.equal((await call(`/tasks/${taskId}/comments`, { method: 'POST', token, body: { body: '' } })).status, 400);
    assert.equal((await call(`/tasks/${taskId}/comments`, { method: 'POST', token, body: { body: 'こんにちは' } })).status, 201);
    const list = await call(`/tasks/${taskId}/comments`, { token });
    assert.equal(list.body.length, 1);
    assert.equal((await call(`/tasks/${taskId}`, { token })).body.comment_count, 1);
  });

  test('タスク削除でコメントも消える (CASCADE)', async () => {
    const id = (await call('/tasks', { method: 'POST', token, body: { title: '消えるタスク' } })).body.id;
    await call(`/tasks/${id}/comments`, { method: 'POST', token, body: { body: 'bye' } });
    await call(`/tasks/${id}`, { method: 'DELETE', token });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(id).n, 0);
  });

  test('タグ一覧に件数が出る', async () => {
    const tags = (await call('/tags', { token })).body;
    assert.deepEqual(tags.find((t) => t.name === 't1'), { name: 't1', count: 1 });
  });

  test('統計 (期限切れ・完了率)', async () => {
    const t = await newUser('statsuser');
    await call('/tasks', { method: 'POST', token: t, body: { title: 'a', due_date: '2000-01-01' } });
    await call('/tasks', { method: 'POST', token: t, body: { title: 'b', due_date: '2000-01-01', status: 'done' } });
    const s = (await call('/stats', { token: t })).body;
    assert.equal(s.total, 2);
    assert.equal(s.overdue, 1);
    assert.equal(s.doneRate, 50);
    assert.deepEqual(s.byStatus, { todo: 1, doing: 0, done: 1 });
  });
});
