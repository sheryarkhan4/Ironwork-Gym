// A throwaway database, so these tests never touch your real data.
// These must be set BEFORE the app is loaded.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gym-features-"));
process.env.BCRYPT_COST = "4";
delete process.env.NODE_ENV;
delete process.env.REMINDER_PROVIDER;
delete process.env.GYM_NAME;

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const app = require("../server");
const { localDate, addDays } = require("../lib");

const today = localDate(new Date());
let server, base;

function addUser(username, password, role) {
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), username, bcrypt.hashSync(password, 4), role);
}

function makeClient() {
  let cookie = "";
  return async function request(method, url, body) {
    const res = await fetch(base + url, {
      method,
      redirect: "manual",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map(c => c.split(";")[0]).join("; ");

    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

async function loginAs(username, password) {
  const client = makeClient();
  const res = await client("POST", "/api/login", { username, password });
  assert.equal(res.status, 200, "login as " + username);
  return client;
}

async function newMember(client, fields) {
  const res = await client("POST", "/api/members", {
    plan: "Basic", end: addDays(today, 30), phone: "0300 1234567", ...fields
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.id;
}

// Direct inserts, for facts the API cannot create (a join date in the past, an old check-in)
function insertMember(f) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO members (id, name, plan, end_date, phone, joined_on, frozen_since) " +
    "VALUES (?, ?, 'Basic', ?, '+923001234567', ?, ?)"
  ).run(id, f.name, f.end, f.joined, f.frozen || null);
  return id;
}

function insertCheckin(memberId, date, iso) {
  db.prepare("INSERT INTO checkins (id, member_id, date, time) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), memberId, date, iso);
}

const memberCount = () => db.prepare("SELECT COUNT(*) AS n FROM members").get().n;

test.before(async () => {
  addUser("boss", "boss-password-1", "admin");
  addUser("desk", "desk-password-1", "staff");
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(() => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  db.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
});

test("every new page exists, needs a login, and the admin ones need an admin", async () => {
  const anon = makeClient();
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-1");
  const open = ["/checkin.html", "/member.html", "/cards.html", "/receipt.html", "/reports.html"];
  const adminOnly = ["/settings.html", "/import.html"];

  for (const page of [...open, ...adminOnly]) {
    const res = await anon("GET", page);
    assert.equal(res.status, 302, page);
    assert.equal(res.headers.get("location"), "/login.html", page);

    assert.equal((await A("GET", page)).status, 200, page + " (a missing file shows up here)");
  }
  for (const page of open) assert.equal((await S("GET", page)).status, 200, page);
  for (const page of adminOnly) {
    const res = await S("GET", page);
    assert.equal(res.status, 302, page);
    assert.equal(res.headers.get("location"), "/", page);
  }
});

test("plans: staff can read, admins manage, renames follow members, plans in use stay", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-1");

  const list = (await S("GET", "/api/plans")).data;
  assert.deepEqual(list.map(p => p.name), ["Basic", "Standard", "Premium"]);
  assert.equal(list[0].priceCents, 300000);

  assert.equal((await S("POST", "/api/plans", { name: "X", price: "100", days: 30 })).status, 403);
  assert.equal((await A("POST", "/api/plans", { name: "", price: "100", days: 30 })).status, 400);
  assert.equal((await A("POST", "/api/plans", { name: "Student", price: "abc", days: 30 })).status, 400);
  assert.equal((await A("POST", "/api/plans", { name: "Student", price: "2000", days: 0 })).status, 400);

  const created = await A("POST", "/api/plans", { name: "Student", price: "2000", days: 30 });
  assert.equal(created.status, 201);
  assert.equal((await A("POST", "/api/plans", { name: "student", price: "1", days: 1 })).status, 409); // capitals do not matter

  const memberId = await newMember(A, { name: "Plan Tester", plan: "Student" });
  const planUrl = "/api/plans/" + created.data.id;
  assert.equal((await A("DELETE", planUrl)).status, 409); // still has a member

  assert.equal((await A("PUT", planUrl, { name: "Students", price: "2500", days: 45 })).status, 200);
  assert.equal((await A("GET", "/api/members")).data.find(m => m.id === memberId).plan, "Students");

  const ghost = { name: "Ghost", plan: "Nope", end: addDays(today, 30), phone: "0300 1234567" };
  assert.equal((await A("POST", "/api/members", ghost)).status, 400);

  await A("PUT", "/api/members/" + memberId, { name: "Plan Tester", plan: "Basic", end: addDays(today, 30), phone: "0300 1234567" });
  assert.equal((await A("DELETE", planUrl)).status, 200);
});

test("settings: everyone can read them, only admins change them", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-1");

  assert.equal((await S("GET", "/api/settings")).data.gymName, "IronWorks Gym");
  assert.equal((await S("PUT", "/api/settings", { gymName: "Nope" })).status, 403);
  assert.equal((await A("PUT", "/api/settings", { gymName: "" })).status, 400);
  assert.equal((await A("PUT", "/api/settings", { dayPassPrice: "abc" })).status, 400);
  assert.equal((await A("PUT", "/api/settings", { inactiveDays: 0 })).status, 400);

  const saved = await A("PUT", "/api/settings", { gymName: "Test Gym", dayPassPrice: "750", inactiveDays: 10 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data, { gymName: "Test Gym", dayPassCents: 75000, inactiveDays: 10 });
});

test("freezing adds the frozen days back; cancelled members can be reactivated by renewing", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const id = await newMember(A, { name: "Freezer", end: addDays(today, 30) });
  const url = "/api/members/" + id;

  assert.equal((await A("POST", url + "/freeze")).status, 200);
  assert.equal((await A("POST", url + "/freeze")).status, 400);                        // already frozen
  assert.equal((await A("POST", "/api/checkins", { memberId: id })).status, 400);       // frozen members cannot check in
  assert.equal((await A("POST", url + "/renew", { days: 30 })).status, 400);            // unfreeze first

  db.prepare("UPDATE members SET frozen_since = ? WHERE id = ?").run(addDays(today, -5), id);
  const thaw = await A("POST", url + "/unfreeze");
  assert.equal(thaw.status, 200);
  assert.equal(thaw.data.daysAdded, 5);
  assert.equal(thaw.data.end, addDays(today, 35));
  assert.equal((await A("POST", url + "/unfreeze")).status, 400);                       // no longer frozen

  assert.equal((await A("POST", url + "/cancel")).status, 200);
  assert.equal((await A("POST", url + "/cancel")).status, 400);
  assert.equal((await A("POST", "/api/checkins", { memberId: id })).status, 400);
  assert.equal((await A("POST", url + "/freeze")).status, 400);
  assert.equal((await A("GET", url + "/profile")).data.member.status, "Cancelled");

  const renewed = await A("POST", url + "/renew", { days: 30 });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.data.end, addDays(today, 65));
  assert.equal((await A("GET", url + "/profile")).data.member.status, "Active");
});

test("check in by member code (what a barcode scanner sends)", async () => {
  const S = await loginAs("desk", "desk-password-1");
  const id = await newMember(S, { name: "Scanner" });
  const code = (await S("GET", "/api/members")).data.find(m => m.id === id).code;
  assert.match(code, /^\d{6,}$/);

  assert.equal((await S("POST", "/api/checkins/by-code", { code: "abc" })).status, 400);
  assert.equal((await S("POST", "/api/checkins/by-code", { code: "999999999" })).status, 404);

  const ok = await S("POST", "/api/checkins/by-code", { code });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.name, "Scanner");
  assert.equal((await S("POST", "/api/checkins/by-code", { code })).status, 409);

  const todays = (await S("GET", "/api/checkins/today")).data;
  assert.ok(todays.checkins.some(c => c.name === "Scanner"));
});

test("day passes use the settings price, create a payment, and voiding removes them", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-1");
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM day_passes").get().n;
  const before = count();

  assert.equal((await S("POST", "/api/daypasses", { name: "", method: "cash" })).status, 400);
  assert.equal((await S("POST", "/api/daypasses", { name: "Visitor", method: "bitcoin" })).status, 400);
  assert.equal((await S("POST", "/api/daypasses", { name: "Visitor", method: "cash", phone: "abc" })).status, 400);
  assert.equal(count(), before);

  const sold = await S("POST", "/api/daypasses", { name: "Walk In", method: "easypaisa", phone: "0300 7654321" });
  assert.equal(sold.status, 201);
  assert.equal(sold.data.amountCents, 75000); // the price saved in settings

  const receipt = await S("GET", "/api/payments/" + sold.data.paymentId);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.data.memberName, "Walk In");
  assert.equal(receipt.data.note, "Day pass");
  assert.equal(receipt.data.amountCents, 75000);
  assert.equal(receipt.data.gymName, "Test Gym");
  assert.match(receipt.data.receiptNo, /^RC-[0-9A-F]{8}$/);

  assert.ok((await S("GET", "/api/checkins/today")).data.dayPasses.some(p => p.name === "Walk In"));
  assert.equal(count(), before + 1);

  assert.equal((await S("DELETE", "/api/payments/" + sold.data.paymentId)).status, 403);
  assert.equal((await A("DELETE", "/api/payments/" + sold.data.paymentId)).status, 200);
  assert.equal(count(), before);
  assert.equal((await S("GET", "/api/payments/" + sold.data.paymentId)).status, 404);
});

test("a member profile gathers visits and payments", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const id = await newMember(A, { name: "Profile Person" });
  await A("POST", "/api/checkins", { memberId: id });
  await A("POST", "/api/payments", { memberId: id, amount: "1200.50", method: "jazzcash" });

  const p = (await A("GET", `/api/members/${id}/profile`)).data;
  assert.equal(p.member.name, "Profile Person");
  assert.equal(p.member.lastVisit, today);
  assert.equal(p.stats.totalVisits, 1);
  assert.equal(p.stats.visitsLast30, 1);
  assert.equal(p.stats.totalPaidCents, 120050);
  assert.equal(p.payments.length, 1);
  assert.equal(p.checkins.length, 1);
  assert.equal((await A("GET", "/api/members/nope/profile")).status, 404);
});

test("reports: the monthly summary adds up", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const month = today.slice(0, 7);
  const payer = await newMember(A, { name: "Report Payer" });
  await A("POST", "/api/payments", { memberId: payer, amount: "500", method: "cash" });
  await A("POST", "/api/daypasses", { name: "Report Visitor", method: "cash" });

  const res = await A("GET", "/api/reports/month");
  assert.equal(res.status, 200);
  const r = res.data;
  assert.equal(r.month, month);

  const expected = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE substr(paid_on, 1, 7) = ?"
  ).get(month).n;
  assert.equal(r.revenueCents, expected);
  assert.ok(r.revenueCents > 0);
  assert.equal(r.byMethod.reduce((sum, m) => sum + m.total, 0), r.revenueCents);
  assert.equal(r.byPlan.reduce((sum, p) => sum + p.total, 0), r.revenueCents);
  assert.ok(r.byPlan.some(p => p.plan === "Day pass"));
  assert.ok(r.dayPasses >= 1);
  assert.ok(r.renewals >= 1);

  const [y, m] = month.split("-").map(Number);
  assert.equal(r.daily.length, new Date(y, m, 0).getDate());
  assert.equal(r.checkins.total, r.daily.reduce((sum, d) => sum + d.count, 0));
  assert.equal(r.newMembers, db.prepare("SELECT COUNT(*) AS n FROM members WHERE substr(joined_on, 1, 7) = ?").get(month).n);

  assert.equal((await A("GET", "/api/reports/month?month=2026-13")).status, 400);
});

test("reports: the heatmap counts check-ins by weekday and hour", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const id = insertMember({ name: "Evening Lifter", end: addDays(today, 30), joined: today });
  const when = new Date();
  when.setHours(18, 30, 0, 0);
  insertCheckin(id, today, when.toISOString());

  const res = await A("GET", "/api/reports/heatmap?days=30");
  assert.equal(res.status, 200);
  assert.equal(res.data.matrix.length, 7);
  assert.ok(res.data.matrix.every(row => row.length === 24));
  assert.ok(res.data.matrix[when.getDay()][18] >= 1);

  assert.equal(res.data.matrix.flat().reduce((a, b) => a + b, 0), res.data.total);
  assert.equal(res.data.total, db.prepare("SELECT COUNT(*) AS n FROM checkins WHERE date >= ?").get(addDays(today, -29)).n);
  assert.ok(res.data.peaks.length <= 3);
});

test("reports: members who stopped coming", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const longAgo = addDays(today, -60);

  const quiet = insertMember({ name: "Quiet Old", end: addDays(today, 30), joined: longAgo });
  insertCheckin(quiet, addDays(today, -30), new Date(Date.now() - 30 * 86400000).toISOString());
  insertMember({ name: "Never Came", end: addDays(today, 30), joined: addDays(today, -40) });
  insertMember({ name: "Just Joined", end: addDays(today, 30), joined: today });
  const regular = insertMember({ name: "Regular Joe", end: addDays(today, 30), joined: longAgo });
  insertCheckin(regular, today, new Date().toISOString());
  insertMember({ name: "Frozen Quiet", end: addDays(today, 30), joined: longAgo, frozen: addDays(today, -3) });
  insertMember({ name: "Expired Quiet", end: addDays(today, -5), joined: longAgo });

  const res = await A("GET", "/api/reports/inactive?days=14");
  assert.equal(res.status, 200);
  const names = res.data.rows.map(r => r.name);

  assert.ok(names.includes("Quiet Old"));
  assert.ok(names.includes("Never Came"));
  for (const n of ["Just Joined", "Regular Joe", "Frozen Quiet", "Expired Quiet"]) {
    assert.ok(!names.includes(n), n + " should not be listed");
  }
  assert.equal(res.data.rows.find(r => r.name === "Quiet Old").daysSince, 30);
  assert.equal(res.data.rows.find(r => r.name === "Never Came").daysSince, null);
});

const CSV = [
  "Name,Phone,Plan,End date",
  "Ali Khan,0300 1111111,Basic,31/12/2030",
  "Sara Malik,03002222222,standard,2031-01-15",
  ",0300 3333333,Basic,2030-01-01",
  "Bad Phone,12345678,Basic,2030-01-01",
  "Bad Plan,0300 4444444,Gold,2030-01-01",
  "Bad Date,0300 5555555,Basic,31/02/2030",
  "Defaulted,0300 6666666,Premium,",
  "Ali Khan,0300 1111111,Basic,31/12/2030"
].join("\r\n");

test("import: the preview checks every row, and only the good ones are saved", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const before = memberCount();

  const preview = await A("POST", "/api/import/members", { csv: CSV });
  assert.equal(preview.status, 200);
  assert.deepEqual(
    [preview.data.total, preview.data.ok, preview.data.duplicates, preview.data.errors],
    [8, 3, 1, 4]
  );

  const line = n => preview.data.rows.find(r => r.line === n);
  assert.equal(line(2).status, "ok");
  assert.equal(line(2).phone, "+923001111111");
  assert.equal(line(2).end, "2030-12-31");
  assert.equal(line(3).plan, "Standard");     // capitals do not matter
  assert.equal(line(4).status, "error");      // no name
  assert.equal(line(5).status, "error");      // phone without a country
  assert.equal(line(6).status, "error");      // unknown plan
  assert.equal(line(7).status, "error");      // impossible date
  assert.equal(line(8).status, "ok");         // empty end date is allowed
  assert.equal(line(9).status, "duplicate");  // same name and phone as line 2
  assert.equal(memberCount(), before);        // a preview saves nothing

  const commit = await A("POST", "/api/import/members", { csv: CSV, commit: true });
  assert.equal(commit.data.imported, 3);
  assert.equal(memberCount(), before + 3);

  const ali = db.prepare("SELECT * FROM members WHERE name = 'Ali Khan'").get();
  assert.equal(ali.plan, "Basic");
  assert.equal(ali.end_date, "2030-12-31");
  assert.equal(ali.phone, "+923001111111");
  assert.equal(ali.remind, 1);
  assert.ok(ali.code);
  assert.equal(ali.joined_on, today);
  assert.equal(db.prepare("SELECT end_date FROM members WHERE name = 'Defaulted'").get().end_date, addDays(today, 30));

  const again = await A("POST", "/api/import/members", { csv: CSV, commit: true });
  assert.equal(again.data.imported, 0); // importing the same file twice adds nothing
  assert.equal(memberCount(), before + 3);

  const audit = (await A("GET", "/api/audit?limit=50&action=members.import")).data.rows;
  assert.ok(audit.length >= 1);
});

test("import: admins only, and the file has to make sense", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-1");

  assert.equal((await S("POST", "/api/import/members", { csv: CSV })).status, 403);
  assert.equal((await A("POST", "/api/import/members", {})).status, 400);
  assert.equal((await A("POST", "/api/import/members", { csv: "Name,Phone\nA,0300 1234567" })).status, 400); // no Plan column
  assert.equal((await A("POST", "/api/import/members", { csv: "Name,Phone,Plan" })).status, 400);            // header only

  const template = await A("GET", "/api/import/template.csv");
  assert.equal(template.status, 200);
  assert.ok(template.data.includes("Name,Phone,Plan,End date"));

  // Excel in some regions saves with semicolons
  const semicolons = await A("POST", "/api/import/members", { csv: "Name;Phone;Plan\nOmar Semi;0300 9999999;Basic" });
  assert.equal(semicolons.data.ok, 1);
});

test("reminders skip frozen members", async () => {
  const A = await loginAs("boss", "boss-password-1");
  await newMember(A, { name: "Due Soon", end: addDays(today, 2) });
  const frozen = await newMember(A, { name: "Frozen Soon", end: addDays(today, 2) });
  assert.equal((await A("POST", `/api/members/${frozen}/freeze`)).status, 200);

  const due = (await A("GET", "/api/reminders")).data.due.map(d => d.name);
  assert.ok(due.includes("Due Soon"));
  assert.ok(!due.includes("Frozen Soon"));
});

test("the member export includes codes, and only admins can download it", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-1");

  const csv = await A("GET", "/api/export/members.csv");
  assert.equal(csv.status, 200);
  assert.ok(csv.data.includes("Name,Phone,Plan,End date,Status,Member code"));
  assert.equal((await S("GET", "/api/export/members.csv")).status, 403);
});