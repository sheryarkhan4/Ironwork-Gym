const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");
const db = require("./db");

const KEEP = 14; // how many backups to keep
const dir = path.join(DATA_DIR, "backups");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(dir, "gym-" + stamp + ".db");

// VACUUM INTO writes a complete, consistent copy even while the app is running
db.prepare("VACUUM INTO ?").run(file);
console.log("Backup written: " + file);

fs.readdirSync(dir)
  .filter(name => /^gym-.*\.db$/.test(name))
  .sort()
  .reverse()
  .slice(KEEP)
  .forEach(name => fs.unlinkSync(path.join(dir, name)));