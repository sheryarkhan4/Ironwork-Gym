const session = require("express-session");

class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires INTEGER NOT NULL
      )
    `);

    // Remove expired sessions every 15 minutes
    setInterval(function () {
      db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
    }, 15 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare("SELECT data, expires FROM sessions WHERE sid = ?").get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 8 * 60 * 60 * 1000;

      this.db.prepare(
        "INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)"
      ).run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }

  destroy(sid, cb) {
    try {
      this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }
}

module.exports = SqliteStore;