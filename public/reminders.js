const $ = id => document.getElementById(id);
let isAdmin = false;
let automated = false;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Please log in");
  }
  return response;
}

function say(text) { $("rem-msg").textContent = text; }

function whenText(days) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return "in " + days + " days";
}

function statusCell(item) {
  if (item.skip) {
    return `<span class="badge Expired">Skipped</span> <small>${escapeHtml(item.skip)}</small>`;
  }
  if (item.state === "sent") return '<span class="badge Active">Sent</span>';
  if (item.gaveUp) return `<span class="badge Expiring">Failed, gave up (${item.attempts})</span>`;
  if (item.state === "failed") return `<span class="badge Expiring">Failed (${item.attempts})</span>`;
  return `<span class="badge neutral">${automated ? "Queued" : "To do"}</span>`;
}

// A WhatsApp chat opens with the message already typed; the staff member presses send
function actionsCell(item) {
  if (item.skip || item.state === "sent") return "";

  const link = "https://wa.me/" + item.phone.replace(/\D/g, "") + "?text=" + encodeURIComponent(item.message);
  return `
    <a class="link-btn small-link" href="${escapeHtml(link)}" target="_blank" rel="noopener">WhatsApp</a>
    <button class="checkin-btn mark-btn" data-id="${escapeHtml(item.memberId)}">Mark contacted</button>`;
}

function renderDue(due) {
  $("due-empty").hidden = due.length > 0;
  $("due-body").innerHTML = due.map(function (i) {
    return `
      <tr>
        <td>${escapeHtml(i.name)}</td>
        <td>${escapeHtml(i.phone || "-")}</td>
        <td>${escapeHtml(i.endDate)} <small>(${whenText(i.daysLeft)})</small></td>
        <td>${statusCell(i)}</td>
        <td class="msg-cell">${escapeHtml(i.message)}</td>
        <td>${actionsCell(i)}</td>
      </tr>`;
  }).join("");
}

async function load() {
  const response = await api("/api/reminders");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);

  const s = data.settings;
  automated = s.automated;

  if (!s.automated) {
    $("mode-note").textContent =
      "Automatic sending is off. Use the WhatsApp button for each member, then click Mark contacted.";
  } else if (s.problem) {
    $("mode-note").textContent = "Automatic sending is set to " + s.provider + " but is not working: " + s.problem;
  } else {
    $("mode-note").textContent =
      "Automatic sending is on (" + s.provider + "). Messages go out between " + s.fromHour + ":00 and " +
      s.toHour + ":00, " + s.thresholds.join(" and ") + " day(s) before a membership ends.";
  }

  $("missing").hidden = data.missingPhone === 0;
  $("missing").textContent =
    data.missingPhone + " member(s) have no phone number and cannot be reminded. Edit them on the dashboard.";

  $("run-btn").hidden = !(isAdmin && s.automated && !s.problem);
  renderDue(data.due);
}

async function loadHistory() {
  if (!isAdmin) return;

  const response = await api("/api/reminders/history");
  const rows = await response.json();
  if (!response.ok) return;

  $("history-panel").hidden = false;
  $("history-empty").hidden = rows.length > 0;
  $("history-body").innerHTML = rows.map(function (r) {
    return `
      <tr>
        <td>${escapeHtml(new Date(r.updatedAt).toLocaleString())}</td>
        <td>${escapeHtml(r.memberName)}</td>
        <td>${escapeHtml(r.phone)}</td>
        <td>${escapeHtml(r.status)}${r.attempts > 1 ? " (" + r.attempts + " tries)" : ""}</td>
        <td>${escapeHtml(r.provider)}</td>
        <td class="msg-cell">${escapeHtml(r.detail || "")}</td>
      </tr>`;
  }).join("");
}

$("due-body").addEventListener("click", async function (e) {
  const button = e.target.closest(".mark-btn");
  if (!button) return;

  try {
    const response = await api("/api/reminders/" + encodeURIComponent(button.dataset.id) + "/mark-sent", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    say("Marked as contacted.");
    await load();
    await loadHistory();
  } catch (err) {
    say("Error: " + err.message);
  }
});

$("run-btn").addEventListener("click", async function () {
  if (!confirm("Send every pending reminder now?")) return;
  $("run-btn").disabled = true;

  try {
    const response = await api("/api/reminders/run", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    say(data.sent + " sent, " + data.failed + " failed, " + data.skipped + " skipped.");
    await load();
    await loadHistory();
  } catch (err) {
    say("Error: " + err.message);
  } finally {
    $("run-btn").disabled = false;
  }
});

$("logout-btn").addEventListener("click", async function () {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

(async function init() {
  try {
    const me = await (await api("/api/me")).json();
    isAdmin = me.role === "admin";
    await load();
    await loadHistory();
  } catch (err) {
    say("Could not load: " + err.message);
  }
})();