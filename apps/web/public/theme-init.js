// Apply the saved theme (or the system one) before first paint to avoid a flash.
// Loaded as a blocking same-origin script by local.html, whose server CSP (script-src 'self')
// forbids inline scripts. Same key as index.html and src/lib/theme.ts.
(function () {
  var theme;
  try {
    theme = localStorage.getItem('mcp-theme');
  } catch {
    // Storage unavailable: fall back to the system theme.
  }
  if (theme !== 'light' && theme !== 'dark')
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
