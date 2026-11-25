const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

test("an older database keeps its members, check-ins and payments when plans become editable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gym-migrate-members-"));
  const file = path.join(dir, "gym.db");

  // A database as it was before plans could be edited
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL CHECK (plan IN ('Basic', 'Standard', 'Premium')),
      end_date TEXT NOT NULL,
      phone TEXT,
      photo BLOB,
      photo_at TEXT,
      remind INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE checkins (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      UNIQUE (member_id, date)
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      member_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      paid_on TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'easypaisa', 'jazzcash', 'other')),
      note TEXT,
      recorded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const addMember = old.prepare("INSERT INTO members (id, name, plan, end_date, phone) VALUES (?, ?, ?, ?, ?)");
  addMember.run("m1", "Old One", "Basic", "2030-01-01", "+923001111111");
  addMember.run("m2", "Old Two", "Premium", "2030-02-02", "+923002222222");
  const addCheckin = old.prepare("INSERT INTO checkins (id, member_id, date, time) VALUES (?, ?, ?, ?)");
  addCheckin.run("c1", "m1", "2026-01-01", "2026-01-01T10:00:00.000Z");
  addCheckin.run("c2", "m2", "2026-01-02", "2026-01-02T10:00:00.000Z");
  old.prepare("INSERT INTO payments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("p1", "m1", "Old One", 5000, "2026-01-01", "cash", "kept", "boss", "2026-01-01T00:00:00Z");
  old.close();

  // Starting the app's database code performs the upgrade
  execFileSync(process.execPath, ["-e", "require('./db')"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dir },
    stdio: "pipe"
  });

  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");

  const members = db.prepare("SELECT id, name, plan, code, joined_on FROM members ORDER BY id").all();
  assert.deepEqual(members.map(m => [m.id, m.name, m.plan]), [["m1", "Old One", "Basic"], ["m2", "Old Two", "Premium"]]);
  assert.ok(members.every(m => /^\d{6}$/.test(m.code)));
  assert.equal(new Set(members.map(m => m.code)).size, 2);
  assert.equal(members[0].joined_on, null); // nobody knows when old members really joined

  // Rebuilding the table must not delete the check-ins that point at it
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checkins").get().n, 2);
  assert.equal(db.prepare("SELECT member_id FROM payments WHERE id = 'p1'").get().member_id, "m1");

  assert.deepEqual(db.prepare("SELECT name FROM plans ORDER BY sort").all().map(p => p.name), ["Basic", "Standard", "Premium"]);

  // A plan is now a link to the plans table, not a fixed list
  const insert = "INSERT INTO members (id, name, plan, end_date, phone) VALUES (?, ?, ?, '2030-01-01', '+923003333333')";
  assert.throws(() => db.prepare(insert).run("m3", "Nobody", "Nope"));
  db.prepare("INSERT INTO plans (name, price_cents, days, sort) VALUES ('Student', 100000, 30, 4)").run();
  db.prepare(insert).run("m4", "New One", "Student");

  const fresh = db.prepare("SELECT code, joined_on FROM members WHERE id = 'm4'").get();
  assert.match(fresh.code, /^\d{6}$/);
  assert.ok(fresh.joined_on);

  // The phone rule still applies
  assert.throws(() => db.prepare("INSERT INTO members (id, name, plan, end_date) VALUES ('m5', 'No Phone', 'Basic', '2030-01-01')").run());

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});