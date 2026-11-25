// Shared helpers for the newer pages: window.Gym
(function () {
  "use strict";
  const pad = n => String(n).padStart(2, "0");
  const G = {};

  G.$ = id => document.getElementById(id);
  G.moneyFmt = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
  G.money = cents => G.moneyFmt.format(cents / 100);
  G.compact = new Intl.NumberFormat("en-PK", { notation: "compact", maximumFractionDigits: 1 });
  G.METHOD_LABELS = { cash: "Cash", easypaisa: "Easypaisa", jazzcash: "JazzCash", card: "Card", transfer: "Bank transfer", other: "Other" };

  G.escapeHtml = text => String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  G.plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  G.capitalize = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  G.cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  G.todayStr = function () {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  };
  G.addDays = function (dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate());
  };
  G.daysBetween = function (from, to) {
    const [y1, m1, d1] = from.split("-").map(Number);
    const [y2, m2, d2] = to.split("-").map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  };
  G.shortDate = function (s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  G.monthLabel = function (s) {
    const [y, m] = s.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" });
  };
  G.clock = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  G.timeAgo = function (iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "Just now";
    if (s < 3600) return G.plural(Math.round(s / 60), "minute") + " ago";
    if (s < 86400) return G.plural(Math.round(s / 3600), "hour") + " ago";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  G.initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");

  // m needs name, photoAt and id (or memberId)
  G.avatar = function (m, large) {
    const cls = "avatar" + (large ? " avatar-lg" : "");
    if (m.photoAt) {
      return `<img class="${cls}" alt="" loading="lazy" src="/api/members/${encodeURIComponent(m.id || m.memberId)}/photo?v=${encodeURIComponent(m.photoAt)}">`;
    }
    return `<span class="${cls} avatar-initials">${G.escapeHtml(G.initials(m.name))}</span>`;
  };

  G.badge = status => `<span class="badge ${G.escapeHtml(status)}">${G.escapeHtml(status)}</span>`;
  G.whatsapp = (phone, text) =>
    "https://wa.me/" + String(phone).replace(/\D/g, "") + (text ? "?text=" + encodeURIComponent(text) : "");

  // Resolves to parsed JSON; throws Error(server message) on failure; 401 goes to the login page
  G.api = async function (url, options) {
    const response = await fetch(url, options);
    if (response.status === 401) {
      window.location.href = "/login.html";
      throw new Error("Please log in");
    }
    let data = null;
    try { data = await response.json(); } catch (e) { /* no JSON body */ }
    if (!response.ok) throw new Error((data && data.error) || "Server returned " + response.status);
    return data;
  };
  G.send = (method, url, body) => G.api(url, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body === undefined ? {} : body)
  });

  G.toast = (message, kind) => { if (window.gymToast) window.gymToast(message, kind); };

  // Plans (cached). A plan's colour follows its position in the list.
  G.plans = [];
  G.loadPlans = async function () {
    G.plans = await G.api("/api/plans");
    return G.plans;
  };
  G.planClass = function (name) {
    const i = G.plans.findIndex(p => p.name === name);
    return "plan plan-c" + ((i < 0 ? 5 : i) % 6);
  };
  G.planColors = () => ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"].map(G.cssVar);

  window.Gym = G;
})();