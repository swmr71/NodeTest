const crypto = require('node:crypto');

const SESSION_HOURS = 24 * 7;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

/** Authorization: Bearer <token> を見てログイン中ユーザーを req.user にセットするミドルウェア */
function requireAuth(db) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: '認証が必要です' });

    const row = db
      .prepare(
        `SELECT u.id, u.username, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ?`
      )
      .get(match[1]);

    if (!row || new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ error: 'セッションが無効か期限切れです' });
    }
    req.user = { id: row.id, username: row.username };
    req.token = match[1];
    next();
  };
}

module.exports = { hashPassword, verifyPassword, createSession, requireAuth };
