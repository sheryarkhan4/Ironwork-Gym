// Loaded in <head> so the saved theme is applied before the page is drawn
// (no flash of the wrong colors). Any element with data-theme-toggle flips it.
(function () {
  var KEY = "gym-theme";

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function current() {
    return document.documentElement.dataset.theme;
  }

  document.documentElement.dataset.theme = saved() || (systemPrefersDark() ? "dark" : "light");

  // One listener on the whole document, so buttons created later (the sidebar) work too
  document.addEventListener("click", function (e) {
    var button = e.target.closest("[data-theme-toggle]");
    if (!button) return;

    var next = current() === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (err) {}
    document.documentElement.dataset.theme = next;
    window.dispatchEvent(new Event("themechange"));
  });
})();