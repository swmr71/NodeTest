const path = require('node:path');
const express = require('express');
const { transaction } = require('./db');
const { hashPassword, verifyPassword, createSession, requireAuth } = require('./auth');

const STATUSES = ['todo', 'doing', 'done'];

/** タスク1件にタグ・コメント数を付けて返す */
function loadTask(db, userId, taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
  if (!task) return null;
  return decorate(db, [task])[0];
}

function decorate(db, tasks) {
  if (tasks.length === 0) return tasks;
  const ids = tasks.map((t) => t.id);
  const marks = ids.map(() => '?').join(',');

  const tagRows = db
    .prepare(
      `SELECT tt.task_id, g.name FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
        WHERE tt.task_id IN (${marks}) ORDER BY g.name`
    )
    .all(...ids);
  const countRows = db
    .prepare(`SELECT task_id, COUNT(*) AS n FROM comments WHERE task_id IN (${marks}) GROUP BY task_id`)
    .all(...ids);

  const tagMap = new Map();
  for (const r of tagRows) {
    if (!tagMap.has(r.task_id)) tagMap.set(r.task_id, []);
    tagMap.get(r.task_id).push(r.name);
  }
  const countMap = new Map(countRows.map((r) => [r.task_id, r.n]));

  return tasks.map((t) => ({ ...t, tags: tagMap.get(t.id) || [], comment_count: countMap.get(t.id) || 0 }));
}

/** タグ名の配列をそのユーザーのタグに反映する (全置換) */
function setTags(db, userId, taskId, names) {
  const clean = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
  for (const name of clean) {
    db.prepare('INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)').run(userId, name);
    const tag = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?').get(userId, name);
    db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tag.id);
  }
}

function validateTaskInput(body, { partial }) {
  const errors = [];
  const out = {};

  if (body.title !== undefined || !partial) {
    if (typeof body.title !== 'string' || !body.title.trim()) errors.push('title は必須です');
    else if (body.title.length > 200) errors.push('title は200文字以内にしてください');
    else out.title = body.title.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') errors.push('description は文字列にしてください');
    else out.description = body.description;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) errors.push(`status は ${STATUSES.join('/')} のいずれかです`);
    else out.status = body.status;
  }
  if (body.priority !== undefined) {
    if (![1, 2, 3].includes(body.priority)) errors.push('priority は 1(高) 2(中) 3(低) のいずれかです');
    else out.priority = body.priority;
  }
  if (body.due_date !== undefined) {
    if (body.due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) errors.push('due_date は YYYY-MM-DD 形式です');
    else out.due_date = body.due_date;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) errors.push('tags は配列にしてください');
    else out.tags = body.tags;
  }
  return { errors, value: out };
}

function createApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const auth = requireAuth(db);

  // ---------- ヘルスチェック ----------
  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // ---------- 認証 ----------
  app.post('/api/register', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !/^[\w-]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'username は英数字/_/-で3〜20文字です' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password は8文字以上にしてください' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'そのユーザー名は使われています' });
    }
    const info = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, hashPassword(password));
    const token = createSession(db, Number(info.lastInsertRowid));
    res.status(201).json({ token, user: { id: Number(info.lastInsertRowid), username } });
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = typeof username === 'string' ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
    if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'ユーザー名かパスワードが違います' });
    }
    res.json({ token: createSession(db, user.id), user: { id: user.id, username: user.username } });
  });

  app.post('/api/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.status(204).end();
  });

  app.get('/api/me', auth, (req, res) => res.json(req.user));

  // ---------- タスク ----------
  // GET /api/tasks?status=&tag=&q=&sort=&order=&page=&limit=
  app.get('/api/tasks', auth, (req, res) => {
    const { status, tag, q } = req.query;
    const sortable = { created_at: 't.created_at', due_date: 't.due_date', priority: 't.priority', title: 't.title' };
    const sortCol = sortable[req.query.sort] || 't.created_at';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    if (status !== undefined && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status が不正です' });
    }

    const where = ['t.user_id = ?'];
    const params = [req.user.id];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (tag) {
      where.push(`EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
                          WHERE tt.task_id = t.id AND g.name = ?)`);
      params.push(tag);
    }
    const whereSql = where.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${whereSql}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT t.* FROM tasks t WHERE ${whereSql}
          ORDER BY ${sortCol} ${order}, t.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, (page - 1) * limit);

    res.json({ items: decorate(db, rows), total, page, limit });
  });

  app.post('/api/tasks', auth, (req, res) => {
    const { errors, value } = validateTaskInput(req.body || {}, { partial: false });
    if (errors.length) return res.status(400).json({ errors });

    const id = transaction(db, () => {
      const info = db
        .prepare(
          `INSERT INTO tasks (user_id, title, description, status, priority, due_date)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          req.user.id,
          value.title,
          value.description ?? '',
          value.status ?? 'todo',
          value.priority ?? 2,
          value.due_date ?? null
        );
      const taskId = Number(info.lastInsertRowid);
      if (value.tags) setTags(db, req.user.id, taskId, value.tags);
      return taskId;
    });
    res.status(201).json(loadTask(db, req.user.id, id));
  });

  app.get('/api/tasks/:id', auth, (req, res) => {
    const task = loadTask(db, req.user.id, req.params.id);
    if (!task) return res.status(404).json({ error: 'タスクが見つかりません' });
    res.json(task);
  });

  app.patch('/api/tasks/:id', auth, (req, res) => {
    const existing = db.prepare('SELECT id FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'タスクが見つかりません' });

    const { errors, value } = validateTaskInput(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ errors });

    transaction(db, () => {
      const { tags, ...fields } = value;
      const keys = Object.keys(fields);
      if (keys.length) {
        const sets = keys.map((k) => `${k} = ?`).join(', ');
        db.prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
          ...keys.map((k) => fields[k]),
          existing.id
        );
      }
      if (tags) {
        setTags(db, req.user.id, existing.id, tags);
        db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(existing.id);
      }
    });
    res.json(loadTask(db, req.user.id, existing.id));
  });

  app.delete('/api/tasks/:id', auth, (req, res) => {
    const info = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (info.changes === 0) return res.status(404).json({ error: 'タスクが見つかりません' });
    res.status(204).end();
  });

  // ---------- コメント ----------
  app.get('/api/tasks/:id/comments', auth, (req, res) => {
    if (!loadTask(db, req.user.id, req.params.id)) return res.status(404).json({ error: 'タスクが見つかりません' });
    res.json(db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(req.params.id));
  });

  app.post('/api/tasks/:id/comments', auth, (req, res) => {
    if (!loadTask(db, req.user.id, req.params.id)) return res.status(404).json({ error: 'タスクが見つかりません' });
    const body = req.body && req.body.body;
    if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body は必須です' });
    const info = db.prepare('INSERT INTO comments (task_id, body) VALUES (?, ?)').run(req.params.id, body.trim());
    res.status(201).json(db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  // ---------- タグ・統計 ----------
  app.get('/api/tags', auth, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT g.name, COUNT(tt.task_id) AS count FROM tags g
             LEFT JOIN task_tags tt ON tt.tag_id = g.id
            WHERE g.user_id = ? GROUP BY g.id ORDER BY g.name`
        )
        .all(req.user.id)
    );
  });

  app.get('/api/stats', auth, (req, res) => {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE user_id = ? GROUP BY status').all(req.user.id)) {
      byStatus[r.status] = r.n;
    }
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const today = new Date().toISOString().slice(0, 10);
    const overdue = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status != 'done' AND due_date IS NOT NULL AND due_date < ?")
      .get(req.user.id, today).n;
    res.json({ total, byStatus, overdue, doneRate: total ? Math.round((byStatus.done / total) * 100) : 0 });
  });

  // ---------- エラー処理 ----------
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSONが不正です' });
    console.error(err);
    res.status(500).json({ error: 'サーバーエラー' });
  });

  return app;
}

module.exports = { createApp };
