// Applied before first paint to avoid a theme flash (kept external for the CSP).
try {
  const t = localStorage.getItem('aw-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* storage unavailable */
}
