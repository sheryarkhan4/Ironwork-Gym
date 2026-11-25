const db = require("./db");
const appSettings = require("./settings");
const { DEFAULT_COUNTRY_CODE } = require("./config");
const {
  localDate, addDays, daysBetween, dueThreshold, toE164,
  renderTemplate, firstName, whenPhrase
} = require("./lib");

const MAX_ATTEMPTS = 3;
const DEFAULT_TEMPLATE =
  "Hi {name}, your {gym} membership expires {when} ({date}). Please renew to keep your access.";

function settings() {
  const days = (process.env.REMINDER_DAYS || "7,1")
    .split(",")
    .map(s => parseInt(s, 10))
    .filter(n => Number.isInteger(n) && n >= 0 && n <= 60);

  const fromHour = parseInt(process.env.REMINDER_FROM_HOUR, 10);
  const toHour = parseInt(process.env.REMINDER_TO_HOUR, 10);

  return {
    provider: (process.env.REMINDER_PROVIDER || "manual").trim().toLowerCase(),
    thresholds: days.length ? days : [7, 1],
    fromHour: fromHour >= 0 && fromHour <= 23 ? fromHour : 10,
    toHour: toHour >= 1 && toHour <= 24 ? toHour : 19,
    gym: appSettings.get("gym_name"),
    template: process.env.REMINDER_TEMPLATE || DEFAULT_TEMPLATE
  };
}

function configError(s) {
  if (s.provider === "manual") return null;

  if (s.provider === "webhook") {
    return /^https?:\/\//.test(process.env.REMINDER_WEBHOOK_URL || "")
      ? null
      : "REMINDER_WEBHOOK_URL must be set to an http(s) address";
  }

  if (s.provider === "twilio") {
    const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"].filter(k => !process.env[k]);
    return missing.length ? "Missing settings: " + missing.join(", ") : null;
  }

  return 'Unknown REMINDER_PROVIDER "' + s.provider + '" (use manual, webhook or twilio)';
}

function userError(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

// Frozen and cancelled memberships are never reminded
function findDue(today, s) {
  const furthest = Math.max(...s.thresholds);

  const members = db.prepare(
    "SELECT id, name, phone, end_date, remind FROM members " +
    "WHERE end_date >= ? AND end_date <= ? AND frozen_since IS NULL AND cancelled_on IS NULL " +
    "ORDER BY end_date, name COLLATE NOCASE"
  ).all(today, addDays(today, furthest));

  const lookup = db.prepare(
    "SELECT status, attempts FROM reminders WHERE member_id = ? AND threshold = ? AND end_date = ?"
  );

  return members.map(function (m) {
    const daysLeft = daysBetween(today, m.end_date);
    const threshold = dueThreshold(daysLeft, s.thresholds);
    const phone = m.phone ? toE164(m.phone, DEFAULT_COUNTRY_CODE) : null;
    const prior = lookup.get(m.id, threshold, m.end_date) || null;

    let skip = null;
    if (!m.remind) skip = "Opted out of reminders";
    else if (!m.phone) skip = "No phone number";
    else if (!phone) skip = "Phone number not usable";

    return {
      memberId: m.id,
      name: m.name,
      phone,
      endDate: m.end_date,
      daysLeft,
      threshold,
      message: renderTemplate(s.template, {
        name: firstName(m.name), gym: s.gym, when: whenPhrase(daysLeft), date: m.end_date, days: daysLeft
      }),
      state: prior ? prior.status : "none",
      attempts: prior ? prior.attempts : 0,
      gaveUp: !!prior && prior.status === "failed" && prior.attempts >= MAX_ATTEMPTS,
      skip
    };
  });
}

function record(item, status, detail, provider) {
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO reminders (member_id, member_name, phone, threshold, end_date, status, attempts, provider, detail, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?) " +
    "ON CONFLICT (member_id, threshold, end_date) DO UPDATE SET " +
    "status = excluded.status, attempts = reminders.attempts + 1, provider = excluded.provider, " +
    "phone = excluded.phone, detail = excluded.detail, updated_at = excluded.updated_at"
  ).run(
    item.memberId, item.name, item.phone, item.threshold, item.endDate,
    status, provider, detail ? String(detail).slice(0, 200) : null, now, now
  );
}

function systemAudit(action, details) {
  try {
    db.prepare(
      "INSERT INTO audit_log (time, user_id, username, action, target, details, ip) " +
      "VALUES (?, NULL, 'system', ?, NULL, ?, NULL)"
    ).run(new Date().toISOString(), action, details);
  } catch (err) {
    console.error("Audit write failed:", err.message);
  }
}

async function send(s, item) {
  if (s.provider === "webhook") {
    const headers = { "Content-Type": "application/json" };
    if (process.env.REMINDER_WEBHOOK_TOKEN) headers.Authorization = "Bearer " + process.env.REMINDER_WEBHOOK_TOKEN;

    const res = await fetch(process.env.REMINDER_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        to: item.phone, message: item.message, name: item.name, endDate: item.endDate, daysLeft: item.daysLeft
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) throw new Error("Gateway answered " + res.status);
    return;
  }

  if (s.provider === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const from = process.env.TWILIO_FROM;
    const channel = from.startsWith("whatsapp:") ? "whatsapp:" : "";

    const res = await fetch(
      "https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(sid) + "/Messages.json",
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(sid + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ To: channel + item.phone, From: from, Body: item.message }),
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).message || ""; } catch (e) { /* no JSON body */ }
      throw new Error("Twilio answered " + res.status + (detail ? ": " + detail : ""));
    }
    return;
  }

  throw new Error("No sender for provider " + s.provider);
}

let running = false;

async function run(now) {
  const s = settings();

  if (s.provider === "manual") {
    throw userError("Automatic sending is off (set REMINDER_PROVIDER to webhook or twilio)");
  }
  const problem = configError(s);
  if (problem) throw userError(problem);
  if (running) throw userError("A reminder run is already in progress");

  running = true;
  const summary = { sent: 0, failed: 0, skipped: 0 };

  try {
    for (const item of findDue(localDate(now || new Date()), s)) {
      if (item.skip) { summary.skipped += 1; continue; }
      if (item.state === "sent" || item.gaveUp) continue;

      try {
        await send(s, item);
        record(item, "sent", null, s.provider);
        summary.sent += 1;
      } catch (err) {
        record(item, "failed", err.message, s.provider);
        summary.failed += 1;
      }
    }
  } finally {
    running = false;
  }

  return summary;
}

function markSent(memberId, username) {
  const item = findDue(localDate(new Date()), settings()).find(i => i.memberId === memberId);
  if (!item || item.skip) return null;

  record(item, "sent", "Marked as contacted by " + username, "manual");
  return { name: item.name };
}

function overview() {
  const s = settings();
  const missing = db.prepare(
    "SELECT COUNT(*) AS n FROM members WHERE phone IS NULL OR trim(phone) = ''"
  ).get().n;

  return {
    settings: {
      provider: s.provider,
      automated: s.provider !== "manual",
      problem: configError(s),
      thresholds: s.thresholds,
      fromHour: s.fromHour,
      toHour: s.toHour
    },
    due: findDue(localDate(new Date()), s),
    missingPhone: missing
  };
}

function history(limit) {
  return db.prepare(
    "SELECT id, member_name AS memberName, phone, threshold, end_date AS endDate, status, attempts, " +
    "provider, detail, updated_at AS updatedAt FROM reminders ORDER BY updated_at DESC, id DESC LIMIT ?"
  ).all(limit);
}

async function tick() {
  const s = settings();
  const hour = new Date().getHours();
  if (hour < s.fromHour || hour >= s.toHour) return;

  try {
    const summary = await run();
    if (summary.sent || summary.failed) {
      systemAudit("reminders.run", summary.sent + " sent, " + summary.failed + " failed");
      console.log("Reminders:", summary);
    }
  } catch (err) {
    console.error("Reminder run failed:", err.message);
  }
}

function startScheduler() {
  const s = settings();

  if (s.provider === "manual") {
    console.log("Reminders: manual mode (no automatic sending).");
    return;
  }
  const problem = configError(s);
  if (problem) {
    console.error("Reminders are OFF: " + problem);
    return;
  }

  console.log("Reminders: automatic via " + s.provider + ", sending between " + s.fromHour + ":00 and " + s.toHour + ":00.");
  setTimeout(tick, 10000).unref();
  setInterval(tick, 30 * 60 * 1000).unref();
}

module.exports = { overview, history, run, markSent, startScheduler };