const { $, send, escapeHtml: esc, toast, plural } = Gym;

const MAX_BYTES = 900 * 1024;
let csvText = "";

function render(r) {
  $("summary").innerHTML =
    `<span class="badge Active">${r.ok} ready</span>` +
    `<span class="badge Expiring">${r.duplicates} duplicate${r.duplicates === 1 ? "" : "s"}</span>` +
    `<span class="badge Expired">${r.errors} problem${r.errors === 1 ? "" : "s"}</span>`;

  $("preview-wrap").hidden = r.rows.length === 0;
  $("truncated").hidden = !r.truncated;

  $("preview-body").innerHTML = r.rows.map(function (row) {
    const result = row.status === "ok"
      ? '<span class="badge Active">Ready</span>'
      : esc(row.message);
    return `
      <tr class="${row.status === "error" ? "row-error" : row.status === "duplicate" ? "row-duplicate" : ""}">
        <td>${row.line}</td><td>${esc(row.name)}</td><td>${esc(row.phone)}</td>
        <td>${esc(row.plan)}</td><td>${esc(row.end)}</td><td>${result}</td>
      </tr>`;
  }).join("");

  $("commit-btn").hidden = r.ok === 0;
  $("commit-btn").textContent = "Import " + plural(r.ok, "member");
  $("import-msg").textContent = r.ok
    ? "Check the table, then import. Rows with problems are skipped."
    : "Nothing can be imported from this file yet. Fix the problems below and choose it again.";
}

$("file").addEventListener("change", async function () {
  const file = this.files[0];
  $("summary").innerHTML = "";
  $("preview-body").innerHTML = "";
  $("preview-wrap").hidden = true;
  $("commit-btn").hidden = true;
  $("done-link").hidden = true;
  csvText = "";
  if (!file) return;

  if (file.size > MAX_BYTES) {
    $("import-msg").textContent = "That file is too large (900 KB at most). Split it into smaller files.";
    return;
  }
  if (/\.xlsx?$/i.test(file.name)) {
    $("import-msg").textContent = "That is an Excel file. Open it in Excel and use File, Save As, CSV UTF-8, then choose the CSV.";
    return;
  }

  try {
    csvText = await file.text();
    $("import-msg").textContent = "Checking...";
    render(await send("POST", "/api/import/members", { csv: csvText }));
  } catch (err) {
    $("import-msg").textContent = "Error: " + err.message;
  }
});

$("commit-btn").addEventListener("click", async function () {
  if (!csvText) return;
  if (!confirm("Import these members now?")) return;
  $("commit-btn").disabled = true;

  try {
    const r = await send("POST", "/api/import/members", { csv: csvText, commit: true });
    toast(plural(r.imported, "member") + " imported.", "success");
    $("import-msg").textContent = plural(r.imported, "member") + " imported. Importing the same file again will skip them.";
    $("commit-btn").hidden = true;
    $("done-link").hidden = false;
    $("file").value = "";
    csvText = "";
  } catch (err) {
    $("import-msg").textContent = "Error: " + err.message;
  } finally {
    $("commit-btn").disabled = false;
  }
});