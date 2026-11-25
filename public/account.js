const $ = id => document.getElementById(id);

async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Please log in");
  }
  return response;
}

function say(text, good) {
  $("pw-msg").textContent = text;
  $("pw-msg").style.color = good ? "#2f9e44" : "";
}

$("pw-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  say("");

  if ($("next").value !== $("again").value) return say("The new passwords do not match");

  try {
    const response = await api("/api/me/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: $("current").value, newPassword: $("next").value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    $("pw-form").reset();
    say("Password changed. You were signed out of your other devices.", true);
  } catch (err) {
    say(err.message);
  }
});

$("logout-btn").addEventListener("click", async function () {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

api("/api/me").then(r => r.json()).then(me => {
  $("who").textContent = "Signed in as " + me.username + " (" + me.role + ")";
});