const { $, api, send, escapeHtml: esc, toast, avatar, badge, clock, money } = Gym;

const ELIGIBLE = ["Active", "Expiring"];
let members = [];
let busy = false;
let stream = null;
let scanTimer = null;

async function loadMembers() {
  members = (await api("/api/members")).map(m => ({ ...m, phone: m.phone || "" }));
}

// Exact member code first, then name, phone or the start of a code
function findMatches(text) {
  const t = text.trim().toLowerCase();
  if (!t) return [];

  const exact = members.filter(m => m.code === t);
  if (exact.length) return exact;

  const digits = t.replace(/\D/g, "").replace(/^0/, "");
  const numeric = /^\d+$/.test(t);

  return members.filter(function (m) {
    if (m.name.toLowerCase().includes(t)) return true;
    if (digits.length >= 3 && m.phone.replace(/\D/g, "").includes(digits)) return true;
    return numeric && t.length >= 3 && Boolean(m.code) && m.code.startsWith(t);
  }).slice(0, 8);
}

function showResult(kind, html) {
  $("result").innerHTML = '<div class="result-banner ' + kind + '">' + html + "</div>";
}

function showSuccess(r) {
  const soon = r.status === "Expiring" ? " · expiring soon, remind them to renew" : "";
  showResult("ok",
    '<div class="result-row">' +
      avatar({ id: r.memberId, name: r.name, photoAt: r.photoAt }, true) +
      "<div><div>" + esc(r.name) + " is checked in</div>" +
      "<small>" + esc(r.plan) + " · ends " + esc(r.end) + esc(soon) + "</small></div>" +
    "</div>");
}

function renderMatches(text) {
  $("matches").innerHTML = findMatches(text).map(m => `
    <li class="list-item">
      ${avatar(m)}
      <div class="list-main">
        <a class="name-link" href="/member.html?id=${encodeURIComponent(m.id)}">${esc(m.name)}</a>
        <small class="muted">#${esc(m.code || "")} · ${esc(m.phone || "no phone")} · ends ${esc(m.end)}</small>
      </div>
      ${badge(m.status)}
      ${ELIGIBLE.includes(m.status) ? `<button class="checkin-btn" data-id="${esc(m.id)}">Check in</button>` : ""}
    </li>`).join("");
}

async function loadToday() {
  const data = await api("/api/checkins/today");

  const rows = [
    ...data.checkins.map(c => ({
      time: c.time,
      html: `<li class="list-item">
        ${avatar({ id: c.memberId, name: c.name, photoAt: c.photoAt })}
        <div class="list-main"><a class="name-link" href="/member.html?id=${encodeURIComponent(c.memberId)}">${esc(c.name)}</a></div>
        <span class="time-chip">${esc(clock(c.time))}</span></li>`
    })),
    ...data.dayPasses.map(p => ({
      time: p.time,
      html: `<li class="list-item">
        ${avatar({ id: "", name: p.name, photoAt: null })}
        <div class="list-main"><strong>${esc(p.name)}</strong><small class="muted">Day pass</small></div>
        ${p.paymentId ? `<a class="pill-link" href="/receipt.html?id=${encodeURIComponent(p.paymentId)}">Receipt</a>` : ""}
        <span class="time-chip">${esc(clock(p.time))}</span></li>`
    }))
  ].sort((a, b) => b.time.localeCompare(a.time));

  $("today-count").textContent = rows.length;
  $("today-list").innerHTML = rows.length
    ? rows.map(r => r.html).join("")
    : '<li class="empty">Nobody has checked in yet today.</li>';
}

// One attempt at a time, so a scanner cannot double-submit
async function checkIn(call) {
  if (busy) return;
  busy = true;
  try {
    showSuccess(await call());
    await loadToday();
  } catch (err) {
    showResult("bad", esc(err.message));
  } finally {
    busy = false;
    $("q").value = "";
    renderMatches("");
    $("q").focus();
  }
}

const byId = id => checkIn(() => send("POST", "/api/checkins", { memberId: id }));
const byCode = code => checkIn(() => send("POST", "/api/checkins/by-code", { code }));

$("q").addEventListener("input", () => renderMatches($("q").value));

$("q").addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  e.preventDefault();

  const text = $("q").value.trim();
  if (!text) return;

  // A barcode scanner types the code and presses Enter
  if (/^\d{4,12}$/.test(text) && members.some(m => m.code === text)) return byCode(text);

  const found = findMatches(text);
  if (found.length === 1) return byId(found[0].id);
  if (!found.length) return showResult("bad", "No member found for “" + esc(text) + "”");
  showResult("bad", "Several members match. Tap the right one below.");
});

$("matches").addEventListener("click", function (e) {
  const button = e.target.closest(".checkin-btn");
  if (button) byId(button.dataset.id);
});

// ---- Camera scanning (Chrome, Edge and Android browsers; needs localhost or HTTPS) ----
const canScan = "BarcodeDetector" in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

function stopScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  $("scan-video").srcObject = null;
  $("scan-video").hidden = true;
  $("scan-btn").textContent = "Scan with camera";
}

async function startScan() {
  try {
    const detector = new BarcodeDetector({ formats: ["code_128"] });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });

    const video = $("scan-video");
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    $("scan-btn").textContent = "Stop camera";

    let last = "";
    let lastAt = 0;
    scanTimer = setInterval(async function () {
      if (busy || video.readyState < 2) return;
      try {
        const codes = await detector.detect(video);
        if (!codes.length) return;

        const value = codes[0].rawValue;
        if (value === last && Date.now() - lastAt < 4000) return; // the same card, still in view
        last = value;
        lastAt = Date.now();
        if (/^\d{1,12}$/.test(value)) await byCode(value);
      } catch (err) { /* skip this frame */ }
    }, 400);
  } catch (err) {
    stopScan();
    toast("Could not start the camera: " + err.message, "error");
  }
}

$("scan-btn").addEventListener("click", () => (stream ? stopScan() : startScan()));
window.addEventListener("pagehide", stopScan);

if (canScan) {
  $("scan-btn").hidden = false;
} else {
  $("scan-note").textContent =
    "Camera scanning is not available in this browser. A USB barcode scanner works in the box above.";
}

// ---- Walk-in day pass ----
$("pass-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  $("pass-btn").disabled = true;

  try {
    const r = await send("POST", "/api/daypasses", {
      name: $("pass-name").value,
      phone: $("pass-phone").value,
      method: $("pass-method").value
    });
    $("pass-msg").innerHTML = "Day pass sold for " + esc(money(r.amountCents)) + '. <a class="text-link" href="/receipt.html?id=' +
      encodeURIComponent(r.paymentId) + '">Open receipt</a>';
    $("pass-form").reset();
    toast("Day pass sold.", "success");
    await loadToday();
  } catch (err) {
    $("pass-msg").textContent = "Error: " + err.message;
  } finally {
    $("pass-btn").disabled = false;
  }
});

(async function init() {
  try {
    const [settings] = await Promise.all([api("/api/settings"), loadMembers(), loadToday()]);
    $("pass-price").textContent = "Price: " + money(settings.dayPassCents);
  } catch (err) {
    toast("Could not load: " + err.message, "error");
  }
  $("q").focus();
})();