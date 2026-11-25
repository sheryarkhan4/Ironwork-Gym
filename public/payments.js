const { $, api, send, escapeHtml: esc, money, METHOD_LABELS, todayStr, toast } = Gym;

let isAdmin = false;
const say = text => { $("pay-msg").textContent = text; };

async function loadMembers() {
  const list = await api("/api/members");
  $("p-member").innerHTML = '<option value="">Choose a member...</option>' +
    list.map(m => `<option value="${esc(m.id)}">${esc(m.name)} (#${esc(m.code || "")})</option>`).join("");
}

async function loadPayments() {
  const month = $("month").value;
  if (!month) return;

  const data = await api("/api/payments?month=" + encodeURIComponent(month));

  $("month-total").textContent = money(data.totalCents);
  $("pay-empty").hidden = data.rows.length > 0;
  $("export-payments").href = "/api/export/payments.csv?month=" + encodeURIComponent(month);

  $("pay-body").innerHTML = data.rows.map(function (p) {
    const who = p.memberId
      ? `<a class="name-link" href="/member.html?id=${encodeURIComponent(p.memberId)}">${esc(p.memberName)}</a>`
      : esc(p.memberName);
    const voidBtn = isAdmin ? `<button class="delete-btn" data-id="${esc(p.id)}">Void</button>` : "";

    return `
      <tr>
        <td>${esc(p.paidOn)}</td>
        <td>${who}</td>
        <td>${money(p.amountCents)}</td>
        <td>${esc(METHOD_LABELS[p.method] || p.method)}</td>
        <td>${esc(p.note || "")}</td>
        <td>${esc(p.recordedBy)}</td>
        <td class="actions"><a class="link-btn" href="/receipt.html?id=${encodeURIComponent(p.id)}">Receipt</a> ${voidBtn}</td>
      </tr>`;
  }).join("");
}

$("pay-form").addEventListener("submit", async function (e) {
  e.preventDefault();

  try {
    await send("POST", "/api/payments", {
      memberId: $("p-member").value,
      amount: $("p-amount").value,
      paidOn: $("p-date").value,
      method: $("p-method").value,
      note: $("p-note").value
    });

    $("p-amount").value = "";
    $("p-note").value = "";
    say("");
    toast("Payment recorded.", "success");
    $("month").value = $("p-date").value.slice(0, 7); // show the month it landed in
    await loadPayments();
  } catch (err) {
    say("Error: " + err.message);
  }
});

$("pay-body").addEventListener("click", async function (e) {
  const button = e.target.closest(".delete-btn");
  if (!button) return;
  if (!confirm("Void this payment? This cannot be undone.")) return;

  try {
    await send("DELETE", "/api/payments/" + encodeURIComponent(button.dataset.id));
    toast("Payment voided.", "success");
    await loadPayments();
  } catch (err) {
    toast(err.message, "error");
  }
});

$("month").addEventListener("change", () => loadPayments().catch(err => say("Error: " + err.message)));

(async function init() {
  try {
    const me = await api("/api/me");
    isAdmin = me.role === "admin";
    $("export-payments").hidden = !isAdmin;

    $("p-date").value = todayStr();
    $("month").value = todayStr().slice(0, 7);

    await loadMembers();
    await loadPayments();
  } catch (err) {
    say("Could not load: " + err.message);
  }
})();