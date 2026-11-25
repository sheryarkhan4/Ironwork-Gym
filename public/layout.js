// Builds the sidebar and the top bar around every page.
// A page only needs <body data-page data-title data-subtitle> and a <div id="content">.
(function () {
  "use strict";

  const content = document.getElementById("content");
  if (!content) return;

  const body = document.body;
  const page = body.dataset.page || "";

  // New styles live in features.css; make sure every page gets them
  if (!document.querySelector('link[href$="features.css"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "features.css";
    document.head.appendChild(l);
  }

  const svg = inner =>
    '<svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";

  const ICON = {
    brand: svg('<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>'),
    dashboard: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
    checkin: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>'),
    members: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    payments: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>'),
    reminders: svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    reports: svg('<path d="M3 3v18h18"/><path d="M7 15v3M12 9v9M17 5v13"/>'),
    users: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
    settings: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>'),
    import: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
    audit: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>'),
    logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
    moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>')
  };

  const MENU = [
    { id: "dashboard", href: "/", label: "Dashboard" },
    { id: "checkin", href: "/checkin.html", label: "Check-in" },
    { id: "members", href: "/members.html", label: "Members" },
    { id: "payments", href: "/payments.html", label: "Payments" },
    { id: "reminders", href: "/reminders.html", label: "Reminders" },
    { id: "reports", href: "/reports.html", label: "Reports" }
  ];

  const ADMIN = [
    { id: "users", href: "/users.html", label: "Staff" },
    { id: "settings", href: "/settings.html", label: "Plans & settings" },
    { id: "import", href: "/import.html", label: "Import" },
    { id: "audit", href: "/audit.html", label: "Audit log" }
  ];

  function link(item, adminOnly) {
    const active = item.id === page;
    return '<a class="nav-item' + (active ? " is-active" : "") + '" href="' + item.href + '"' +
      (active ? ' aria-current="page"' : "") + (adminOnly ? " data-admin hidden" : "") + ">" +
      ICON[item.id] + "<span>" + item.label + "</span></a>";
  }

  const shell = document.createElement("div");
  shell.className = "app";
  shell.innerHTML =
    '<div class="scrim" id="scrim"></div>' +
    '<aside class="sidebar" id="sidebar" aria-label="Main navigation">' +
      '<a class="brand" href="/"><span class="brand-mark">' + ICON.brand + '</span>' +
        '<span class="brand-name">Iron<b>Works</b></span></a>' +
      '<nav class="nav" aria-label="Pages">' +
        '<p class="nav-label">Menu</p>' + MENU.map(i => link(i, false)).join("") +
        '<p class="nav-label" data-admin hidden>Admin</p>' + ADMIN.map(i => link(i, true)).join("") +
      "</nav>" +
      '<div class="sidebar-foot">' +
        '<a class="user-card' + (page === "account" ? " is-active" : "") + '" href="/account.html" title="My account">' +
          '<span class="user-avatar" id="user-avatar">..</span>' +
          '<span class="user-meta"><strong id="current-user">Loading...</strong><small id="current-role"></small></span>' +
        "</a>" +
        '<button type="button" class="nav-item nav-button" data-theme-toggle>' +
          '<span class="show-light">' + ICON.moon + "<span>Dark mode</span></span>" +
          '<span class="show-dark">' + ICON.sun + "<span>Light mode</span></span>" +
        "</button>" +
        '<button type="button" class="nav-item nav-button" id="logout-btn">' + ICON.logout + "<span>Log out</span></button>" +
      "</div>" +
    "</aside>" +
    '<div class="main">' +
      '<header class="topbar">' +
        '<button type="button" class="menu-btn" id="menu-btn" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false">' + ICON.menu + "</button>" +
        '<div class="page-title"><h1></h1><p></p></div>' +
        '<div class="topbar-right"><span class="date-chip" id="date-chip"></span></div>' +
      "</header>" +
      '<main class="content" id="page-content"></main>' +
    "</div>";

  shell.querySelector(".page-title h1").textContent = body.dataset.title || document.title;
  shell.querySelector(".page-title p").textContent = body.dataset.subtitle || "";
  shell.querySelector("#date-chip").textContent =
    new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const slot = shell.querySelector("#page-content");
  while (content.firstChild) slot.appendChild(content.firstChild);
  body.insertBefore(shell, content);
  content.remove();
  body.classList.add("has-layout");

  const menuBtn = document.getElementById("menu-btn");
  function setNav(open) {
    body.classList.toggle("nav-open", open);
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  menuBtn.addEventListener("click", () => setNav(!body.classList.contains("nav-open")));
  document.getElementById("scrim").addEventListener("click", () => setNav(false));
  document.addEventListener("keydown", e => { if (e.key === "Escape") setNav(false); });

  document.getElementById("logout-btn").addEventListener("click", async function (e) {
    e.stopImmediatePropagation();
    try { await fetch("/api/logout", { method: "POST" }); } catch (err) { /* leave anyway */ }
    window.location.href = "/login.html";
  });

  fetch("/api/me")
    .then(function (response) {
      if (response.status === 401) { window.location.href = "/login.html"; return null; }
      return response.ok ? response.json() : null;
    })
    .then(function (me) {
      if (!me) return;
      document.getElementById("current-user").textContent = me.username;
      document.getElementById("current-role").textContent = me.role === "admin" ? "Administrator" : "Staff";
      document.getElementById("user-avatar").textContent = me.username.slice(0, 2).toUpperCase();
      if (me.role === "admin") document.querySelectorAll("[data-admin]").forEach(el => { el.hidden = false; });
    })
    .catch(function () { /* the page's own script reports connection problems */ });

  // Clicking the dimmed area behind a pop-up closes it
  document.addEventListener("click", function (e) {
    if (e.target instanceof HTMLDialogElement && e.target.open) e.target.close();
  });

  const toasts = document.createElement("div");
  toasts.className = "toasts";
  toasts.setAttribute("aria-live", "polite");
  body.appendChild(toasts);

  window.gymToast = function (message, kind) {
    const el = document.createElement("div");
    el.className = "toast " + (kind || "info");
    el.textContent = message;
    toasts.appendChild(el);
    setTimeout(function () {
      el.classList.add("out");
      setTimeout(() => el.remove(), 300);
    }, kind === "error" ? 6000 : 3800);
  };
})();