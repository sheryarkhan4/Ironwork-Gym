const { $, api, send, escapeHtml: esc, toast, money, avatar, badge, whatsapp, METHOD_LABELS, shortDate, plural, daysBetween, todayStr, loadPlans, planClass } = Gym;

const id = new URLSearchParams(location.search).get("id") || "";
let profile = null;

const meta = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;

function render() {
  const m = profile.member;
  const s = profile.stats;
  const today = todayStr();

  document.title = m.name + " - IronWorks Gym";
  document.querySelector(".page-title h1").textContent = m.name;

  $("p-avatar").innerHTML = avatar(m, true);
  $("p-name").textContent = m.name;
  $("p-badges").innerHTML = badge(m.status) + ` <span class="${planClass(m.plan)}">${esc(m.plan)}</span>`;

  $("p-meta").innerHTML =
    meta("Member code", "#" + esc(m.code || "")) +
    meta("Phone", m.phone ? esc(m.phone) : '<span class="missing">Missing</span>') +
    meta("Membership ends", esc(m.end)) +
    meta("Joined", m.joinedOn ? esc(m.joinedOn) : "Before records began") +
    meta("Reminders", m.remind ? "On" : "Off");

  const note = $("p-note");
  note.hidden = true;
  if (m.status === "Frozen") {
    note.hidden = false;
    note.textContent = "Frozen since " + m.frozenSince + " (" + plural(daysBetween(m.frozenSince, today), "day") +
      "). Those days are added to the end date when you unfreeze.";
  } else if (m.status === "Cancelled") {
    note.hidden = false;
    note.textContent = "Cancelled on " + m.cancelledOn + ". Renewing reactivates this membership.";
  }

  const eid = encodeURIComponent(m.id);
  const can = m.status === "Active" || m.status === "Expiring";
  $("p-actions").innerHTML =
    (can ? '<button type="button" class="btn-success" data-act="checkin">Check in</button>' : "") +
    (m.status !== "Frozen" ? `<a class="btn" href="/members.html#renew=${eid}">Renew</a>` : "") +
    `<a class="btn btn-ghost" href="/members.html#edit=${eid}">Edit</a>` +
    (can ? '<button type="button" class="btn-ghost" data-act="freeze">Freeze</button>' : "") +
    (m.status === "Frozen" ? '<button type="button" class="btn-success" data-act="unfreeze">Unfreeze</button>' : "") +
    (m.status !== "Cancelled" ? '<button type="button" class="btn-danger" data-act="cancel">Cancel membership</button>' : "") +
    `<a class="btn btn-ghost" href="/cards.html?id=${eid}">Print card</a>` +
    (m.phone ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${esc(whatsapp(m.phone))}">WhatsApp</a>` : "");

  $("s-total").textContent = s.totalVisits;
  $("s-month").textContent = s.visitsLast30;
  $("s-last").textContent = m.lastVisit ? shortDate(m.lastVisit) : "Never";
  $("s-paid").textContent = money(s.totalPaidCents);

  $("p-payments-empty").hidden = profile.payments.length > 0;
  $("p-payments").innerHTML = profile.payments.map(p => `
    <tr>
      <td>${esc(p.paidOn)}</td><td>${money(p.amountCents)}</td>
      <td>${esc(METHOD_LABELS[p.method] || p.method)}</td><td>${esc(p.note || "")}</td>
      <td><a class="link-btn" href="/receipt.html?id=${encodeURIComponent(p.id)}">Receipt</a></td>
    </tr>`).join("");

  $("p-visits").innerHTML = profile.checkins.length
    ? profile.checkins.map(c => `<li class="list-item"><div class="list-main"><strong>${esc(shortDate(c.date))}</strong></div>
        <span class="time-chip">${esc(Gym.clock(c.time))}</span></li>`).join("")
    : '<li class="empty">No visits recorded yet.</li>';
}

async function load() {
  profile = await api("/api/members/" + encodeURIComponent(id) + "/profile");
  render();
}

$("p-actions").addEventListener("click", async function (e) {
  const button = e.target.closest("button[data-act]");
  if (!button) return;
  const m = profile.member;
  const url = "/api/members/" + encodeURIComponent(m.id);

  try {
    if (button.dataset.act === "checkin") {
      await send("POST", "/api/checkins", { memberId: m.id });
      toast(m.name + " checked in.", "success");
    } else if (button.dataset.act === "freeze") {
      if (!confirm("Freeze " + m.name + "'s membership? They cannot check in while it is frozen.")) return;
      await send("POST", url + "/freeze");
      toast("Membership frozen.", "success");
    } else if (button.dataset.act === "unfreeze") {
      const r = await send("POST", url + "/unfreeze");
      toast("Unfrozen. " + plural(r.daysAdded, "day") + " added, now ends " + r.end + ".", "success");
    } else if (button.dataset.act === "cancel") {
      if (!confirm("Cancel " + m.name + "'s membership? You can reactivate it later by renewing.")) return;
      await send("POST", url + "/cancel");
      toast("Membership cancelled.", "success");
    }
    await load();
  } catch (err) {
    toast(err.message, "error");
  }
});

(async function init() {
  try {
    await loadPlans();
    await load();
  } catch (err) {
    $("p-name").textContent = "Member not found";
    toast(err.message, "error");
  }
})();