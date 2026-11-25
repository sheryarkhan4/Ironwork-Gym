const { $, api, send, escapeHtml: esc, toast } = Gym;

async function loadPlans() {
  const plans = await api("/api/plans");

  $("plans-body").innerHTML = plans.map(p => `
    <tr data-id="${p.id}">
      <td><input class="inline-input" data-f="name" value="${esc(p.name)}" maxlength="30" aria-label="Plan name"></td>
      <td><input class="inline-input narrow-input" data-f="price" type="number" min="0.01" step="0.01" value="${(p.priceCents / 100).toFixed(2)}" aria-label="Price"></td>
      <td><input class="inline-input narrow-input" data-f="days" type="number" min="1" max="730" step="1" value="${p.days}" aria-label="Days"></td>
      <td>${p.members}</td>
      <td class="actions">
        <button class="edit-btn" data-act="save">Save</button>
        <button class="delete-btn" data-act="delete"${p.members ? ' disabled title="Move its members to another plan first"' : ""}>Delete</button>
      </td>
    </tr>`).join("");
}

$("plans-body").addEventListener("click", async function (e) {
  const button = e.target.closest("button[data-act]");
  if (!button) return;

  const row = button.closest("tr");
  const field = name => row.querySelector('[data-f="' + name + '"]').value;
  const url = "/api/plans/" + encodeURIComponent(row.dataset.id);

  try {
    if (button.dataset.act === "save") {
      await send("PUT", url, { name: field("name"), price: field("price"), days: Number(field("days")) });
      toast("Plan saved.", "success");
    } else {
      if (!confirm("Delete this plan?")) return;
      await send("DELETE", url);
      toast("Plan deleted.", "success");
    }
    await loadPlans();
  } catch (err) {
    toast(err.message, "error");
  }
});

$("plan-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  $("plan-msg").textContent = "";

  try {
    await send("POST", "/api/plans", {
      name: $("np-name").value,
      price: $("np-price").value,
      days: Number($("np-days").value)
    });
    $("plan-form").reset();
    $("np-days").value = 30;
    toast("Plan added.", "success");
    await loadPlans();
  } catch (err) {
    $("plan-msg").textContent = "Error: " + err.message;
  }
});

function fillSettings(s) {
  $("s-name").value = s.gymName;
  $("s-pass").value = (s.dayPassCents / 100).toFixed(2);
  $("s-quiet").value = s.inactiveDays;
}

$("settings-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  $("settings-msg").textContent = "";

  try {
    fillSettings(await send("PUT", "/api/settings", {
      gymName: $("s-name").value,
      dayPassPrice: $("s-pass").value,
      inactiveDays: Number($("s-quiet").value)
    }));
    toast("Settings saved.", "success");
  } catch (err) {
    $("settings-msg").textContent = "Error: " + err.message;
  }
});

(async function init() {
  try {
    fillSettings(await api("/api/settings"));
    await loadPlans();
  } catch (err) {
    toast("Could not load settings: " + err.message, "error");
  }
})();