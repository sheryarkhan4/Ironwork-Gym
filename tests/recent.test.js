const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gym-recent-"));
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

let server, base, cookie = "";

async function request(method, url, body, useCookie = true) {
  const res = await fetch(base + url, {
    method,
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...(useCookie && cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const set = res.headers.getSetCookie();
  if (useCookie && set.length) cookie = set.map(c => c.split(";")[0]).join("; ");

  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

test.before(async () => {
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'boss', ?, 'admin')")
    .run(crypto.randomUUID(), bcrypt.hashSync("boss-password-1", 4));
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(() => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  db.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
});

test("the dashboard pages and the recent feed need a login", async () => {
  for (const page of ["/", "/members.html", "/payments.html"]) {
    const res = await request("GET", page, undefined, false);
    assert.equal(res.status, 302, page);
    assert.equal(res.headers.get("location"), "/login.html");
  }
  assert.equal((await request("GET", "/api/checkins/recent", undefined, false)).status, 401);
});

test("recent check-ins come back newest first, with names", async () => {
  const login = await request("POST", "/api/login", { username: "boss", password: "boss-password-1" });
  assert.equal(login.status, 200);

  const day = localDate(new Date());
  const end = addDays(day, 30);
  const minutesAgo = n => new Date(Date.now() - n * 60000).toISOString();

  [["Oldest", 30], ["Middle", 20], ["Newest", 10]].forEach(([name, ago]) => {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO members (id, name, plan, end_date, phone) VALUES (?, ?, 'Basic', ?, '+923001234567')")
      .run(id, name, end);
    db.prepare("INSERT INTO checkins (id, member_id, date, time) VALUES (?, ?, ?, ?)")
      .run(crypto.randomUUID(), id, day, minutesAgo(ago));
  });

  const two = await request("GET", "/api/checkins/recent?limit=2");
  assert.deepEqual(two.data.map(r => r.name), ["Newest", "Middle"]);

  assert.equal((await request("GET", "/api/checkins/recent?limit=999")).data.length, 3);
  assert.equal((await request("GET", "/api/checkins/recent?limit=abc")).data.length, 3);

  const page = await request("GET", "/members.html");
  assert.equal(page.status, 200);
});