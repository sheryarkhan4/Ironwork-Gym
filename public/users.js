let users = [];
let pwUserId = null;

const $ = id => document.getElementById(id);

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

function say(text) {
  $("user-msg").textContent = text;
}

async function loadUsers() {
  const response = await api("/api/users");
  if (!response.ok) throw new Error("Server returned " + response.status);
  users = await response.json();
  render();
}

function render() {
  $("users-body").innerHTML = users.map(function (u) {
    const id = escapeHtml(u.id);

    const roleCell = u.isSelf
      ? `<span class="role-badge">${escapeHtml(u.role)}</span> <small>(you)</small>`
      : `<select class="role-select" data-id="${id}">
           <option value="staff"${u.role === "staff" ? " selected" : ""}>Staff</option>
           <option value="admin"${u.role === "admin" ? " selected" : ""}>Admin</option>
         </select>`;

    const deleteButton = u.isSelf
      ? ""
      : `<button class="delete-btn remove-btn" data-id="${id}">Delete</button>`;

    return `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${roleCell}</td>
        <td>
          <button class="edit-btn reset-btn" data-id="${id}">Reset password</button>
          ${deleteButton}
        </td>
      </tr>`;
  }).join("");
}

// Create an account
$("user-form").addEventListener("submit", async function (e) {
  e.preventDefault();

  try {
    const response = await api("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("u-name").value,
        password: $("u-pass").value,
        role: $("u-role").value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    $("user-form").reset();
    say("Account created: " + data.username);
    await loadUsers();
  } catch (err) {
    say("Error: " + err.message);
  }
});

// Change a role (the dropdown in a row)
$("users-body").addEventListener("change", async function (e) {
  const select = e.target.closest(".role-select");
  if (!select) return;

  try {
    const response = await api("/api/users/" + encodeURIComponent(select.dataset.id) + "/role", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: select.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    say("Role updated.");
  } catch (err) {
    say("Error: " + err.message);
  }
  await loadUsers(); // redraw so the dropdowns always match the server
});

// Reset password / delete (buttons in a row)
$("users-body").addEventListener("click", async function (e) {
  const button = e.target.closest("button");
  if (!button) return;

  const user = users.find(u => u.id === button.dataset.id);
  if (!user) return;

  if (button.classList.contains("reset-btn")) {
    pwUserId = user.id;
    $("pw-title").textContent = "New password for " + user.username;
    $("pw-input").value = "";
    $("pw-error").textContent = "";
    $("pw-dialog").showModal();
    $("pw-input").focus();
    return;
  }

  if (button.classList.contains("remove-btn")) {
    if (!confirm("Delete the account \"" + user.username + "\"?")) return;

    try {
      const response = await api("/api/users/" + encodeURIComponent(user.id), { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      say("Account deleted: " + user.username);
      await loadUsers();
    } catch (err) {
      say("Error: " + err.message);
    }
  }
});

// Password dialog
$("pw-cancel").addEventListener("click", function () {
  $("pw-dialog").close();
});

$("pw-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  $("pw-error").textContent = "";

  try {
    const response = await api("/api/users/" + encodeURIComponent(pwUserId) + "/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("pw-input").value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    $("pw-input").value = "";
    $("pw-dialog").close();
    say("Password updated. That account was signed out of its other sessions.");
  } catch (err) {
    $("pw-error").textContent = err.message;
  }
});

// Log out
$("logout-btn").addEventListener("click", async function () {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

loadUsers().catch(function (err) {
  say("Could not load accounts: " + err.message);
});