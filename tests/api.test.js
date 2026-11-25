// Use a throwaway database so tests never touch your real data.
// These must be set BEFORE the app is loaded.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gym-test-"));
process.env.BCRYPT_COST = "4";
delete process.env.NODE_ENV;
delete process.env.REMINDER_PROVIDER;

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const app = require("../server");
const { localDate, addDays } = require("../lib");

const today = localDate(new Date());
const ids = {};
let server, base;

function addUser(username, password, role) {
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), username, bcrypt.hashSync(password, 4), role);
}

// A tiny HTTP client that remembers the login cookie
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

test("the API requires a login", async () => {
  const anon = makeClient();
  assert.equal((await anon("GET", "/api/members")).status, 401);
  assert.equal((await anon("GET", "/api/payments/summary")).status, 401);
  assert.equal((await anon("GET", "/api/export/members.csv")).status, 401);
});

test("login rejects a wrong password and accepts the right one", async () => {
  const c = makeClient();
  assert.equal((await c("POST", "/api/login", { username: "boss", password: "wrong" })).status, 401);
  assert.equal((await c("POST", "/api/login", { username: "nobody", password: "x" })).status, 401);
  assert.equal((await c("POST", "/api/login", { username: "boss", password: "boss-password-1" })).status, 200);
  assert.equal((await c("GET", "/api/me")).data.role, "admin");
});

test("members: validation and phone cleanup", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const good = { name: "Ana", plan: "Basic", end: addDays(today, 30), phone: "0300 1234567" };

  assert.equal((await A("POST", "/api/members", { ...good, plan: "Gold" })).status, 400);
  assert.equal((await A("POST", "/api/members", { ...good, end: "2030-02-30" })).status, 400);
  assert.equal((await A("POST", "/api/members", { ...good, name: "   " })).status, 400);
  assert.equal((await A("POST", "/api/members", { ...good, phone: "abc" })).status, 400);

  ids.ana = await newMember(A, { name: "Ana", phone: "+92 300-1234567" });
  const list = (await A("GET", "/api/members")).data;
  assert.equal(list.find(m => m.id === ids.ana).phone, "+923001234567");
});

test("staff cannot delete members, admins can", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-1");
  const id = await newMember(S, { name: "Temp" }); // staff may add members

  assert.equal((await S("DELETE", "/api/members/" + id)).status, 403);
  assert.equal((await A("DELETE", "/api/members/" + id)).status, 200);
  assert.equal((await A("DELETE", "/api/members/" + id)).status, 404);
});

test("check-ins: once per day, never for expired members", async () => {
  const S = await loginAs("desk", "desk-password-1");
  const active = await newMember(S, { name: "Gym Rat" });
  const expired = await newMember(S, { name: "Lapsed", end: "2020-01-01" });

  assert.equal((await S("POST", "/api/checkins", { memberId: active })).status, 201);
  assert.equal((await S("POST", "/api/checkins", { memberId: active })).status, 409);
  assert.equal((await S("POST", "/api/checkins", { memberId: expired })).status, 400);
});

test("renewal extends from the later of today and the end date", async () => {
  const S = await loginAs("desk", "desk-password-1");
  const early = await newMember(S, { name: "Renew Me", end: addDays(today, 10) });
  const old = await newMember(S, { name: "Old Timer", end: "2020-01-01" });

  let res = await S("POST", `/api/members/${early}/renew`, { days: 30 });
  assert.equal(res.status, 200);
  assert.equal(res.data.end, addDays(today, 40)); // end date + 30, not today + 30

  res = await S("POST", `/api/members/${old}/renew`, { days: 30 });
  assert.equal(res.data.end, addDays(today, 30)); // expired: counted from today

  assert.equal((await S("POST", `/api/members/${old}/renew`, { days: 0 })).status, 400);
  assert.equal((await S("POST", `/api/members/${old}/renew`, { days: 1.5 })).status, 400);
  assert.equal((await S("POST", `/api/members/${old}/renew`, {})).status, 400);
  ids.old = old;
});

test("a renewal with a bad payment changes nothing; a good one saves both", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const before = (await A("GET", "/api/members")).data.find(m => m.id === ids.old).end;

  let res = await A("POST", `/api/members/${ids.old}/renew`, { days: 30, payment: { amount: "abc", method: "cash" } });
  assert.equal(res.status, 400);
  res = await A("POST", `/api/members/${ids.old}/renew`, { days: 30, payment: { amount: "10", method: "bitcoin" } });
  assert.equal(res.status, 400);
  assert.equal((await A("GET", "/api/members")).data.find(m => m.id === ids.old).end, before);

  res = await A("POST", `/api/members/${ids.old}/renew`, { days: 30, payment: { amount: "45.50", method: "cash" } });
  assert.equal(res.status, 200);
  assert.equal(res.data.end, addDays(before, 30));

  const payments = (await A("GET", "/api/payments?month=" + today.slice(0, 7))).data;
  const row = payments.rows.find(p => p.memberName === "Old Timer");
  assert.equal(row.amountCents, 4550);
});

test("payments: validation, totals, summary and voiding", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-1");
  const month = today.slice(0, 7);

  assert.equal((await S("POST", "/api/payments", { memberId: ids.ana, amount: "-5", method: "cash" })).status, 400);
  assert.equal((await S("POST", "/api/payments", { memberId: ids.ana, amount: "10", method: "bitcoin" })).status, 400);
  assert.equal((await S("POST", "/api/payments", { memberId: "nope", amount: "10", method: "cash" })).status, 404);
  assert.equal((await S("GET", "/api/payments?month=2026-13")).status, 400);

  const paid = await S("POST", "/api/payments", { memberId: ids.ana, amount: "20", method: "card", paidOn: today, note: "x" });
  assert.equal(paid.status, 201);

  const list = (await S("GET", "/api/payments?month=" + month)).data;
  assert.equal(list.totalCents, 4550 + 2000);

  const summary = (await S("GET", "/api/payments/summary")).data;
  assert.equal(summary.months.length, 6);
  assert.equal(summary.thisMonthCents, 6550);

  assert.equal((await S("DELETE", "/api/payments/" + paid.data.id)).status, 403);
  assert.equal((await A("DELETE", "/api/payments/" + paid.data.id)).status, 200);
  assert.equal((await A("GET", "/api/payments/summary")).data.thisMonthCents, 4550);
});

test("payment history survives deleting the member", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const id = await newMember(A, { name: "Leaver" });
  await A("POST", "/api/payments", { memberId: id, amount: "15", method: "cash", paidOn: today });
  assert.equal((await A("DELETE", "/api/members/" + id)).status, 200);

  const rows = (await A("GET", "/api/payments?month=" + today.slice(0, 7))).data.rows;
  assert.ok(rows.some(p => p.memberName === "Leaver" && p.memberId === null));
});

test("photos: JPEG only, served to staff, removable", async () => {
  const S = await loginAs("desk", "desk-password-1");
  const id = await newMember(S, { name: "Pic" });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
  const good = "data:image/jpeg;base64," + jpeg.toString("base64");
  const url = `/api/members/${id}/photo`;

  assert.equal((await S("PUT", url, { image: "data:image/png;base64,AAAA" })).status, 400);
  assert.equal((await S("PUT", url, { image: "data:image/jpeg;base64,AAAA" })).status, 400);
  assert.equal((await S("PUT", url, { image: good })).status, 200);

  const photo = await S("GET", url);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/jpeg");

  const member = (await S("GET", "/api/members")).data.find(m => m.id === id);
  assert.ok(member.photoAt);

  assert.equal((await S("DELETE", url)).status, 200);
  assert.equal((await S("GET", url)).status, 404);
});

test("CSV export: admins only, and formulas are neutralized", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-1");
  await newMember(A, { name: '=HYPERLINK("http://example.com")' });

  const members = await A("GET", "/api/export/members.csv");
  assert.equal(members.status, 200);
  assert.match(members.headers.get("content-type"), /text\/csv/);
  assert.ok(members.data.includes("Name,Phone,Plan,End date,Status"));
  assert.ok(members.data.includes("'=HYPERLINK"));
  assert.ok(!members.data.includes('"=HYPERLINK'));

  assert.equal((await A("GET", "/api/export/payments.csv")).status, 200);
  assert.equal((await A("GET", "/api/export/checkins.csv")).status, 200);
  assert.equal((await A("GET", "/api/export/payments.csv?month=bad")).status, 400);

  assert.equal((await S("GET", "/api/export/members.csv")).status, 403);
});

test("the audit log records what happened", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const rows = (await A("GET", "/api/audit?limit=200")).data.rows;
  const actions = new Set(rows.map(r => r.action));

  for (const expected of ["login", "login.failed", "member.create", "member.renew", "payment.create", "payment.delete", "member.photo", "export"]) {
    assert.ok(actions.has(expected), "missing audit action: " + expected);
  }
});

test("changing your own password checks the old one and signs out other devices", async () => {
  const phone = await loginAs("desk", "desk-password-1");
  const laptop = await loginAs("desk", "desk-password-1");

  const change = (current, next) => phone("PUT", "/api/me/password", { currentPassword: current, newPassword: next });

  assert.equal((await change("wrong-password", "desk-password-2")).status, 400);
  assert.equal((await change("desk-password-1", "short")).status, 400);
  assert.equal((await change("desk-password-1", "desk-password-1")).status, 400);
  assert.equal((await change("desk-password-1", "desk-password-2")).status, 200);

  assert.equal((await phone("GET", "/api/me")).status, 200); // this device stays signed in
  assert.equal((await laptop("GET", "/api/me")).status, 401); // the other one is signed out

  const fresh = makeClient();
  assert.equal((await fresh("POST", "/api/login", { username: "desk", password: "desk-password-1" })).status, 401);
  assert.equal((await fresh("POST", "/api/login", { username: "desk", password: "desk-password-2" })).status, 200);
});

test("payments accept Easypaisa and JazzCash, and still refuse unknown methods", async () => {
  const S = await loginAs("desk", "desk-password-2"); // the password was changed in the test above

  for (const method of ["easypaisa", "jazzcash"]) {
    const res = await S("POST", "/api/payments", { memberId: ids.ana, amount: "100", method });
    assert.equal(res.status, 201, method);
  }
  assert.equal((await S("POST", "/api/payments", { memberId: ids.ana, amount: "100", method: "EasyPaisa" })).status, 400);
  assert.equal((await S("POST", "/api/payments", { memberId: ids.ana, amount: "100", method: "bitcoin" })).status, 400);
});

test("phone number is required and stored in international form", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const base = { name: "Phone Test", plan: "Basic", end: addDays(today, 30) };

  assert.equal((await A("POST", "/api/members", base)).status, 400);                            // missing
  assert.equal((await A("POST", "/api/members", { ...base, phone: "" })).status, 400);            // empty
  assert.equal((await A("POST", "/api/members", { ...base, phone: "12345678" })).status, 400);    // country unknown

  const ok = await A("POST", "/api/members", { ...base, phone: "0300-1234567" });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.phone, "+923001234567");

  // An edit cannot remove it either
  assert.equal((await A("PUT", "/api/members/" + ok.data.id, { ...base, phone: "" })).status, 400);

  // And the database itself refuses a member without one
  assert.throws(() =>
    db.prepare("INSERT INTO members (id, name, plan, end_date) VALUES ('x', 'x', 'Basic', '2030-01-01')").run()
  );
});

test("reminder opt-out is saved and survives an edit that omits it", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const id = await newMember(A, { name: "No Texts", remind: false });
  const edit = { name: "No Texts", plan: "Basic", end: addDays(today, 30), phone: "0300 1234567" };
  const current = async () => (await A("GET", "/api/members")).data.find(m => m.id === id).remind;

  assert.equal(await current(), 0);
  await A("PUT", "/api/members/" + id, edit);                      // says nothing about reminders
  assert.equal(await current(), 0);
  await A("PUT", "/api/members/" + id, { ...edit, remind: true });
  assert.equal(await current(), 1);
});

test("reminders: staff can read the list, only admins can run it, manual mode refuses", async () => {
  const A = await loginAs("boss", "boss-password-1");
  const S = await loginAs("desk", "desk-password-2");

  const view = await S("GET", "/api/reminders");
  assert.equal(view.status, 200);
  assert.equal(view.data.settings.automated, false);
  assert.ok(Array.isArray(view.data.due));

  assert.equal((await S("POST", "/api/reminders/run")).status, 403);
  assert.equal((await S("GET", "/api/reminders/history")).status, 403);
  assert.equal((await A("POST", "/api/reminders/run")).status, 400); // automatic sending is off
  assert.equal((await A("GET", "/api/reminders/history")).status, 200);
});