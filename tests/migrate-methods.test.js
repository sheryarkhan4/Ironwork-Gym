const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

test("an old database gains Easypaisa and JazzCash and keeps its payments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gym-migrate-"));
  const file = path.join(dir, "gym.db");
 
  // A database as it was before this change
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      member_id TEXT,
      member_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      paid_on TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'other')),
      note TEXT,
      recorded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  old.prepare("INSERT INTO payments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("p1", null, "Old Payer", 5000, "2026-11-01", "cash", "kept", "boss", "2026-11-01T00:00:00Z");
  old.close();

  // Starting the app's database code performs the upgrade
  execFileSync(process.execPath, ["-e", "require('./db')"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dir },
    stdio: "pipe"
  });

  const db = new DatabaseSync(file);
  const kept = db.prepare("SELECT * FROM payments WHERE id = 'p1'").get();
  assert.equal(kept.member_name, "Old Payer");
  assert.equal(kept.amount_cents, 5000);
  assert.equal(kept.method, "cash");
  assert.equal(kept.note, "kept");

  const insert = db.prepare(
    "INSERT INTO payments (id, member_id, member_name, amount_cents, paid_on, method, recorded_by, created_at) " +
    "VALUES (?, NULL, 'X', 100, '2026-11-02', ?, 'boss', '2026-11-02T00:00:00Z')"
  );
  insert.run("p2", "easypaisa");
  insert.run("p3", "jazzcash");
  assert.throws(() => insert.run("p4", "bitcoin"));

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});