// Dashboard
const { $, api, escapeHtml: esc, money, compact, todayStr, addDays, daysBetween, shortDate, monthLabel,
  avatar, timeAgo, clock, cssVar, whatsapp, plural, capitalize, planColors } = Gym;

let members = [];
let plans = [];
let checkinChart, planChart, revenueChart;
let lastDaily = [];
let lastSummary = null;

const isCurrent = m => m.status === "Active" || m.status === "Expiring";

// Numbers count up from zero (skipped when the visitor prefers reduced motion)
function countTo(el, target, format) {
  format = format || (n => String(Math.round(n)));
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el._run = (el._run || 0) + 1;
  const run = el._run;

  if (reduce || target === 0) { el.textContent = format(target); return; }

  const start = performance.now();
  function step(now) {
    if (el._run !== run) return;
    const t = Math.min(1, (now - start) / 700);
    el.textContent = format(target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function renderTodaySub(daily) {
  const avg = daily.reduce((sum, d) => sum + d.count, 0) / daily.length;
  $("kpi-today-sub").textContent = "Avg " + Math.round(avg * 10) / 10 + " per day · last " + daily.length + " days";
}

function renderTrend(summary) {
  const el = $("kpi-revenue-sub");
  const months = summary.months;
  const now = months[months.length - 1].totalCents;
  const before = months[months.length - 2].totalCents;
  el.className = "kpi-sub";

  if (before > 0) {
    const pct = Math.round(((now - before) / before) * 100);
    el.classList.add(pct >= 0 ? "up" : "down");
    el.textContent = (pct >= 0 ? "▲ " : "▼ ") + Math.abs(pct) + "% vs last month";
  } else if (now > 0) {
    el.classList.add("up");
    el.textContent = "First revenue in a while";
  } else {
    el.textContent = "No payments recorded yet";
  }
}

function renderKpis(daily, summary) {
  const active = members.filter(isCurrent).length;
  const expiring = members.filter(m => m.status === "Expiring").length;

  countTo($("kpi-active"), active);
  $("kpi-active-sub").textContent = members.length + " total · " + (members.length - active) + " not active";
  countTo($("kpi-revenue"), summary.thisMonthCents, c => money(Math.round(c)));
  renderTrend(summary);
  countTo($("kpi-expiring"), expiring);
  $("kpi-expiring-sub").textContent = expiring ? "Follow up on Reminders" : "Nobody expiring this week";
  countTo($("kpi-today"), daily[daily.length - 1].count);
  renderTodaySub(daily);
}

function renderHero(daily) {
  const todayCount = daily[daily.length - 1].count;
  const expiring = members.filter(m => m.status === "Expiring").length;
  $("hero-sub").textContent =
    plural(todayCount, "check-in") + " so far today · " + plural(expiring, "membership") + " expiring this week";
}

function renderExpiring() {
  const today = todayStr();
  const soon = members
    .filter(m => isCurrent(m) && m.end >= today && m.end <= addDays(today, 14))
    .sort((a, b) => a.end.localeCompare(b.end) || a.name.localeCompare(b.name))
    .slice(0, 6);

  if (!soon.length) {
    $("expiring-list").innerHTML = '<li class="empty">No memberships expiring in the next 14 days.</li>';
    return;
  }

  $("expiring-list").innerHTML = soon.map(function (m) {
    const days = daysBetween(today, m.end);
    const when = days === 0 ? "Today" : days === 1 ? "Tomorrow" : "In " + days + " days";
    return `
      <li class="list-item">
        ${avatar(m)}
        <div class="list-main">
          <a class="name-link" href="/member.html?id=${encodeURIComponent(m.id)}">${esc(m.name)}</a>
          <small class="muted">Ends ${shortDate(m.end)} · ${esc(m.plan)}</small>
        </div>
        <span class="badge ${days <= 3 ? "Expired" : "Expiring"}">${when}</span>
        <a class="pill-link" href="/members.html#renew=${encodeURIComponent(m.id)}">Renew</a>
      </li>`;
  }).join("");
}

function renderRecent(rows) {
  if (!rows.length) {
    $("recent-list").innerHTML = '<li class="empty">No check-ins recorded yet.</li>';
    return;
  }
  $("recent-list").innerHTML = rows.map(r => `
    <li class="list-item">
      ${avatar({ id: r.memberId, name: r.name, photoAt: r.photoAt })}
      <div class="list-main">
        <a class="name-link" href="/member.html?id=${encodeURIComponent(r.memberId)}">${esc(r.name)}</a>
        <small class="muted">${timeAgo(r.time)}</small>
      </div>
      <span class="time-chip">${clock(r.time)}</span>
    </li>`).join("");
}

function renderQuiet(q) {
  $("quiet-note").textContent = q.total
    ? q.total + " paying member(s) haven't visited in " + q.days + "+ days."
    : "Everyone has visited in the last " + q.days + " days.";

  $("quiet-list").innerHTML = q.rows.map(function (r) {
    const first = r.name.split(/\s+/)[0];
    const last = r.lastVisit ? plural(r.daysSince, "day") + " ago" : "Never visited";
    const msg = r.phone ? `<a class="pill-link" target="_blank" rel="noopener" href="${esc(whatsapp(r.phone, "Hi " + first + ", we haven't seen you at the gym for a while. Is everything OK? We'd love to see you back!"))}">Message</a>` : "";
    return `
      <li class="list-item">
        ${avatar(r)}
        <div class="list-main">
          <a class="name-link" href="/member.html?id=${encodeURIComponent(r.id)}">${esc(r.name)}</a>
          <small class="muted">${last}</small>
        </div>
        ${msg}
      </li>`;
  }).join("");
}

function renderSnapshot() {
  const total = members.length;
  ["Active", "Expiring", "Expired", "Frozen"].forEach(function (s) {
    const n = members.filter(m => m.status === s).length;
    $("n-" + s.toLowerCase()).textContent = n;
    $("bar-" + s.toLowerCase()).style.width = (total ? Math.round((n / total) * 100) : 0) + "%";
  });
}

// ---- Charts ----
function areaGradient(context) {
  const chart = context.chart;
  if (!chart.chartArea) return "rgba(255, 107, 53, 0.15)";
  const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
  g.addColorStop(0, "rgba(255, 107, 53, 0.38)");
  g.addColorStop(1, "rgba(255, 107, 53, 0)");
  return g;
}

function updateCheckins(daily) {
  lastDaily = daily;
  checkinChart.data.labels = daily.map(x => shortDate(x.date));
  checkinChart.data.datasets[0].data = daily.map(x => x.count);
  checkinChart.update();
}

function drawCharts(daily, summary) {
  lastSummary = summary;
  const accent = cssVar("--accent");
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--line");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const tooltip = { backgroundColor: "#0f172a", titleColor: "#fff", bodyColor: "#e2e8f0", padding: 10, cornerRadius: 10, displayColors: false };

  checkinChart = new Chart($("checkins-chart"), {
    type: "line",
    data: { labels: [], datasets: [{
      label: "Check-ins", data: [], borderColor: accent, backgroundColor: areaGradient, fill: true,
      tension: 0.35, borderWidth: 3, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: accent
    }] },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
        y: { beginAtZero: true, ticks: { precision: 0 }, border: { display: false } }
      }
    }
  });
  updateCheckins(daily);

  const colors = planColors();
  planChart = new Chart($("plan-chart"), {
    type: "doughnut",
    data: {
      labels: plans.map(p => p.name),
      datasets: [{
        data: plans.map(p => members.filter(m => m.plan === p.name && m.status !== "Expired" && m.status !== "Cancelled").length),
        backgroundColor: plans.map((p, i) => colors[i % colors.length]), borderWidth: 0, hoverOffset: 8
      }]
    },
    options: {
      maintainAspectRatio: false, cutout: "72%",
      plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8, padding: 18 } }, tooltip: { ...tooltip, displayColors: true } }
    }
  });

  const months = summary.months;
  const mid = cssVar("--accent-mid");
  revenueChart = new Chart($("revenue-chart"), {
    type: "bar",
    data: {
      labels: months.map(x => monthLabel(x.month)),
      datasets: [{
        label: "Revenue", data: months.map(x => x.totalCents / 100),
        backgroundColor: months.map((x, i) => (i === months.length - 1 ? accent : mid)), borderRadius: 8, borderSkipped: false
      }]
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { label: ctx => money(ctx.parsed.y * 100) } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, border: { display: false }, ticks: { callback: v => compact.format(v) } } }
    }
  });
}

window.addEventListener("themechange", function () {
  if (!checkinChart) return;
  [checkinChart, planChart, revenueChart].forEach(c => c.destroy());
  drawCharts(lastDaily, lastSummary);
});

$("range").addEventListener("change", async function () {
  try {
    const daily = await api("/api/checkins/daily?days=" + encodeURIComponent($("range").value));
    updateCheckins(daily);
    renderTodaySub(daily);
  } catch (err) {
    Gym.toast(err.message, "error");
  }
});

(async function init() {
  try {
    const me = await api("/api/me");
    const hour = new Date().getHours();
    $("hero-title").textContent = (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening") + ", " + capitalize(me.username);

    [members, plans] = await Promise.all([api("/api/members"), api("/api/plans")]);

    const [daily, summary, recent, quiet] = await Promise.all([
      api("/api/checkins/daily?days=" + encodeURIComponent($("range").value)),
      api("/api/payments/summary"),
      api("/api/checkins/recent?limit=8"),
      api("/api/reports/inactive?limit=5")
    ]);

    renderKpis(daily, summary);
    renderHero(daily);
    renderExpiring();
    renderRecent(recent);
    renderQuiet(quiet);
    renderSnapshot();
    drawCharts(daily, summary);
  } catch (err) {
    Gym.toast("Could not load the dashboard: " + err.message, "error");
  }
})();