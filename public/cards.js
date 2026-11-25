const { $, api, escapeHtml: esc, avatar, toast } = Gym;

const onlyId = new URLSearchParams(location.search).get("id");
let members = [];
let gym = "IronWorks Gym";

function cardHtml(m) {
  let bars = "";
  try {
    // Stretch sideways only: every bar keeps the same proportion, so it still scans
    bars = Barcode.svg(m.code).replace("<svg ", '<svg preserveAspectRatio="none" ');
  } catch (err) { /* a member without a usable code gets a card without bars */ }

  return `
    <article class="id-card">
      <header>${esc(gym)}<span>MEMBER</span></header>
      <div class="id-body">
        ${avatar(m)}
        <div><strong>${esc(m.name)}</strong><small>${esc(m.plan)} plan</small></div>
      </div>
      <div class="id-code">${bars}<span>${esc(m.code || "")}</span></div>
    </article>`;
}

function render() {
  let list = members.filter(m => m.status !== "Cancelled");

  if (onlyId) {
    list = members.filter(m => m.id === onlyId);
    $("which").hidden = true;
  } else if ($("which").value === "current") {
    list = list.filter(m => m.status === "Active" || m.status === "Expiring");
  }

  $("cards-note").textContent = list.length
    ? list.length + (list.length === 1 ? " card" : " cards") + " ready. Use your browser's print dialog and choose A4, margins: default."
    : "No members to print.";
  $("sheet").innerHTML = list.map(cardHtml).join("");
}

$("which").addEventListener("change", render);
$("print-btn").addEventListener("click", () => window.print());

(async function init() {
  try {
    const [list, settings] = await Promise.all([api("/api/members"), api("/api/settings")]);
    members = list;
    gym = settings.gymName;
    render();
  } catch (err) {
    toast("Could not load members: " + err.message, "error");
  }
})();