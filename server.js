const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PORT, HOST, IS_PROD, DATA_DIR, BCRYPT_COST, DEFAULT_COUNTRY_CODE } = require("./config");
const db = require("./db");
const SqliteStore = require("./session-store");
const reminders = require("./reminders");
const appSettings = require("./settings");
const {
  localDate, isValidDate, addDays, daysBetween, toCents, formatMoney, normalizePhone, toE164,
  toCsv, parseJpegDataUrl, METHODS, METHOD_LABELS, memberStatus, parseCsv, parseImportDate,
  mapImportHeader, receiptNumber, PLAN_NAME_RE
} = require("./lib");

const app = express();
const PUBLIC_DIR = path.join(__dirname, "public");
const ROLES = ["admin", "staff"];
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PHOTO_MAX_BYTES = 100 * 1024;
const IMPORT_MAX_ROWS = 2000;

if (IS_PROD) app.set("trust proxy", 1);

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  const file = path.join(DATA_DIR, ".session-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();

  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "upgrade-insecure-requests": IS_PROD ? [] : null
    }
  },
  strictTransportSecurity: IS_PROD ? { maxAge: 15552000, includeSubDomains: false } : false
}));

// The import route gets a bigger limit; it must come BEFORE the general parser
app.use("/api/import", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "200kb" }));

app.use(session({
  name: "gym.sid",
  secret: loadSecret(),
  store: new SqliteStore(db),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: IS_PROD, maxAge: 8 * 60 * 60 * 1000 }
}));

// ---- Helpers ----
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function findPlan(name) {
  if (typeof name !== "string") return undefined;
  return db.prepare("SELECT id, name, price_cents, days FROM plans WHERE name = ?").get(name.trim());
}

function parseMember(body) {
  const { name, end } = body || {};

  if (typeof name !== "string" || !name.trim()) return { error: "Name is required" };
  if (name.trim().length > 100) return { error: "Name is too long" };

  const plan = findPlan((body || {}).plan);
  if (!plan) return { error: "Invalid plan" };
  if (!isValidDate(end)) return { error: "A valid end date is required" };

  const phone = normalizePhone((body || {}).phone);
  if (phone.error) return { error: phone.error };
  if (phone.value === null) return { error: "Phone number is required" };

  const international = toE164(phone.value, DEFAULT_COUNTRY_CODE);
  if (!international) return { error: "Enter a phone number like 0300 1234567 or +92 300 1234567" };

  // null means "not mentioned": new members default to on, an edit keeps the current choice
  const remind = typeof (body || {}).remind === "boolean" ? (body.remind ? 1 : 0) : null;

  return { data: { name: name.trim(), plan: plan.name, end, phone: international, remind } };
}

function validatePassword(password) {
  if (typeof password !== "string") return "Password is required";
  if (password.length < 8) return "Password must be at least 8 characters";
  if (Buffer.byteLength(password, "utf8") > 72) return "Password is too long (72 bytes at most)";
  return null;
}

function insertPayment(member, cents, paidOn, method, note, username) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO payments (id, member_id, member_name, amount_cents, paid_on, method, note, recorded_by, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, member.id, member.name, cents, paidOn, method, note, username, new Date().toISOString());
  return id;
}

const MEMBER_SQL =
  "SELECT m.id, m.name, m.plan, m.end_date, m.phone, m.remind, m.photo_at, m.code, " +
  "m.frozen_since, m.cancelled_on, m.joined_on, " +
  "(SELECT MAX(c.date) FROM checkins c WHERE c.member_id = m.id) AS last_visit FROM members m";

function memberJson(r, today) {
  return {
    id: r.id, name: r.name, plan: r.plan, end: r.end_date, phone: r.phone, remind: r.remind,
    photoAt: r.photo_at, code: r.code, frozenSince: r.frozen_since, cancelledOn: r.cancelled_on,
    joinedOn: r.joined_on, lastVisit: r.last_visit, status: memberStatus(r, today)
  };
}

// ---- Audit log ----
const insertAudit = db.prepare(
  "INSERT INTO audit_log (time, user_id, username, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)"
);

function audit(req, action, info) {
  info = info || {};
  const actor = info.actor || req.user || { id: null, username: "-" };

  try {
    insertAudit.run(
      new Date().toISOString(), actor.id, actor.username, action,
      info.target || null, info.details || null, req.ip || null
    );
  } catch (err) {
    console.error("Audit write failed:", err.message);
  }
}

// ---- Authentication and authorization ----
function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(req.session.userId) || null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in" });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins can do this" });
  next();
}

function destroyUserSessions(userId, keepSid) {
  db.prepare("DELETE FROM sessions WHERE data LIKE ? AND sid != ?")
    .run('%"userId":"' + userId + '"%', keepSid || "");
}

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const attempts = new Map();
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_COST);

function recordFailure(key) {
  const record = attempts.get(key) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  const locked = record.count >= MAX_ATTEMPTS;
  if (locked) {
    record.lockedUntil = Date.now() + LOCK_MS;
    record.count = 0;
  }
  attempts.set(key, record);
  return locked;
}

function isLocked(key) {
  const record = attempts.get(key);
  return !!record && record.lockedUntil > Date.now();
}

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const name = username.trim().toLowerCase();
  const key = req.ip + "|" + name;

  if (isLocked(key)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }

  const user = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(name);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !ok) {
    const actor = { id: null, username: name.slice(0, 50) || "-" };
    audit(req, "login.failed", { actor, details: "wrong username or password" });
    if (recordFailure(key)) audit(req, "login.locked", { actor, details: "locked for 15 minutes" });
    return res.status(401).json({ error: "Invalid username or password" });
  }

  attempts.delete(key);

  req.session.regenerate(function (err) {
    if (err) return res.status(500).json({ error: "Could not start session" });

    req.session.userId = user.id;
    audit(req, "login", { actor: { id: user.id, username: user.username } });
    res.json({ username: user.username });
  });
});

app.post("/api/logout", (req, res) => {
  const user = currentUser(req);
  if (user) audit(req, "logout", { actor: user });

  req.session.destroy(function () {
    res.clearCookie("gym.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
});

app.put("/api/me/password", requireAuth, async (req, res, next) => {
  const { currentPassword, newPassword } = req.body || {};

  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return res.status(400).json({ error: "Current and new password are required" });
  }

  const key = "pw|" + req.user.id;
  if (isLocked(key)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: "The new password must be different" });
  }

  try {
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
    const ok = await bcrypt.compare(currentPassword, row.password_hash);

    // 400, not 401: the page treats every 401 as "log in again"
    if (!ok) {
      audit(req, "user.password.failed", { details: "wrong current password" });
      recordFailure(key);
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, req.user.id);
    attempts.delete(key);

    destroyUserSessions(req.user.id, req.sessionID);
    audit(req, "user.password.self", { details: "changed own password" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Pages ----
function sendPage(file, adminOnly) {
  return function (req, res) {
    const user = currentUser(req);
    if (!user) return res.redirect("/login.html");
    if (adminOnly && user.role !== "admin") return res.redirect("/");
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}

app.get(["/", "/index.html"], sendPage("index.html", false));
["members", "member", "checkin", "cards", "payments", "receipt", "reminders", "reports", "account"]
  .forEach(p => app.get("/" + p + ".html", sendPage(p + ".html", false)));
["users", "audit", "settings", "import"]
  .forEach(p => app.get("/" + p + ".html", sendPage(p + ".html", true)));

app.get("/login.html", (req, res) => {
  if (currentUser(req)) return res.redirect("/");
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

app.use("/vendor/chart.js", express.static(path.join(__dirname, "node_modules", "chart.js", "dist")));
app.use(express.static(PUBLIC_DIR, { index: false }));

// ---- Protect the data routes ----
["members", "checkins", "payments", "reminders", "plans", "settings", "reports", "daypasses"]
  .forEach(p => app.use("/api/" + p, requireAuth));
["export", "users", "audit", "import"]
  .forEach(p => app.use("/api/" + p, requireAuth, requireAdmin));

// ---- Plans and settings ----
app.get("/api/plans", (req, res) => {
  res.json(db.prepare(
    "SELECT p.id, p.name, p.price_cents AS priceCents, p.days, " +
    "(SELECT COUNT(*) FROM members m WHERE m.plan = p.name) AS members " +
    "FROM plans p ORDER BY p.sort, p.id"
  ).all());
});

function parsePlan(body) {
  const { name, price, days } = body || {};
  if (typeof name !== "string" || !PLAN_NAME_RE.test(name.trim())) {
    return { error: "Plan name: 1-30 letters, numbers or simple punctuation" };
  }
  const cents = toCents(price);
  if (!cents) return { error: "Enter a valid price" };
  if (!Number.isInteger(days) || days < 1 || days > 730) {
    return { error: "Days must be a whole number from 1 to 730" };
  }
  return { data: { name: name.trim(), cents, days } };
}

app.post("/api/plans", requireAdmin, (req, res, next) => {
  const parsed = parsePlan(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const p = parsed.data;
  try {
    const sort = db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM plans").get().n;
    const result = db.prepare("INSERT INTO plans (name, price_cents, days, sort) VALUES (?, ?, ?, ?)")
      .run(p.name, p.cents, p.days, sort);
    audit(req, "plan.create", { target: p.name, details: formatMoney(p.cents) + " for " + p.days + " days" });
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "A plan with that name already exists" });
    next(err);
  }
});

app.put("/api/plans/:id", requireAdmin, (req, res, next) => {
  const parsed = parsePlan(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const p = parsed.data;
  const before = db.prepare("SELECT name FROM plans WHERE id = ?").get(req.params.id);
  if (!before) return res.status(404).json({ error: "Plan not found" });

  try {
    // Members on this plan follow a rename automatically (ON UPDATE CASCADE)
    db.prepare("UPDATE plans SET name = ?, price_cents = ?, days = ? WHERE id = ?")
      .run(p.name, p.cents, p.days, req.params.id);
    audit(req, "plan.update", {
      target: p.name,
      details: (before.name !== p.name ? before.name + " -> " + p.name + "; " : "") + formatMoney(p.cents) + " for " + p.days + " days"
    });
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "A plan with that name already exists" });
    next(err);
  }
});

app.delete("/api/plans/:id", requireAdmin, (req, res) => {
  const plan = db.prepare("SELECT id, name FROM plans WHERE id = ?").get(req.params.id);
  if (!plan) return res.status(404).json({ error: "Plan not found" });

  const inUse = db.prepare("SELECT COUNT(*) AS n FROM members WHERE plan = ?").get(plan.name).n;
  if (inUse) {
    return res.status(409).json({ error: inUse + " member(s) are on this plan. Move them to another plan first." });
  }
  if (db.prepare("SELECT COUNT(*) AS n FROM plans").get().n <= 1) {
    return res.status(400).json({ error: "You need at least one plan" });
  }

  db.prepare("DELETE FROM plans WHERE id = ?").run(plan.id);
  audit(req, "plan.delete", { target: plan.name });
  res.json({ deleted: plan.id });
});

app.get("/api/settings", (req, res) => res.json(appSettings.all()));

app.put("/api/settings", requireAdmin, (req, res) => {
  const v = appSettings.validate(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  appSettings.update(v.values);
  audit(req, "settings.update", { details: Object.keys(v.values).join(", ") });
  res.json(appSettings.all());
});

// ---- Members ----
app.get("/api/members", (req, res) => {
  const today = localDate(new Date());
  res.json(db.prepare(MEMBER_SQL + " ORDER BY m.name COLLATE NOCASE").all().map(r => memberJson(r, today)));
});

app.post("/api/members", (req, res) => {
  const parsed = parseMember(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const m = parsed.data;
  const id = crypto.randomUUID();
  const remind = m.remind === null ? 1 : m.remind;

  db.prepare("INSERT INTO members (id, name, plan, end_date, phone, remind) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, m.name, m.plan, m.end, m.phone, remind);

  audit(req, "member.create", { target: m.name, details: m.plan + ", ends " + m.end });
  res.status(201).json({ id, name: m.name, plan: m.plan, end: m.end, phone: m.phone, remind, photoAt: null });
});

app.get("/api/members/:id/profile", (req, res) => {
  const r = db.prepare(MEMBER_SQL + " WHERE m.id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "Member not found" });

  const today = localDate(new Date());
  const id = r.id;
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  res.json({
    member: memberJson(r, today),
    stats: {
      totalVisits: one("SELECT COUNT(*) AS n FROM checkins WHERE member_id = ?", id).n,
      visitsLast30: one("SELECT COUNT(*) AS n FROM checkins WHERE member_id = ? AND date >= ?", id, addDays(today, -29)).n,
      totalPaidCents: one("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE member_id = ?", id).n
    },
    payments: db.prepare(
      "SELECT id, paid_on AS paidOn, amount_cents AS amountCents, method, note FROM payments " +
      "WHERE member_id = ? ORDER BY paid_on DESC, created_at DESC LIMIT 20"
    ).all(id),
    checkins: db.prepare("SELECT date, time FROM checkins WHERE member_id = ? ORDER BY time DESC LIMIT 30").all(id)
  });
});

app.put("/api/members/:id", (req, res) => {
  const parsed = parseMember(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const m = parsed.data;
  const before = db.prepare("SELECT name, plan, end_date, phone, remind FROM members WHERE id = ?").get(req.params.id);
  if (!before) return res.status(404).json({ error: "Member not found" });

  const remind = m.remind === null ? before.remind : m.remind;

  db.prepare("UPDATE members SET name = ?, plan = ?, end_date = ?, phone = ?, remind = ? WHERE id = ?")
    .run(m.name, m.plan, m.end, m.phone, remind, req.params.id);

  const changes = [];
  if (before.name !== m.name) changes.push("name: " + before.name + " -> " + m.name);
  if (before.plan !== m.plan) changes.push("plan: " + before.plan + " -> " + m.plan);
  if (before.end_date !== m.end) changes.push("ends: " + before.end_date + " -> " + m.end);
  if ((before.phone || null) !== m.phone) changes.push("phone changed");
  if (before.remind !== remind) changes.push("reminders " + (remind ? "on" : "off"));

  audit(req, "member.update", { target: m.name, details: changes.join("; ") || "no changes" });
  res.json({ id: req.params.id, name: m.name, plan: m.plan, end: m.end, phone: m.phone, remind });
});

app.delete("/api/members/:id", requireAdmin, (req, res) => {
  const member = db.prepare("SELECT name, plan, end_date FROM members WHERE id = ?").get(req.params.id);
  if (!member) return res.status(404).json({ error: "Member not found" });

  db.prepare("DELETE FROM members WHERE id = ?").run(req.params.id);

  audit(req, "member.delete", { target: member.name, details: member.plan + ", ended " + member.end_date });
  res.json({ deleted: req.params.id });
});

// ---- Freeze, unfreeze, cancel ----
function lifecycleMember(id) {
  return db.prepare("SELECT id, name, end_date, frozen_since, cancelled_on FROM members WHERE id = ?").get(id);
}

app.post("/api/members/:id/freeze", (req, res) => {
  const m = lifecycleMember(req.params.id);
  if (!m) return res.status(404).json({ error: "Member not found" });

  const today = localDate(new Date());
  const status = memberStatus(m, today);
  if (status === "Cancelled") return res.status(400).json({ error: "Cancelled memberships cannot be frozen" });
  if (status === "Frozen") return res.status(400).json({ error: "This membership is already frozen" });
  if (status === "Expired") return res.status(400).json({ error: "Expired memberships cannot be frozen. Renew first." });

  db.prepare("UPDATE members SET frozen_since = ? WHERE id = ?").run(today, m.id);
  audit(req, "member.freeze", { target: m.name, details: "frozen from " + today });
  res.json({ frozenSince: today });
});

// The days spent frozen are added back to the end date
app.post("/api/members/:id/unfreeze", (req, res) => {
  const m = lifecycleMember(req.params.id);
  if (!m) return res.status(404).json({ error: "Member not found" });
  if (!m.frozen_since || m.cancelled_on) return res.status(400).json({ error: "This membership is not frozen" });

  const today = localDate(new Date());
  const days = Math.max(0, daysBetween(m.frozen_since, today));
  const end = addDays(m.end_date, days);

  db.prepare("UPDATE members SET end_date = ?, frozen_since = NULL WHERE id = ?").run(end, m.id);
  audit(req, "member.unfreeze", { target: m.name, details: days + " days added, ends " + end });
  res.json({ end, daysAdded: days });
});

app.post("/api/members/:id/cancel", (req, res) => {
  const m = lifecycleMember(req.params.id);
  if (!m) return res.status(404).json({ error: "Member not found" });
  if (m.cancelled_on) return res.status(400).json({ error: "This membership is already cancelled" });

  const today = localDate(new Date());
  db.prepare("UPDATE members SET cancelled_on = ?, frozen_since = NULL WHERE id = ?").run(today, m.id);
  audit(req, "member.cancel", { target: m.name, details: "cancelled on " + today });
  res.json({ cancelledOn: today });
});

// ---- Renewal (optionally with a payment, saved together or not at all) ----
app.post("/api/members/:id/renew", (req, res) => {
  const body = req.body || {};
  const days = body.days;

  if (!Number.isInteger(days) || days < 1 || days > 730) {
    return res.status(400).json({ error: "Days must be a whole number from 1 to 730" });
  }

  const member = lifecycleMember(req.params.id);
  if (!member) return res.status(404).json({ error: "Member not found" });
  if (member.frozen_since) return res.status(400).json({ error: "Unfreeze this membership before renewing it" });

  let payment = null;
  if (body.payment) {
    const cents = toCents(body.payment.amount);
    if (!cents) return res.status(400).json({ error: "Enter a valid payment amount" });
    if (!METHODS.includes(body.payment.method)) return res.status(400).json({ error: "Invalid payment method" });
    payment = { cents, method: body.payment.method };
  }

  // From the later of today and the current end date; renewing also reactivates a cancelled member
  const today = localDate(new Date());
  const base = member.end_date > today ? member.end_date : today;
  const newEnd = addDays(base, days);

  tx(function () {
    db.prepare("UPDATE members SET end_date = ?, cancelled_on = NULL WHERE id = ?").run(newEnd, member.id);
    if (payment) {
      insertPayment(member, payment.cents, today, payment.method, "Renewal +" + days + " days", req.user.username);
    }
  });

  audit(req, "member.renew", {
    target: member.name,
    details: "ends " + member.end_date + " -> " + newEnd +
      (member.cancelled_on ? "; reactivated" : "") +
      (payment ? "; paid " + formatMoney(payment.cents) + " " + payment.method : "")
  });
  res.json({ end: newEnd, paymentRecorded: !!payment });
});

// ---- Member photos ----
app.get("/api/members/:id/photo", (req, res) => {
  const row = db.prepare("SELECT photo FROM members WHERE id = ?").get(req.params.id);
  if (!row || !row.photo) return res.status(404).end();

  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
  res.send(Buffer.from(row.photo));
});

app.put("/api/members/:id/photo", (req, res) => {
  const buf = parseJpegDataUrl((req.body || {}).image, PHOTO_MAX_BYTES);
  if (!buf) return res.status(400).json({ error: "Photo must be a JPEG under 100 KB" });

  const member = db.prepare("SELECT name FROM members WHERE id = ?").get(req.params.id);
  if (!member) return res.status(404).json({ error: "Member not found" });

  const stamp = new Date().toISOString();
  db.prepare("UPDATE members SET photo = ?, photo_at = ? WHERE id = ?").run(buf, stamp, req.params.id);

  audit(req, "member.photo", { target: member.name, details: "photo updated" });
  res.json({ photoAt: stamp });
});

app.delete("/api/members/:id/photo", (req, res) => {
  const member = db.prepare("SELECT name FROM members WHERE id = ?").get(req.params.id);
  if (!member) return res.status(404).json({ error: "Member not found" });

  db.prepare("UPDATE members SET photo = NULL, photo_at = NULL WHERE id = ?").run(req.params.id);

  audit(req, "member.photo", { target: member.name, details: "photo removed" });
  res.json({ ok: true });
});

// ---- Check-ins ----
function checkInMember(req, member) {
  const today = localDate(new Date());
  const status = memberStatus(member, today);

  if (status === "Cancelled") return { code: 400, body: { error: "Membership is cancelled" } };
  if (status === "Frozen") return { code: 400, body: { error: "Membership is frozen" } };
  if (status === "Expired") return { code: 400, body: { error: "Membership has expired" } };

  const checkin = { id: crypto.randomUUID(), memberId: member.id, date: today, time: new Date().toISOString() };
  const result = db.prepare("INSERT OR IGNORE INTO checkins (id, member_id, date, time) VALUES (?, ?, ?, ?)")
    .run(checkin.id, member.id, checkin.date, checkin.time);

  if (result.changes === 0) {
    return { code: 409, body: { error: member.name + " already checked in today" } };
  }

  audit(req, "checkin", { target: member.name });
  return {
    code: 201,
    body: { ...checkin, name: member.name, plan: member.plan, end: member.end_date, status, photoAt: member.photo_at }
  };
}

const CHECKIN_MEMBER_SQL =
  "SELECT id, name, plan, end_date, photo_at, frozen_since, cancelled_on FROM members WHERE ";

app.post("/api/checkins", (req, res) => {
  const { memberId } = req.body || {};
  if (typeof memberId !== "string") return res.status(400).json({ error: "memberId is required" });

  const member = db.prepare(CHECKIN_MEMBER_SQL + "id = ?").get(memberId);
  if (!member) return res.status(404).json({ error: "Member not found" });

  const out = checkInMember(req, member);
  res.status(out.code).json(out.body);
});

// A barcode scanner types the member code and presses Enter
app.post("/api/checkins/by-code", (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== "string" || !/^\d{1,12}$/.test(code.trim())) {
    return res.status(400).json({ error: "Enter a member code (digits only)" });
  }

  const member = db.prepare(CHECKIN_MEMBER_SQL + "code = ?").get(code.trim());
  if (!member) return res.status(404).json({ error: "No member has that code" });

  const out = checkInMember(req, member);
  res.status(out.code).json(out.body);
});

app.get("/api/checkins/daily", (req, res) => {
  let days = parseInt(req.query.days, 10);
  if (isNaN(days) || days < 1) days = 14;
  if (days > 90) days = 90;

  const start = new Date();
  start.setDate(start.getDate() - (days - 1));

  const rows = db.prepare(
    "SELECT date, COUNT(*) AS count FROM checkins WHERE date >= ? GROUP BY date"
  ).all(localDate(start));

  const counts = {};
  rows.forEach(r => { counts[r.date] = r.count; });

  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDate(d);
    result.push({ date: key, count: counts[key] || 0 });
  }
  res.json(result);
});

app.get("/api/checkins/recent", (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit < 1) limit = 8;
  if (limit > 30) limit = 30;

  res.json(db.prepare(
    "SELECT m.id AS memberId, m.name AS name, m.photo_at AS photoAt, c.time AS time, c.date AS date " +
    "FROM checkins c JOIN members m ON m.id = c.member_id ORDER BY c.time DESC LIMIT ?"
  ).all(limit));
});

app.get("/api/checkins/today", (req, res) => {
  const today = localDate(new Date());
  res.json({
    checkins: db.prepare(
      "SELECT m.id AS memberId, m.name AS name, m.photo_at AS photoAt, c.time AS time " +
      "FROM checkins c JOIN members m ON m.id = c.member_id WHERE c.date = ? ORDER BY c.time DESC"
    ).all(today),
    dayPasses: db.prepare(
      "SELECT id, visitor_name AS name, created_at AS time, payment_id AS paymentId " +
      "FROM day_passes WHERE visit_date = ? ORDER BY created_at DESC"
    ).all(today)
  });
});

// ---- Walk-in day passes (the price always comes from settings) ----
app.post("/api/daypasses", (req, res) => {
  const { name, phone, method } = req.body || {};

  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
    return res.status(400).json({ error: "Visitor name is required" });
  }
  if (!METHODS.includes(method)) return res.status(400).json({ error: "Invalid payment method" });

  let e164 = null;
  if (phone !== undefined && phone !== null && phone !== "") {
    const p = normalizePhone(phone);
    if (p.error) return res.status(400).json({ error: p.error });
    e164 = toE164(p.value, DEFAULT_COUNTRY_CODE);
    if (!e164) return res.status(400).json({ error: "Enter a phone number like 0300 1234567" });
  }

  const cents = appSettings.all().dayPassCents;
  const today = localDate(new Date());
  const visitor = name.trim();
  const id = crypto.randomUUID();

  const paymentId = tx(function () {
    const pid = insertPayment({ id: null, name: visitor }, cents, today, method, "Day pass", req.user.username);
    db.prepare(
      "INSERT INTO day_passes (id, visitor_name, phone, visit_date, amount_cents, payment_id, created_by, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, visitor, e164, today, cents, pid, req.user.username, new Date().toISOString());
    return pid;
  });

  audit(req, "daypass.sell", { target: visitor, details: formatMoney(cents) + " " + method });
  res.status(201).json({ id, paymentId, amountCents: cents });
});

// ---- Payments ----
app.get("/api/payments/summary", (req, res) => {
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  }

  const rows = db.prepare(
    "SELECT substr(paid_on, 1, 7) AS month, SUM(amount_cents) AS total " +
    "FROM payments WHERE substr(paid_on, 1, 7) >= ? GROUP BY month"
  ).all(months[0]);

  const totals = {};
  rows.forEach(r => { totals[r.month] = r.total; });

  const series = months.map(m => ({ month: m, totalCents: totals[m] || 0 }));
  res.json({ months: series, thisMonthCents: series[series.length - 1].totalCents });
});

app.get("/api/payments", (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : localDate(new Date()).slice(0, 7);
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: "month must look like 2026-11" });

  const rows = db.prepare(
    "SELECT id, member_id AS memberId, member_name AS memberName, amount_cents AS amountCents, " +
    "paid_on AS paidOn, method, note, recorded_by AS recordedBy FROM payments " +
    "WHERE substr(paid_on, 1, 7) = ? ORDER BY paid_on DESC, created_at DESC"
  ).all(month);

  res.json({ rows, totalCents: rows.reduce((sum, r) => sum + r.amountCents, 0) });
});

app.get("/api/payments/:id", (req, res) => {
  const p = db.prepare(
    "SELECT id, member_id AS memberId, member_name AS memberName, amount_cents AS amountCents, " +
    "paid_on AS paidOn, method, note, recorded_by AS recordedBy, created_at AS createdAt " +
    "FROM payments WHERE id = ?"
  ).get(req.params.id);
  if (!p) return res.status(404).json({ error: "Payment not found" });

  res.json({ ...p, receiptNo: receiptNumber(p.id), gymName: appSettings.get("gym_name") });
});

app.post("/api/payments", (req, res) => {
  const { memberId, amount, paidOn, method, note } = req.body || {};

  const member = typeof memberId === "string"
    ? db.prepare("SELECT id, name FROM members WHERE id = ?").get(memberId)
    : null;
  if (!member) return res.status(404).json({ error: "Member not found" });

  const cents = toCents(amount);
  if (!cents) return res.status(400).json({ error: "Enter a valid amount (for example 3000 or 2999.50)" });
  if (!METHODS.includes(method)) return res.status(400).json({ error: "Invalid payment method" });

  const date = paidOn === undefined || paidOn === "" ? localDate(new Date()) : paidOn;
  if (!isValidDate(date)) return res.status(400).json({ error: "Invalid payment date" });

  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 200)) {
    return res.status(400).json({ error: "Note must be 200 characters or fewer" });
  }

  const id = insertPayment(member, cents, date, method, (note && note.trim()) || null, req.user.username);

  audit(req, "payment.create", { target: member.name, details: formatMoney(cents) + " " + method });
  res.status(201).json({ id });
});

app.delete("/api/payments/:id", requireAdmin, (req, res) => {
  const p = db.prepare("SELECT member_name, amount_cents, method FROM payments WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Payment not found" });

  tx(function () {
    db.prepare("DELETE FROM day_passes WHERE payment_id = ?").run(req.params.id); // voiding a day pass removes it
    db.prepare("DELETE FROM payments WHERE id = ?").run(req.params.id);
  });

  audit(req, "payment.delete", { target: p.member_name, details: formatMoney(p.amount_cents) + " " + p.method });
  res.json({ deleted: req.params.id });
});

// ---- Reports ----
app.get("/api/reports/month", (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : localDate(new Date()).slice(0, 7);
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: "month must look like 2026-11" });

  const [y, mo] = month.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  const today = localDate(new Date());
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const revenue = one("SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n FROM payments WHERE substr(paid_on, 1, 7) = ?", month);

  const byMethod = db.prepare(
    "SELECT method, SUM(amount_cents) AS total, COUNT(*) AS n FROM payments " +
    "WHERE substr(paid_on, 1, 7) = ? GROUP BY method ORDER BY total DESC"
  ).all(month);

  const byPlan = db.prepare(
    "SELECT COALESCE(m.plan, CASE WHEN p.note = 'Day pass' THEN 'Day pass' ELSE 'Former members' END) AS plan, " +
    "SUM(p.amount_cents) AS total, COUNT(*) AS n FROM payments p LEFT JOIN members m ON m.id = p.member_id " +
    "WHERE substr(p.paid_on, 1, 7) = ? GROUP BY plan ORDER BY total DESC"
  ).all(month);

  const counts = {};
  db.prepare("SELECT date, COUNT(*) AS n FROM checkins WHERE substr(date, 1, 7) = ? GROUP BY date")
    .all(month).forEach(r => { counts[r.date] = r.n; });
  const daily = Array.from({ length: daysInMonth }, (_, i) => {
    const date = month + "-" + String(i + 1).padStart(2, "0");
    return { date, count: counts[date] || 0 };
  });
  const total = daily.reduce((sum, d) => sum + d.count, 0);

  let elapsed = daysInMonth;
  if (month === today.slice(0, 7)) elapsed = Number(today.slice(8));
  else if (month > today.slice(0, 7)) elapsed = 0;

  const busiest = daily.reduce((best, d) => (d.count > best.count ? d : best), { date: null, count: 0 });

  res.json({
    month,
    revenueCents: revenue.total,
    paymentCount: revenue.n,
    byMethod,
    byPlan,
    newMembers: one("SELECT COUNT(*) AS n FROM members WHERE substr(joined_on, 1, 7) = ?", month).n,
    renewals: one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member.renew' AND strftime('%Y-%m', time, 'localtime') = ?", month).n,
    lapsed: one(
      "SELECT COUNT(*) AS n FROM members WHERE substr(end_date, 1, 7) = ? AND end_date < ? " +
      "AND cancelled_on IS NULL AND frozen_since IS NULL", month, today
    ).n,
    dayPasses: one("SELECT COUNT(*) AS n FROM day_passes WHERE substr(visit_date, 1, 7) = ?", month).n,
    checkins: { total, avgPerDay: elapsed ? Math.round((total / elapsed) * 10) / 10 : 0, busiest },
    daily
  });
});

// Check-ins by weekday and hour (server clock). Row 0 = Sunday.
app.get("/api/reports/heatmap", (req, res) => {
  let days = parseInt(req.query.days, 10);
  if (isNaN(days) || days < 7) days = 90;
  if (days > 365) days = 365;

  const start = new Date();
  start.setDate(start.getDate() - (days - 1));

  const rows = db.prepare(
    "SELECT CAST(strftime('%w', time, 'localtime') AS INTEGER) AS dow, " +
    "CAST(strftime('%H', time, 'localtime') AS INTEGER) AS hour, COUNT(*) AS n " +
    "FROM checkins WHERE date >= ? GROUP BY dow, hour"
  ).all(localDate(start));

  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  let total = 0;
  rows.forEach(function (r) { matrix[r.dow][r.hour] = r.n; total += r.n; });

  const peaks = rows.map(r => ({ dow: r.dow, hour: r.hour, count: r.n }))
    .sort((a, b) => b.count - a.count).slice(0, 3);

  res.json({ days, total, matrix, peaks });
});

// Paying members who have not visited lately (or never)
app.get("/api/reports/inactive", (req, res) => {
  let days = parseInt(req.query.days, 10);
  if (isNaN(days) || days < 1) days = appSettings.all().inactiveDays;
  if (days > 365) days = 365;
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit < 1 || limit > 200) limit = 200;

  const today = localDate(new Date());
  const cutoff = addDays(today, -days);

  const rows = db.prepare(
    "SELECT m.id, m.name, m.phone, m.plan, m.photo_at AS photoAt, m.joined_on AS joinedOn, " +
    "(SELECT MAX(c.date) FROM checkins c WHERE c.member_id = m.id) AS lastVisit " +
    "FROM members m WHERE m.end_date >= ? AND m.frozen_since IS NULL AND m.cancelled_on IS NULL"
  ).all(today).filter(function (m) {
    if (m.lastVisit) return m.lastVisit <= cutoff;
    return !m.joinedOn || m.joinedOn <= cutoff; // someone who just joined has not "gone quiet" yet
  }).map(m => ({ ...m, daysSince: m.lastVisit ? daysBetween(m.lastVisit, today) : null }))
    .sort((a, b) => (a.daysSince === null ? 1e9 : a.daysSince) < (b.daysSince === null ? 1e9 : b.daysSince) ? 1 : -1);

  res.json({ days, total: rows.length, rows: rows.slice(0, limit) });
});

// ---- Reminders ----
app.get("/api/reminders", (req, res) => res.json(reminders.overview()));
app.get("/api/reminders/history", requireAdmin, (req, res) => res.json(reminders.history(50)));

app.post("/api/reminders/run", requireAdmin, async (req, res, next) => {
  try {
    const summary = await reminders.run();
    audit(req, "reminders.run", { details: summary.sent + " sent, " + summary.failed + " failed (run by hand)" });
    res.json(summary);
  } catch (err) {
    if (err.userFacing) return res.status(400).json({ error: err.message });
    next(err);
  }
});

app.post("/api/reminders/:memberId/mark-sent", (req, res) => {
  const result = reminders.markSent(req.params.memberId, req.user.username);
  if (!result) return res.status(404).json({ error: "That member is not due for a reminder" });

  audit(req, "reminders.mark", { target: result.name, details: "marked as contacted" });
  res.json({ ok: true });
});

// ---- CSV export (admins only) ----
function sendCsv(req, res, name, header, rows) {
  audit(req, "export", { target: name, details: rows.length + " rows" });
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="' + name + "-" + localDate(new Date()) + '.csv"'
  });
  res.send(toCsv(header, rows));
}

app.get("/api/export/members.csv", (req, res) => {
  const today = localDate(new Date());
  const rows = db.prepare(
    "SELECT name, phone, plan, end_date, code, frozen_since, cancelled_on FROM members ORDER BY name COLLATE NOCASE"
  ).all();
  sendCsv(req, res, "members", ["Name", "Phone", "Plan", "End date", "Status", "Member code"],
    rows.map(r => [r.name, r.phone, r.plan, r.end_date, memberStatus(r, today), r.code]));
});

app.get("/api/export/payments.csv", (req, res) => {
  const month = req.query.month;
  if (month !== undefined && !MONTH_RE.test(month)) {
    return res.status(400).json({ error: "month must look like 2026-11" });
  }

  const sql = "SELECT paid_on, member_name, amount_cents, method, note, recorded_by FROM payments" +
    (month ? " WHERE substr(paid_on, 1, 7) = ?" : "") + " ORDER BY paid_on DESC, created_at DESC";
  const rows = month ? db.prepare(sql).all(month) : db.prepare(sql).all();

  sendCsv(req, res, "payments", ["Date", "Member", "Amount", "Method", "Note", "Recorded by"],
    rows.map(r => [r.paid_on, r.member_name, formatMoney(r.amount_cents), METHOD_LABELS[r.method] || r.method, r.note, r.recorded_by]));
});

app.get("/api/export/checkins.csv", (req, res) => {
  const from = req.query.from;
  if (from !== undefined && !isValidDate(from)) {
    return res.status(400).json({ error: "from must look like 2026-11-01" });
  }

  const sql = "SELECT c.date, c.time, m.name FROM checkins c JOIN members m ON m.id = c.member_id" +
    (from ? " WHERE c.date >= ?" : "") + " ORDER BY c.date DESC, c.time DESC";
  const rows = from ? db.prepare(sql).all(from) : db.prepare(sql).all();

  sendCsv(req, res, "checkins", ["Date", "Time (UTC)", "Member"], rows.map(r => [r.date, r.time, r.name]));
});

// ---- CSV import (admins only; the same route previews and commits) ----
app.get("/api/import/template.csv", (req, res) => {
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="members-template.csv"' });
  res.send(toCsv(["Name", "Phone", "Plan", "End date"], [["Ali Khan", "0300 1234567", "Basic", "31/12/2026"]]));
});

app.post("/api/import/members", (req, res) => {
  const { csv, commit } = req.body || {};
  if (typeof csv !== "string" || !csv.trim()) return res.status(400).json({ error: "Choose a CSV file first" });

  const table = parseCsv(csv);
  if (table.length < 2) return res.status(400).json({ error: "The file needs a header row and at least one member" });
  if (table.length - 1 > IMPORT_MAX_ROWS) return res.status(400).json({ error: "At most " + IMPORT_MAX_ROWS + " rows at a time" });

  const map = {};
  table[0].forEach(function (cell, i) {
    const k = mapImportHeader(cell);
    if (k && !(k in map)) map[k] = i;
  });
  const missing = ["name", "phone", "plan"].filter(k => !(k in map));
  if (missing.length) {
    return res.status(400).json({ error: "Missing column(s): " + missing.join(", ") + ". Download the template to see the layout." });
  }

  const today = localDate(new Date());
  const keyOf = (name, phone) => (phone || "") + "|" + String(name).trim().toLowerCase();
  const known = new Set(db.prepare("SELECT name, phone FROM members").all().map(m => keyOf(m.name, m.phone)));

  const results = table.slice(1).map(function (cells, i) {
    const cell = k => (k in map && cells[map[k]] !== undefined ? String(cells[map[k]]).trim() : "");
    const row = { line: i + 2, name: cell("name"), phone: cell("phone"), plan: cell("plan"), end: cell("end"), status: "ok", message: "" };
    const fail = message => { row.status = "error"; row.message = message; return row; };

    if (!row.name) return fail("Name is missing");
    if (row.name.length > 100) return fail("Name is too long");

    const phone = normalizePhone(row.phone);
    if (phone.error || phone.value === null) return fail("Phone is missing or not valid");
    const e164 = toE164(phone.value, DEFAULT_COUNTRY_CODE);
    if (!e164) return fail("Phone needs a country code or a local 0... number");

    const plan = findPlan(row.plan);
    if (!plan) return fail('Unknown plan "' + row.plan + '"');

    let end;
    if (row.end === "") end = addDays(today, plan.days);
    else {
      end = parseImportDate(row.end);
      if (!end) return fail("End date must look like 2026-12-31 or 31/12/2026");
    }

    const key = keyOf(row.name, e164);
    if (known.has(key)) { row.status = "duplicate"; row.message = "Already exists (same name and phone)"; return row; }
    known.add(key);

    Object.assign(row, { phone: e164, plan: plan.name, end, _ok: true });
    return row;
  });

  const good = results.filter(r => r._ok);
  const summary = {
    total: results.length,
    ok: good.length,
    duplicates: results.filter(r => r.status === "duplicate").length,
    errors: results.filter(r => r.status === "error").length
  };

  if (commit === true) {
    const insert = db.prepare("INSERT INTO members (id, name, plan, end_date, phone, remind) VALUES (?, ?, ?, ?, ?, 1)");
    tx(() => good.forEach(r => insert.run(crypto.randomUUID(), r.name, r.plan, r.end, r.phone)));
    audit(req, "members.import", { details: good.length + " imported, " + (summary.total - good.length) + " skipped" });
    summary.imported = good.length;
  }

  const rows = results.slice(0, 500).map(({ _ok, ...r }) => r);
  res.json({ ...summary, rows, truncated: results.length > rows.length });
});

// ---- Staff accounts (admins only) ----
app.get("/api/users", (req, res) => {
  const rows = db.prepare("SELECT id, username, role FROM users ORDER BY username").all();
  res.json(rows.map(u => ({ id: u.id, username: u.username, role: u.role, isSelf: u.id === req.user.id })));
});

app.post("/api/users", async (req, res, next) => {
  const { username, password, role } = req.body || {};
  const name = typeof username === "string" ? username.trim().toLowerCase() : "";

  if (!USERNAME_RE.test(name)) {
    return res.status(400).json({ error: "Username must be 3-30 characters: letters, numbers, dot, dash, underscore" });
  }
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (!ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });

  try {
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const id = crypto.randomUUID();

    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)").run(id, name, hash, role);

    audit(req, "user.create", { target: name, details: "role: " + role });
    res.status(201).json({ id, username: name, role });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "That username is already taken" });
    next(err);
  }
});

app.put("/api/users/:id/role", (req, res) => {
  const { role } = req.body || {};

  if (!ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot change your own role" });

  const target = db.prepare("SELECT username, role FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });

  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);

  audit(req, "user.role", { target: target.username, details: target.role + " -> " + role });
  res.json({ ok: true });
});

app.put("/api/users/:id/password", async (req, res, next) => {
  const passwordError = validatePassword((req.body || {}).password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  try {
    const target = db.prepare("SELECT username FROM users WHERE id = ?").get(req.params.id);
    if (!target) return res.status(404).json({ error: "User not found" });

    const hash = await bcrypt.hash(req.body.password, BCRYPT_COST);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, req.params.id);

    destroyUserSessions(req.params.id, req.sessionID);
    audit(req, "user.password", { target: target.username, details: "password reset" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/users/:id", (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot delete your own account" });

  const target = db.prepare("SELECT username, role FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });

  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  destroyUserSessions(req.params.id);

  audit(req, "user.delete", { target: target.username, details: "role was " + target.role });
  res.json({ deleted: req.params.id });
});

// ---- Audit log (admins only) ----
app.get("/api/audit", (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  const before = parseInt(req.query.before, 10);
  const action = typeof req.query.action === "string" ? req.query.action : "";

  const where = [];
  const params = [];
  if (!isNaN(before)) { where.push("id < ?"); params.push(before); }
  if (action) { where.push("action = ?"); params.push(action); }

  const sql =
    "SELECT id, time, username, action, target, details, ip FROM audit_log" +
    (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY id DESC LIMIT ?";

  const rows = db.prepare(sql).all(...params, limit + 1);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  res.json({ rows, hasMore });
});

app.use(function (err, req, res, next) {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log("Running at http://" + HOST + ":" + PORT + (IS_PROD ? " (production)" : ""));
    reminders.startScheduler();
  });
}

module.exports = app;