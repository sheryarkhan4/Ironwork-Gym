const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

// A throwaway database and a pretend gateway; set BEFORE loading the app code
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gym-remind-"));
process.env.REMINDER_PROVIDER = "webhook";
process.env.REMINDER_DAYS = "7,1";
process.env.GYM_NAME = "Test Gym";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const db = require("../db");
const reminders = require("../reminders");
const { localDate, addDays } = require("../lib");

const today = localDate(new Date());
const received = [];
let failing = false;
let gateway;

function addMember(name, daysAhead, options = {}) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO members (id, name, plan, end_date, phone, remind) VALUES (?, ?, 'Basic', ?, ?, ?)")
    .run(id, name, addDays(today, daysAhead), options.phone || "+923001234567", options.remind === 0 ? 0 : 1);
  return id;
}

test.before(async () => {
  gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (failing) { res.statusCode = 500; return res.end("nope"); }
      received.push(JSON.parse(body));
      res.end("ok");
    });
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  process.env.REMINDER_WEBHOOK_URL = "http://127.0.0.1:" + gateway.address().port + "/";
});

test.after(() => {
  if (gateway.closeAllConnections) gateway.closeAllConnections();
  gateway.close();
  db.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
});

test("each member who is due gets one message, and only one", async () => {
  addMember("Aisha Khan", 3);                              // inside the 7-day window
  addMember("Bilal Ahmed", 1);                             // inside the 1-day window
  addMember("Far Away", 30);                               // not due yet
  addMember("Opted Out", 2, { remind: 0 });                // asked not to be messaged
  addMember("Already Gone", -1);                           // expired: not a reminder case
  addMember("Bad Number", 2, { phone: "12345678" });       // cannot be turned into a real number

  const first = await reminders.run();
  assert.equal(first.sent, 2);
  assert.equal(first.failed, 0);
  assert.deepEqual(received.map(r => r.name).sort(), ["Aisha Khan", "Bilal Ahmed"]);

  const aisha = received.find(r => r.name === "Aisha Khan");
  assert.equal(aisha.to, "+923001234567");
  assert.match(aisha.message, /Hi Aisha/);
  assert.match(aisha.message, /in 3 days/);
  assert.match(aisha.message, /Test Gym/);

  const second = await reminders.run();
  assert.equal(second.sent, 0);
  assert.equal(received.length, 2);
});

test("renewing a member earns a fresh reminder for the new end date", async () => {
  const id = addMember("Renewer", 1);
  assert.equal((await reminders.run()).sent, 1);
  assert.equal((await reminders.run()).sent, 0);

  // Renewed, then nearly expires again: a new end date is a new reminder
  db.prepare("UPDATE members SET end_date = ? WHERE id = ?").run(addDays(today, 5), id);
  assert.equal((await reminders.run()).sent, 1);
});

test("failed sends are retried, then given up on after three attempts", async () => {
  addMember("Unlucky", 1);
  failing = true;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await reminders.run();
    assert.equal(result.failed, 1, "attempt " + attempt);
    assert.equal(result.sent, 0);
  }

  assert.equal((await reminders.run()).failed, 0); // it gave up
  failing = false;
  assert.equal((await reminders.run()).sent, 0);   // and stays given up

  const row = db.prepare("SELECT status, attempts FROM reminders WHERE member_name = 'Unlucky'").get();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 3);
});

test("manual mode refuses to send automatically", async () => {
  process.env.REMINDER_PROVIDER = "manual";
  try {
    await assert.rejects(() => reminders.run(), /off/);
  } finally {
    process.env.REMINDER_PROVIDER = "webhook";
  }
});

test("marking a member as contacted stops the automatic message", async () => {
  const id = addMember("Called Already", 5);
  const before = received.length;

  assert.ok(reminders.markSent(id, "desk"));
  assert.equal((await reminders.run()).sent, 0);
  assert.equal(received.length, before);

  const row = db.prepare("SELECT provider, status FROM reminders WHERE member_id = ?").get(id);
  assert.equal(row.provider, "manual");
  assert.equal(row.status, "sent");

  assert.equal(reminders.markSent("no-such-member", "desk"), null);
});