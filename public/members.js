const { $, api, send, escapeHtml: esc, toast, addDays, todayStr, daysBetween, avatar, badge, loadPlans, planClass } = Gym;

const ELIGIBLE = ["Active", "Expiring"];
const statusRank = { Expired: 0, Expiring: 1, Active: 2, Frozen: 3, Cancelled: 4 };
const STATUSES = ["Active", "Expiring", "Expired", "Frozen", "Cancelled"];

let members = [];
let plans = [];
let isAdmin = false;
let statusFilter = "";
let editingId = null;
let pendingImage = null;
let removePhoto = false;
let renewMember = null;
const sortState = { key: "name", dir: 1 };

const memberDialog = $("member-dialog");
const renewDialog = $("renew-dialog");

function relative(end) {
  const d = daysBetween(todayStr(), end);
  if (d < 0) return Math.abs(d) + "d ago";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return "in " + d + "d";
}

const planIndex = name => Math.max(0, plans.findIndex(p => p.name === name));
const photoUrl = m => "/api/members/" + encodeURIComponent(m.id) + "/photo?v=" + encodeURIComponent(m.photoAt);

async function refresh() {
  members = await api("/api/members");
  members.forEach(m => { m.phone = m.phone || ""; m.remind = m.remind !== 0; });
  render();
}

function compare(a, b, key) {
  if (key === "status") return statusRank[a.status] - statusRank[b.status];
  if (key === "plan") return planIndex(a.plan) - planIndex(b.plan);
  if (key === "end") return a.end < b.end ? -1 : a.end > b.end ? 1 : 0;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function render() {
  const text = $("search").value.trim().toLowerCase();
  const digits = text.replace(/\D/g, "").replace(/^0/, "");

  $("count-all").textContent = members.length;
  STATUSES.forEach(s => { $("count-" + s.toLowerCase()).textContent = members.filter(m => m.status === s).length; });
  document.querySelectorAll("#status-chips .chip").forEach(chip => {
    chip.classList.toggle("is-active", chip.dataset.status === statusFilter);
  });

  const missing = members.filter(m => !m.phone).length;
  $("missing-phones").hidden = missing === 0;
  $("missing-phones").textContent = missing + (missing === 1 ? " member has" : " members have") +
    " no phone number. Edit them to add one, or reminders cannot reach them.";

  const list = members.filter(function (m) {
    const byPhone = digits.length >= 3 && m.phone.replace(/\D/g, "").includes(digits);
    const byText = m.name.toLowerCase().includes(text) || m.plan.toLowerCase().includes(text) ||
      (m.code && m.code.includes(text)) || byPhone;
    return byText && (statusFilter === "" || m.status === statusFilter);
  });
  list.sort((a, b) => compare(a, b, sortState.key) * sortState.dir || a.name.localeCompare(b.name));

  $("members-body").innerHTML = list.map(function (m) {
    const id = esc(m.id);
    const checkin = ELIGIBLE.includes(m.status) ? `<button class="checkin-btn" data-id="${id}">Check in</button>` : "";
    const renew = m.status === "Frozen" ? "" : `<button class="renew-btn" data-id="${id}">Renew</button>`;
    const del = isAdmin ? `<button class="delete-btn" data-id="${id}">Delete</button>` : "";

    return `
      <tr>
        <td><div class="name-cell">${avatar(m)}
          <div class="stack-col"><a class="name-link" href="/member.html?id=${encodeURIComponent(m.id)}">${esc(m.name)}</a>
          <span class="code-tag">#${esc(m.code || "")}</span></div></div></td>
        <td>${m.phone ? esc(m.phone) : '<span class="missing">Missing</span>'}</td>
        <td><span class="${planClass(m.plan)}">${esc(m.plan)}</span></td>
        <td>${esc(m.end)} <small class="muted">${relative(m.end)}</small></td>
        <td>${badge(m.status)}</td>
        <td class="actions">${checkin}${renew}<button class="edit-btn" data-id="${id}">Edit</button>${del}</td>
      </tr>`;
  }).join("");

  document.querySelectorAll("th[data-sort]").forEach(th => {
    const active = th.dataset.sort === sortState.key;
    th.setAttribute("aria-sort", active ? (sortState.dir === 1 ? "ascending" : "descending") : "none");
  });

  $("empty").hidden = list.length > 0;
  $("result-count").textContent = "Showing " + list.length + " of " + members.length + " members";
}

$("search").addEventListener("input", render);
$("status-chips").addEventListener("click", function (e) {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  statusFilter = chip.dataset.status;
  render();
});

function sortBy(key) {
  if (sortState.key === key) sortState.dir = -sortState.dir;
  else { sortState.key = key; sortState.dir = 1; }
  render();
}
const thead = document.querySelector("thead");
thead.addEventListener("click", e => { const th = e.target.closest("th[data-sort]"); if (th) sortBy(th.dataset.sort); });
thead.addEventListener("keydown", function (e) {
  const th = e.target.closest("th[data-sort]");
  if (th && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sortBy(th.dataset.sort); }
});

// ---- Add / edit dialog ----
// Shrink the picture in the browser: square crop, 256px JPEG (re-encoding also strips hidden data)
async function photoToDataUrl(file) {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file");
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch (e) { throw new Error("That image could not be read"); }

  const size = 256;
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}

function paintPreview(src) {
  const img = $("photo-img");
  const ini = $("photo-initials");
  if (src) {
    img.src = src;
    img.hidden = false;
    ini.hidden = true;
  } else {
    img.removeAttribute("src");
    img.hidden = true;
    ini.hidden = false;
    ini.textContent = Gym.initials($("m-name").value) || "+";
  }
  $("m-photo-remove").hidden = !src;
}

function fillPlanSelect(selected) {
  $("m-plan").innerHTML = plans.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
  if (selected) $("m-plan").value = selected;
}

function openMemberDialog(member) {
  editingId = member ? member.id : null;
  pendingImage = null;
  removePhoto = false;

  $("member-title").textContent = member ? "Edit member" : "Add member";
  $("member-save").textContent = member ? "Save changes" : "Add member";
  $("m-name").value = member ? member.name : "";
  $("m-phone").value = member ? member.phone : "";
  fillPlanSelect(member ? member.plan : plans[0] && plans[0].name);
  $("m-end").value = member ? member.end : addDays(todayStr(), (plans[0] && plans[0].days) || 30);
  $("m-remind").checked = member ? member.remind : true;
  $("m-photo").value = "";
  $("member-error").textContent = "";
  paintPreview(member && member.photoAt ? photoUrl(member) : null);

  if (!memberDialog.open) memberDialog.showModal();
  $("m-name").focus();
}

$("add-btn").addEventListener("click", () => openMemberDialog(null));
$("member-cancel").addEventListener("click", () => memberDialog.close());
$("m-name").addEventListener("input", function () {
  if ($("photo-img").hidden) $("photo-initials").textContent = Gym.initials(this.value) || "+";
});

$("m-photo").addEventListener("change", async function () {
  const file = this.files[0];
  if (!file) return;
  try {
    pendingImage = await photoToDataUrl(file);
    removePhoto = false;
    $("member-error").textContent = "";
    paintPreview(pendingImage);
  } catch (err) {
    pendingImage = null;
    this.value = "";
    $("member-error").textContent = err.message;
  }
});

$("m-photo-remove").addEventListener("click", function () {
  const existing = editingId && members.find(m => m.id === editingId);
  removePhoto = Boolean(existing && existing.photoAt);
  pendingImage = null;
  $("m-photo").value = "";
  paintPreview(null);
});

$("member-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  $("member-error").textContent = "";
  $("member-save").disabled = true;

  const data = {
    name: $("m-name").value, phone: $("m-phone").value, plan: $("m-plan").value,
    end: $("m-end").value, remind: $("m-remind").checked
  };
  const wasEditing = editingId;
  const isEdit = wasEditing !== null;

  try {
    const saved = await send(isEdit ? "PUT" : "POST", isEdit ? "/api/members/" + encodeURIComponent(wasEditing) : "/api/members", data);
    const memberId = isEdit ? wasEditing : saved.id;
    memberDialog.close();

    // The member is saved. A photo problem is reported separately.
    let photoProblem = null;
    try {
      if (pendingImage) await send("PUT", "/api/members/" + encodeURIComponent(memberId) + "/photo", { image: pendingImage });
      else if (removePhoto && isEdit) await send("DELETE", "/api/members/" + encodeURIComponent(memberId) + "/photo");
    } catch (err) {
      photoProblem = err.message;
    }

    if (photoProblem) toast("Saved, but the photo failed: " + photoProblem, "error");
    else toast(data.name.trim() + (isEdit ? " updated." : " added."), "success");
    await refresh();
  } catch (err) {
    $("member-error").textContent = err.message;
  } finally {
    $("member-save").disabled = false;
  }
});

// ---- Renewal dialog ----
function updateRenewPreview() {
  const days = parseInt($("renew-days").value, 10);
  if (!renewMember || !(days >= 1 && days <= 730)) { $("renew-preview").textContent = ""; return; }
  const today = todayStr();
  const base = renewMember.end > today ? renewMember.end : today;
  $("renew-preview").textContent = "New end date: " + addDays(base, days) +
    (renewMember.status === "Cancelled" ? " (this also reactivates the membership)" : "");
}

function openRenew(member) {
  if (member.status === "Frozen") return toast("Unfreeze this membership before renewing it.", "error");

  const plan = plans.find(p => p.name === member.plan);
  renewMember = member;
  $("renew-title").textContent = "Renew " + member.name;
  $("renew-days").value = plan ? plan.days : 30;
  $("renew-pay").checked = true;
  $("renew-pay-fields").hidden = false;
  $("renew-amount").value = plan ? (plan.priceCents / 100).toFixed(2) : "";
  $("renew-method").value = "cash";
  $("renew-error").textContent = "";
  updateRenewPreview();
  if (!renewDialog.open) renewDialog.showModal();
}

$("renew-days").addEventListener("input", updateRenewPreview);
$("renew-pay").addEventListener("change", function () { $("renew-pay-fields").hidden = !this.checked; });
$("renew-cancel").addEventListener("click", () => renewDialog.close());

$("renew-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  $("renew-error").textContent = "";

  const body = { days: Number($("renew-days").value) };
  if ($("renew-pay").checked) body.payment = { amount: $("renew-amount").value, method: $("renew-method").value };

  try {
    const result = await send("POST", "/api/members/" + encodeURIComponent(renewMember.id) + "/renew", body);
    renewDialog.close();
    toast(renewMember.name + " renewed until " + result.end + ".", "success");
    await refresh();
  } catch (err) {
    $("renew-error").textContent = err.message;
  }
});

// ---- Row buttons ----
$("members-body").addEventListener("click", async function (e) {
  const button = e.target.closest("button");
  if (!button) return;

  const member = members.find(m => m.id === button.dataset.id);
  if (!member) return;

  if (button.classList.contains("edit-btn")) return openMemberDialog(member);
  if (button.classList.contains("renew-btn")) return openRenew(member);

  try {
    if (button.classList.contains("checkin-btn")) {
      await send("POST", "/api/checkins", { memberId: member.id });
      toast(member.name + " checked in.", "success");
      await refresh();
    } else if (button.classList.contains("delete-btn")) {
      if (!confirm("Delete " + member.name + "? Their payment history is kept.")) return;
      await send("DELETE", "/api/members/" + encodeURIComponent(member.id));
      toast(member.name + " deleted.", "success");
      await refresh();
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

// Links from other pages: #new, #renew=<id>, #edit=<id>
function handleHash() {
  const hash = location.hash;
  if (!hash) return;
  history.replaceState(null, "", location.pathname + location.search);

  if (hash === "#new") return openMemberDialog(null);
  const m = /^#(renew|edit)=(.+)$/.exec(hash);
  if (!m) return;

  let id = "";
  try { id = decodeURIComponent(m[2]); } catch (err) { return; }
  const member = members.find(x => x.id === id);
  if (member) (m[1] === "renew" ? openRenew : openMemberDialog)(member);
}

(async function init() {
  try {
    const me = await api("/api/me");
    isAdmin = me.role === "admin";
    $("export-members").hidden = !isAdmin;

    plans = await loadPlans();
    await refresh();
    handleHash();
  } catch (err) {
    toast("Could not load members: " + err.message, "error");
  }
})();