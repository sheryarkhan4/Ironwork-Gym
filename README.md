# IronWorks Gym

A gym management web app: members, check-ins, payments, renewal reminders, reports and staff accounts, with a dashboard and barcode member cards. It runs on Node.js with a SQLite database and plain HTML, CSS and JavaScript on the front end. Amounts are in Pakistani rupees (PKR).

## Features

- **Dashboard** with KPI cards, check-in, plan and revenue charts, an "expiring soon" list, recent check-ins and members who have stopped coming
- **Members**: add, edit, delete, search, filter by status, optional photo, phone number (required), reminder opt-out
- **Member profile**: visits, payments, freeze, unfreeze and cancel a membership
- **Renewals**: extend a membership and record the payment in one step
- **Quick check-in**: by name, phone or member code, with USB barcode scanners and camera scanning
- **Day passes** for walk-in visitors
- **Barcode member cards** (Code 128) for printing
- **Payments**: cash, Easypaisa, JazzCash, card, bank transfer or other, with printable receipts
- **Reminders**: members who are about to expire, with a WhatsApp button or fully automatic sending
- **Reports**: monthly revenue, revenue by plan and method, a peak-hours heatmap, new members, renewals and lapses
- **Plans and settings**: editable plans and prices, gym name, day pass price
- **CSV import** (with a preview) and **CSV export**
- **Staff accounts** with two roles (admin and staff), a change-password page and an **audit log**
- Light and dark theme, and a layout that works on phones

## Requirements

- **Node.js 24 or newer.** The app uses Node's built-in SQLite module (`node:sqlite`).
- A modern browser. Camera scanning needs Chrome, Edge or an Android browser, and a `localhost` or HTTPS address.

Check your version with `node -v`.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your first admin account (choose your own password, 8+ characters)
node create-user.js admin YourPasswordHere

# 3. Start the app
npm start
```

Open <http://localhost:3000> and log in.

The database file (`gym.db`) is created on the first start. If you are upgrading an older database, the app migrates it automatically, so **make a backup first** (see [Backups](#backups)).

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Starts the server and reads settings from `.env` |
| `npm test` | Runs the automated tests (they use a temporary database, never your real one) |
| `node create-user.js <username> <password> [admin\|staff]` | Creates an account, or resets the password of an existing one |
| `node backup.js` | Writes a consistent copy of the database to `backups/` and keeps the newest 14 |

Note: `node server.js` also starts the app, but it does **not** read `.env`. Use `npm start`.

## Configuration

Settings go in a `.env` file in the project root. It is optional. Without it, the app runs with the defaults below.

```ini
# Reminders: manual (default), webhook or twilio
REMINDER_PROVIDER=manual
GYM_NAME=IronWorks Gym
DEFAULT_COUNTRY_CODE=92
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on (keep it local behind a reverse proxy) |
| `NODE_ENV` | | Set to `production` for secure cookies and HSTS (needs HTTPS) |
| `DATA_DIR` | project folder | Where `gym.db`, `backups/` and `.session-secret` are kept |
| `SESSION_SECRET` | generated once | Signs login cookies. Created automatically in `DATA_DIR` if unset |
| `DEFAULT_COUNTRY_CODE` | `92` | Used to turn `0300 1234567` into `+923001234567` |
| `GYM_NAME` | `IronWorks Gym` | Default gym name until it is changed under Plans & settings |

### Reminders

Members get a reminder 7 and 1 days before their membership ends, once per expiry.

| `REMINDER_PROVIDER` | Behaviour | Extra settings |
|---|---|---|
| `manual` (default) | The Reminders page lists who is due, with a pre-written WhatsApp link per member | none |
| `webhook` | The app POSTs each message to your gateway | `REMINDER_WEBHOOK_URL`, optional `REMINDER_WEBHOOK_TOKEN` |
| `twilio` | Sends SMS, or WhatsApp if `TWILIO_FROM` starts with `whatsapp:` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |

Optional tuning: `REMINDER_DAYS` (default `7,1`), `REMINDER_FROM_HOUR` (`10`), `REMINDER_TO_HOUR` (`19`) and `REMINDER_TEMPLATE`. The template accepts `{name}`, `{gym}`, `{when}`, `{date}` and `{days}`.

The webhook receives JSON: `{ "to": "+923001234567", "message": "...", "name": "...", "endDate": "2026-12-01", "daysLeft": 3 }`, and any 2xx reply counts as sent. Automatic sending needs an account with a messaging provider. Check its pricing and rules first.

## Who can do what

| | Staff | Admin |
|---|---|---|
| View, add and edit members, renew, freeze, cancel | Yes | Yes |
| Check in members, sell day passes | Yes | Yes |
| Record payments, print receipts | Yes | Yes |
| View reports and the reminder list | Yes | Yes |
| Delete members, void payments | | Yes |
| Export CSV, import members | | Yes |
| Staff accounts, audit log | | Yes |
| Edit plans and settings, run reminders | | Yes |

The browser hides buttons a user cannot use, but the server enforces every rule on its own.

## Project structure

```
server.js            Express app and every API route
db.js                SQLite schema, migrations and database rules
lib.js               Pure helpers (dates, money, phones, CSV)
settings.js          Gym name, day pass price, inactive-days setting
reminders.js         Reminder logic and the scheduler
session-store.js     Stores login sessions in SQLite
config.js            Reads environment variables
create-user.js       Command-line tool to create or reset an account
backup.js            Command-line tool to back up the database
tests/               Automated tests
public/              Everything the browser loads
  *.html             One page per screen
  *.js               One script per page, plus shared code:
                       layout.js (sidebar and top bar), common.js (helpers),
                       theme.js (light and dark), barcode.js (Code 128)
  style.css          Main styles
  features.css       Styles for the newer pages
```

The files in the project root named `reminders.js` and `settings.js` are server code. The files with the same names in `public/` are the page scripts.

## Data and backups

All data lives in **`gym.db`** (plus the helper files `gym.db-shm` and `gym.db-wal`). Money is stored as whole paisa, so there are no rounding errors. Photos are stored in the database, so a backup includes them.

### Backups

```bash
node backup.js
```

Copy the newest file in `backups/` somewhere off the machine regularly, because a backup on the same disk does not protect you from losing the disk. Backups contain personal data and password hashes, so keep them private.

To restore, stop the app, copy a backup over `gym.db` and delete `gym.db-shm` and `gym.db-wal`.

## Tests

```bash
npm test
```

The tests cover logins and permissions, members and phone rules, check-ins, renewals and payments, freezing and cancelling, day passes, reports, CSV import and export, reminders, barcodes, and the database upgrades from older versions. Run them after any change.

## Security notes

- **Never commit** `gym.db`, `gym.db-shm`, `gym.db-wal`, `.session-secret`, `.env`, `backups/` or old JSON data files. The `.gitignore` already lists them, but a file that was committed before it was ignored stays tracked until you run `git rm --cached`.
- Passwords are hashed with bcrypt. Five failed logins lock a username for 15 minutes.
- Use **HTTPS** for anything beyond your own computer. Without it, passwords and login cookies travel in the clear.
- The security headers (helmet) only allow scripts from the app's own server. Chart.js is served from `node_modules`, so there are no third-party scripts.
- Staff and member data is personal data. Only keep what you need, and follow the privacy rules where you operate.

## Deploying

The app is a single Node process with a database file, so it suits one small server.

1. Install Node 24, copy the project, run `npm ci --omit=dev`.
2. Set `NODE_ENV=production`, `DATA_DIR` (a folder that survives restarts) and `TZ=Asia/Karachi`. The timezone decides which day counts as "today" and when reminders may be sent.
3. Run it as a service (for example with systemd) as an unprivileged user.
4. Put a reverse proxy such as Caddy in front of it for HTTPS, forwarding to `127.0.0.1:3000`.
5. Schedule `node backup.js` nightly and copy the backups off the server.

Pick a host with a **persistent disk**. A platform that wipes its filesystem on each deploy would delete your database.

## Troubleshooting

| Problem | What to check |
|---|---|
| `Cannot find module './something'` | A file was not copied into the project. The name in the error is the missing file |
| Page is blank or unstyled | Hard-refresh with Ctrl+Shift+R. Confirm `layout.js`, `common.js` and `features.css` are in `public/` |
| Dark mode does nothing | `public/theme.js` is missing or in the wrong folder |
| Can't log in | Reset the password with `node create-user.js <username> <newpassword>` |
| "Too many failed attempts" | Wait 15 minutes, or restart the server |
| Settings in `.env` ignored | Start with `npm start`, not `node server.js` |
| Login does nothing in production | `NODE_ENV=production` needs `https://`. Secure cookies are not sent over plain HTTP |
| A test fails with a 500 on a page | The page file is missing from `public/` (the server's error names it) |

## Known limits

- One server and one database file. There is no multi-server setup.
- No two-factor login.
- CSV import only. Save Excel files as CSV UTF-8 first.
- Reminders are not delivered automatically until you set up a gateway. There is no delivery receipt, so "sent" means the gateway accepted the message.
- Not yet built: refunds beyond voiding a payment, part payments and balances, classes and trainer bookings.

## License

Private project. All rights reserved.