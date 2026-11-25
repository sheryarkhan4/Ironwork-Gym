const { $, api, escapeHtml: esc, money, compact, plural, shortDate, avatar, whatsapp, METHOD_LABELS,
  cssVar, todayStr, planColors, toast } = Gym;

const DAY_ROWS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]];
const tooltipBase = { backgroundColor: "#0f172a", titleColor: "#fff", bodyColor: "#e2e8f0", padding: 10, cornerRadius: 10 };

let report = null;
let charts = [];

const hourLabel = h => (h === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : (h - 12) + "p");

// ---- Monthly report ----
function legend(id, rows, labelOf) {
  $(id).innerHTML = rows.length
    ? rows.map(r => `
        <li class="list-item">
          <div class="list-main"><strong>${esc(labelOf(r))}</strong><small class="muted">${plural(r.n, "payment")}</small></div>
          <b>${money(r.total)}</b>
        </li>`).join("")
    : '<li class="empty">No payments this month.</li>';
}

function renderMonth() {
  const r = report;
  $("r-revenue").textContent = money(r.revenueCents);
  $("r-revenue-sub").textContent = plural(r.paymentCount, "payment");
  $("r-new").textContent = r.newMembers;
  $("r-renewals").textContent = r.renewals;
  $("r-lapsed").textContent = r.lapsed;
  $("r-checkins").textContent = r.checkins.total;
  $("r-checkins-sub").textContent = r.checkins.total
    ? r.checkins.avgPerDay + " per day · busiest " + shortDate(r.checkins.busiest.date)
    : "No check-ins yet";
  $("r-passes").textContent = r.dayPasses;

  legend("method-list", r.byMethod, m => METHOD_LABELS[m.method] || m.method);
  legend("plan-list", r.byPlan, p => p.plan);
}

function destroyCharts() {
  charts.forEach(c => c.destroy());
  charts = [];
}

function drawCharts() {
  destroyCharts();
  if (!report) return;

  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--line");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const accent = cssVar("--accent");
  const colors = planColors();

  charts.push(new Chart($("daily-chart"), {
    type: "bar",
    data: {
      labels: report.daily.map(d => String(Number(d.date.slice(8)))),
      datasets: [{ label: "Check-ins", data: report.daily.map(d => d.count), backgroundColor: accent, borderRadius: 4 }]
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipBase, displayColors: false, callbacks: { title: items => shortDate(report.daily[items[0].dataIndex].date) } }
      },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, border: { display: false } } }
    }
  }));

  charts.push(new Chart($("method-chart"), {
    type: "doughnut",
    data: {
      labels: report.byMethod.map(m => METHOD_LABELS[m.method] || m.method),
      datasets: [{
        data: report.byMethod.map(m => m.total / 100),
        backgroundColor: report.byMethod.map((m, i) => colors[i % colors.length]),
        borderWidth: 0
      }]
    },
    options: {
      maintainAspectRatio: false,
      cutout: "68%",
      plugins: {
        legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { ...tooltipBase, callbacks: { label: c => " " + c.label + ": " + money(c.parsed * 100) } }
      }
    }
  }));

  charts.push(new Chart($("plan-chart"), {
    type: "bar",
    data: {
      labels: report.byPlan.map(p => p.plan),
      datasets: [{ label: "Revenue", data: report.byPlan.map(p => p.total / 100), backgroundColor: accent, borderRadius: 6 }]
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipBase, displayColors: false, callbacks: { label: c => money(c.parsed.x * 100) } }
      },
      scales: {
        x: { beginAtZero: true, border: { display: false }, ticks: { callback: v => compact.format(v) } },
        y: { grid: { display: false } }
      }
    }
  }));
}

async function loadMonth() {
  const month = $("month").value || todayStr().slice(0, 7);
  report = await api("/api/reports/month?month=" + encodeURIComponent(month));
  renderMonth();
  drawCharts();
}

// ---- Peak hours ----
function renderHeat(h) {
  const max = Math.max(1, ...h.matrix.flat());
  let html = "<span></span>" +
    Array.from({ length: 24 }, (_, i) => `<span class="heat-hour">${i % 3 === 0 ? hourLabel(i) : ""}</span>`).join("");

  DAY_ROWS.forEach(function (row) {
    html += `<span class="heat-label">${row[0]}</span>`;
    for (let hour = 0; hour < 24; hour++) {
      const n = h.matrix[row[1]][hour];
      html += `<span class="heat-cell" data-v="${(n / max).toFixed(3)}" title="${esc(row[0] + " " + hourLabel(hour) + ": " + plural(n, "check-in"))}"></span>`;
    }
  });

  $("heat").innerHTML = html;
  $("heat").querySelectorAll("[data-v]").forEach(el => el.style.setProperty("--v", el.dataset.v));

  const names = Object.fromEntries(DAY_ROWS.map(r => [r[1], r[0]]));
  $("heat-note").textContent = h.total
    ? "Busiest: " + h.peaks.map(p => names[p.dow] + " " + hourLabel(p.hour) + " (" + p.count + ")").join(", ") + ". Darker means busier."
    : "No check-ins in this period yet.";
}

async function loadHeat() {
  renderHeat(await api("/api/reports/heatmap?days=" + encodeURIComponent($("heat-days").value)));
}

// ---- Members who stopped coming ----
async function loadQuiet() {
  const days = Number($("quiet-days").value) || 14;
  const q = await api("/api/reports/inactive?days=" + encodeURIComponent(days));

  $("quiet-note").textContent = q.total
    ? plural(q.total, "paying member") + " haven't visited in " + q.days + " days or more."
    : "Everyone has visited in the last " + q.days + " days.";

  $("quiet-body").innerHTML = q.rows.map(function (r) {
    const first = r.name.split(/\s+/)[0];
    const text = "Hi " + first + ", we haven't seen you at the gym for a while. Is everything OK? We'd love to see you back!";
    const last = r.lastVisit ? shortDate(r.lastVisit) + " (" + plural(r.daysSince, "day") + " ago)" : "Never";
    const message = r.phone
      ? `<a class="pill-link" target="_blank" rel="noopener" href="${esc(whatsapp(r.phone, text))}">Message</a>` : "";

    return `
      <tr>
        <td><div class="name-cell">${avatar(r)}<a class="name-link" href="/member.html?id=${encodeURIComponent(r.id)}">${esc(r.name)}</a></div></td>
        <td>${esc(r.plan)}</td>
        <td>${last}</td>
        <td class="actions">${message}</td>
      </tr>`;
  }).join("");
}

// ---- Wiring ----
const failed = err => toast(err.message, "error");

$("month").addEventListener("change", () => loadMonth().catch(failed));
$("heat-days").addEventListener("change", () => loadHeat().catch(failed));
$("quiet-days").addEventListener("change", () => loadQuiet().catch(failed));
$("print-btn").addEventListener("click", () => window.print());
window.addEventListener("themechange", drawCharts);

(async function init() {
  try {
    $("month").value = todayStr().slice(0, 7);
    const settings = await api("/api/settings");
    $("quiet-days").value = settings.inactiveDays;

    await Promise.all([loadMonth(), loadHeat(), loadQuiet()]);
  } catch (err) {
    failed(err);
  }
})();