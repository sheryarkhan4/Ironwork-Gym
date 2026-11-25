const form = document.getElementById("login-form");
const errorBox = document.getElementById("login-error");
const loginBtn = document.getElementById("login-btn");

form.addEventListener("submit", async function (e) {
  e.preventDefault();
  errorBox.textContent = "";
  loginBtn.disabled = true;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    window.location.href = "/";
  } catch (err) {
    errorBox.textContent = err.message;
    document.getElementById("password").value = "";
    loginBtn.disabled = false;
  }
});