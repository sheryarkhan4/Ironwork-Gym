const { $, api, escapeHtml: esc, money, METHOD_LABELS, toast } = Gym;

const id = new URLSearchParams(location.search).get("id") || "";

$("print-btn").addEventListener("click", () => window.print());

(async function init() {
  try {
    const p = await api("/api/payments/" + encodeURIComponent(id));
    document.title = "Receipt " + p.receiptNo;

    $("receipt").innerHTML = `
      <h2>${esc(p.gymName)}</h2>
      <p class="sub">Payment receipt</p>
      <dl>
        <div class="line"><dt>Receipt no.</dt><dd>${esc(p.receiptNo)}</dd></div>
        <div class="line"><dt>Date</dt><dd>${esc(p.paidOn)}</dd></div>
        <div class="line"><dt>Received from</dt><dd>${esc(p.memberName)}</dd></div>
        <div class="line"><dt>Method</dt><dd>${esc(METHOD_LABELS[p.method] || p.method)}</dd></div>
        ${p.note ? `<div class="line"><dt>For</dt><dd>${esc(p.note)}</dd></div>` : ""}
        <div class="line"><dt>Received by</dt><dd>${esc(p.recordedBy)}</dd></div>
      </dl>
      <div class="total"><span>Total</span><span>${esc(money(p.amountCents))}</span></div>
      <p class="thanks">Thank you!</p>`;
  } catch (err) {
    $("receipt").innerHTML = '<p class="sub">' + esc(err.message) + "</p>";
    toast(err.message, "error");
  }
})();