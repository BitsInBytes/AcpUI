const sqlite3 = require('sqlite3');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const dbFile = process.env.UI_DATABASE_PATH || path.join(__dirname, 'persistence.db');
const db = new sqlite3.Database(dbFile);

db.all("SELECT ui_id, acp_id, name, messages_json FROM sessions", (err, rows) => {
  if (err) {
    console.error(err);
  } else {
    console.log(JSON.stringify(rows, null, 2));
  }
  db.close();
});
