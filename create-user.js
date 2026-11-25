const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const [username, password, roleArg] = process.argv.slice(2);

if (!username || !password) {
  console.log("Usage: node create-user.js <username> <password> [admin|staff]");
  process.exit(1);
}
if (!/^[a-z0-9._-]{3,30}$/.test(username.trim().toLowerCase())) {
  console.log("Username must be 3-30 characters: letters, numbers, dot, dash, underscore.");
  process.exit(1);
}
if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
  console.log("Password must be 8 characters or more, and at most 72 bytes.");
  process.exit(1);
}
if (roleArg && !["admin", "staff"].includes(roleArg)) {
  console.log("Role must be admin or staff.");
  process.exit(1);
}

const name = username.trim().toLowerCase();
const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(name);

if (existing) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, existing.id);
  if (roleArg) {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(roleArg, existing.id);
  }
  console.log("Updated " + name + (roleArg ? " (role: " + roleArg + ")" : ""));
} else {
  const role = roleArg || "admin";
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), name, hash, role);
  console.log("Created " + name + " (role: " + role + ")");
}