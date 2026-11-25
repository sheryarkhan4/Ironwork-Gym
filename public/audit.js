const $ = id => document.getElementById(id);
let oldest = null; // id of the oldest entry loaded so far

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Not logged in -> login page. Logged in but not an admin -> dashboard.
async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Please log in");
  }
  if (response.status === 403) {
    window.location.href = "/";
    throw new Error("Only admins can do this");
  }
  return response;
}

function rowHtml(r) {
  const warn = /failed|locked|delete/.test(r.action) ? " audit-warn" : "";

  return `
    <tr>
      <td>${escapeHtml(new Date(r.time).toLocaleString())}</td>
      <td>${escapeHtml(r.username)}</td>
      <td><code class="audit-action${warn}">${escapeHtml(r.action)}</code></td>
      <td>${escapeHtml(r.target || "")}</td>
      <td>${escapeHtml(r.details || "")}</td>
      <td>${escapeHtml(r.ip || "")}</td>
    </tr>`;
}

async function load(reset) {
  if (reset) {
    oldest = null;
    $("audit-body").innerHTML = "";
  }

  const params = new URLSearchParams({ limit: "50" });
  if (oldest !== null) params.set("before", oldest);
  if ($("action-filter").value) params.set("action", $("action-filter").value);

  try {
    const response = await api("/api/audit?" + params);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    $("audit-body").insertAdjacentHTML("beforeend", data.rows.map(rowHtml).join(""));
    if (data.rows.length) oldest = data.rows[data.rows.length - 1].id;

    $("more-btn").hidden = !data.hasMore;
    $("audit-empty").hidden = $("audit-body").children.length > 0;
    $("audit-msg").textContent = "";
  } catch (err) {
    $("audit-msg").textContent = "Could not load the log: " + err.message;
  }
}

$("action-filter").addEventListener("change", () => load(true));
$("more-btn").addEventListener("click", () => load(false));

$("logout-btn").addEventListener("click", async function () {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

load(true);