function pad(n) {
  return String(n).padStart(2, "0");
}

function localDate(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function isValidDate(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

// UTC math avoids daylight-saving surprises
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate());
}

function daysBetween(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split("-").map(Number);
  const [y2, m2, d2] = toStr.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// "50", "49.5", "49.99" or 50 -> whole paisa. Anything else -> null.
function toCents(value) {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string") return null;
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

function formatMoney(cents) {
  return (cents / 100).toFixed(2);
}

function normalizePhone(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: "Invalid phone number" };
  const cleaned = value.replace(/[\s\-().]/g, "");
  if (!/^\+?[0-9]{7,15}$/.test(cleaned)) {
    return { error: "Phone must be 7-15 digits, optionally starting with +" };
  }
  return { value: cleaned };
}

// "0300 1234567" -> "+923001234567". Returns null when the country cannot be worked out.
function toE164(phone, countryCode) {
  if (typeof phone !== "string") return null;
  let p = phone.replace(/[\s\-().]/g, "");

  if (p.startsWith("+")) p = p.slice(1);
  else if (p.startsWith("00")) p = p.slice(2);
  else if (p.startsWith("0")) p = countryCode + p.slice(1);
  else if (!p.startsWith(countryCode)) return null;

  return /^[1-9]\d{7,14}$/.test(p) ? "+" + p : null;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(header, rows) {
  return "\uFEFF" + [header].concat(rows).map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function parseJpegDataUrl(str, maxBytes) {
  if (typeof str !== "string") return null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(str);
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 4 || buf.length > maxBytes) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return null;
  return buf;
}

const METHODS = ["cash", "easypaisa", "jazzcash", "card", "transfer", "other"];
const METHOD_LABELS = {
  cash: "Cash", easypaisa: "Easypaisa", jazzcash: "JazzCash",
  card: "Card", transfer: "Bank transfer", other: "Other"
};

// ---- Reminders ----
function dueThreshold(daysLeft, thresholds) {
  if (!Number.isInteger(daysLeft) || daysLeft < 0) return null;
  const found = [...thresholds].sort((a, b) => a - b).find(t => t >= daysLeft);
  return found === undefined ? null : found;
}

function firstName(name) {
  return String(name).trim().split(/\s+/)[0] || "";
}

function whenPhrase(days) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return "in " + days + " days";
}

function renderTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, function (match, key) {
    return Object.hasOwn(vars, key) ? String(vars[key]) : match;
  });
}

// ---- Member status (cancelled and frozen come before the dates) ----
function memberStatus(m, today) {
  if (m.cancelled_on) return "Cancelled";
  if (m.frozen_since) return "Frozen";
  if (m.end_date < today) return "Expired";
  if (m.end_date <= addDays(today, 7)) return "Expiring";
  return "Active";
}

// ---- CSV import ----
// Handles quotes, CRLF, a BOM, and comma / semicolon / tab separators (Excel varies by region)
function parseCsv(text) {
  const s = String(text).replace(/^\uFEFF/, "");
  const first = s.split(/\r?\n/, 1)[0] || "";
  const delim = first.includes(",") ? "," : first.includes(";") ? ";" : first.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [], field = "", quoted = false;

  const endRow = () => {
    row.push(field);
    field = "";
    if (row.some(f => f.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      endRow();
    } else field += c;
  }
  endRow();
  return rows;
}

// YYYY-MM-DD, or DD/MM/YYYY (also with - or .). Returns null when blank or invalid.
function parseImportDate(value) {
  const s = String(value === undefined || value === null ? "" : value).trim();
  let y, mo, d;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  const iso = y + "-" + pad(mo) + "-" + pad(d);
  return isValidDate(iso) ? iso : null;
}

const IMPORT_ALIASES = {
  name: ["name", "fullname", "member", "membername"],
  phone: ["phone", "phonenumber", "mobile", "mobilenumber", "contact", "cell"],
  plan: ["plan", "package", "membership", "membershiptype"],
  end: ["end", "enddate", "ends", "expiry", "expirydate", "expires", "validuntil", "membershipends"]
};

function mapImportHeader(cell) {
  const key = String(cell).toLowerCase().replace(/[^a-z0-9]/g, "");
  return Object.keys(IMPORT_ALIASES).find(k => IMPORT_ALIASES[k].includes(key)) || null;
}

function receiptNumber(id) {
  return "RC-" + String(id).replace(/-/g, "").slice(0, 8).toUpperCase();
}

const PLAN_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} &+().,'-]{0,29}$/u;

module.exports = {
  localDate, isValidDate, addDays, daysBetween, toCents, formatMoney,
  normalizePhone, toE164, csvCell, toCsv, parseJpegDataUrl,
  METHODS, METHOD_LABELS,
  dueThreshold, firstName, whenPhrase, renderTemplate,
  memberStatus, parseCsv, parseImportDate, mapImportHeader, receiptNumber, PLAN_NAME_RE
};