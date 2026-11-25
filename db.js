const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { DATA_DIR } = require("./config");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "gym.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const columns = table => db.prepare("PRAGMA table_info(" + table + ")").all().map(c => c.name);
const tableSql = name => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row ? row.sql : null;
};

// plan is a link to the plans table. Renaming a plan updates its members,
// and a plan that still has members cannot be deleted.
function membersDdl(name) {
  return `
    CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL REFERENCES plans(name) ON UPDATE CASCADE ON DELETE RESTRICT,
      end_date TEXT NOT NULL,
      phone TEXT,
      photo BLOB,
      photo_at TEXT,
      remind INTEGER NOT NULL DEFAULT 1,
      code TEXT,
      frozen_since TEXT,
      cancelled_on TEXT,
      joined_on TEXT
    )`;
}

// Money is stored as whole paisa (integers) so there is no rounding error.
function paymentsDdl(name) {
  return `
    CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      member_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      paid_on TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'easypaisa', 'jazzcash', 'other')),
      note TEXT,
      recorded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff'))
  );

  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 730),
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    UNIQUE (member_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(date);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    user_id TEXT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
    member_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 1,
    provider TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (member_id, threshold, end_date)
  );
`);

// Default plans on a brand-new (or just-upgraded) database
if (db.prepare("SELECT COUNT(*) AS n FROM plans").get().n === 0) {
  const insert = db.prepare("INSERT INTO plans (name, price_cents, days, sort) VALUES (?, ?, ?, ?)");
  [["Basic", 300000, 30, 1], ["Standard", 500000, 30, 2], ["Premium", 800000, 30, 3]]
    .forEach(p => insert.run(...p));
}

// ---- members: create, or upgrade an older table ----
// Rebuilding with foreign keys OFF is essential: dropping the old table with them ON
// would silently delete every check-in (they cascade from members).
function rebuildMembers() {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("INSERT OR IGNORE INTO plans (name, price_cents, days, sort) " +
        "SELECT DISTINCT plan, 300000, 30, 99 FROM members WHERE plan IS NOT NULL");
      db.exec(membersDdl("members_new"));
      db.exec(
        "INSERT INTO members_new (id, name, plan, end_date, phone, photo, photo_at, remind, code, frozen_since, cancelled_on, joined_on) " +
        "SELECT id, name, plan, end_date, phone, photo, photo_at, remind, code, frozen_since, cancelled_on, joined_on FROM members"
      );
      db.exec("DROP TABLE members");
      db.exec("ALTER TABLE members_new RENAME TO members");
      if (db.prepare("PRAGMA foreign_key_check").all().length) {
        throw new Error("Foreign key check failed after rebuilding the members table");
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  console.log("Database upgraded: plans are now editable.");
}

const oldMembers = tableSql("members");
if (!oldMembers) {
  db.exec(membersDdl("members"));
} else {
  const have = columns("members");
  [
    ["phone", "TEXT"], ["photo", "BLOB"], ["photo_at", "TEXT"],
    ["remind", "INTEGER NOT NULL DEFAULT 1"], ["code", "TEXT"],
    ["frozen_since", "TEXT"], ["cancelled_on", "TEXT"], ["joined_on", "TEXT"]
  ].forEach(function (c) {
    if (!have.includes(c[0])) {
      db.exec("ALTER TABLE members ADD COLUMN " + c[0] + " " + c[1]);
      console.log("Database upgraded: members." + c[0] + " added.");
    }
  });
  if (/CHECK\s*\(\s*plan\s+IN/i.test(oldMembers)) rebuildMembers();
}

// ---- payments ----
const oldPayments = tableSql("payments");
if (!oldPayments) db.exec(paymentsDdl("payments"));
db.exec("CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON payments(paid_on)");

// SQLite cannot edit a CHECK rule in place: build a new table, copy, swap (one transaction)
if (oldPayments && !oldPayments.includes("'easypaisa'")) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(paymentsDdl("payments_new"));
    db.exec(
      "INSERT INTO payments_new (id, member_id, member_name, amount_cents, paid_on, method, note, recorded_by, created_at) " +
      "SELECT id, member_id, member_name, amount_cents, paid_on, method, note, recorded_by, created_at FROM payments"
    );
    db.exec("DROP TABLE payments");
    db.exec("ALTER TABLE payments_new RENAME TO payments");
    db.exec("CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON payments(paid_on)");
    db.exec("COMMIT");
    console.log("Database upgraded: payments now accept Easypaisa and JazzCash.");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// A walk-in visitor who bought a one-day pass (their money is a row in payments)
db.exec(`
  CREATE TABLE IF NOT EXISTS day_passes (
    id TEXT PRIMARY KEY,
    visitor_name TEXT NOT NULL,
    phone TEXT,
    visit_date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_day_passes_date ON day_passes(visit_date);
`);

if (!columns("users").includes("role")) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff'))");
  db.exec("UPDATE users SET role = 'admin'");
  console.log("Database upgraded: existing accounts are now admins.");
}

// Give every existing member a numeric member code (100001, 100002, ...)
const missingCode = db.prepare("SELECT id FROM members WHERE code IS NULL ORDER BY rowid").all();
if (missingCode.length) {
  let next = db.prepare(
    "SELECT COALESCE(MAX(CAST(code AS INTEGER)), 100000) AS n FROM members WHERE code GLOB '[0-9]*'"
  ).get().n + 1;
  const setCode = db.prepare("UPDATE members SET code = ? WHERE id = ?");
  missingCode.forEach(r => setCode.run(String(next++), r.id));
  console.log("Database upgraded: " + missingCode.length + " members received a member code.");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_members_code ON members(code)");

// Rules enforced by the database itself
db.exec(`
  CREATE TRIGGER IF NOT EXISTS members_phone_required_insert
  BEFORE INSERT ON members
  WHEN NEW.phone IS NULL OR trim(NEW.phone) = ''
  BEGIN
    SELECT RAISE(ABORT, 'phone number is required');
  END;

  CREATE TRIGGER IF NOT EXISTS members_phone_required_update
  BEFORE UPDATE OF phone ON members
  WHEN NEW.phone IS NULL OR trim(NEW.phone) = ''
  BEGIN
    SELECT RAISE(ABORT, 'phone number is required');
  END;

  CREATE TRIGGER IF NOT EXISTS members_defaults_after_insert
  AFTER INSERT ON members
  WHEN NEW.code IS NULL OR NEW.joined_on IS NULL
  BEGIN
    UPDATE members SET
      code = COALESCE(code, CAST((SELECT COALESCE(MAX(CAST(code AS INTEGER)), 100000) + 1
                                  FROM members WHERE code GLOB '[0-9]*') AS TEXT)),
      joined_on = COALESCE(joined_on, date('now', 'localtime'))
    WHERE id = NEW.id;
  END;
`);

module.exports = db;