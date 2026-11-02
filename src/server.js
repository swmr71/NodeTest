const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDb(DB_FILE);
const app = createApp(db);

const server = app.listen(PORT, () => {
  console.log(`task-board 起動: http://localhost:${PORT}  (DB: ${DB_FILE})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
