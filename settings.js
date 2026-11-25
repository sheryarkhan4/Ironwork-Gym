const db = require("./db");
const { toCents } = require("./lib");

// Read from the environment at call time, so GYM_NAME in .env still works until someone edits it
const DEFAULTS = {
  gym_name: () => process.env.GYM_NAME || "IronWorks Gym",
  day_pass_cents: () => "50000",
  inactive_days: () => "14"
};

function get(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : DEFAULTS[key]();
}

function all() {
  return {
    gymName: get("gym_name"),
    dayPassCents: parseInt(get("day_pass_cents"), 10) || 50000,
    inactiveDays: parseInt(get("inactive_days"), 10) || 14
  };
}

function validate(body) {
  const b = body || {};
  const values = {};

  if (b.gymName !== undefined) {
    if (typeof b.gymName !== "string" || !b.gymName.trim() || b.gymName.trim().length > 60) {
      return { error: "Gym name must be 1-60 characters" };
    }
    values.gym_name = b.gymName.trim();
  }
  if (b.dayPassPrice !== undefined) {
    const cents = toCents(b.dayPassPrice);
    if (!cents) return { error: "Enter a valid day pass price" };
    values.day_pass_cents = String(cents);
  }
  if (b.inactiveDays !== undefined) {
    if (!Number.isInteger(b.inactiveDays) || b.inactiveDays < 1 || b.inactiveDays > 365) {
      return { error: "Inactive days must be a whole number from 1 to 365" };
    }
    values.inactive_days = String(b.inactiveDays);
  }
  return { values };
}

function update(values) {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  Object.keys(values).forEach(k => upsert.run(k, values[k]));
}

module.exports = { get, all, validate, update };