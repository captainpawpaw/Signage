// Quiet: the few behaviours CSS cannot do alone. Load with <script src="quiet.js" defer></script>.
//   quiet.say(text)           one line of feedback that leaves by itself
//   quiet.busy(button, work)  the button breathes while the promise runs
//   data-confirm="Sure?"      on a button: the first click swaps its text, the second does the action
//   data-chrome               on any element: it fades out after a few idle seconds (set data-idle="0" on <html> to opt out)
(() => {
  const root = document.documentElement;
  const IDLE_MS = Number(root.dataset.idle ?? 2500);

  let idleTimer;
  const wake = () => {
    root.classList.remove('q-idle');
    clearTimeout(idleTimer);
    if (IDLE_MS > 0) idleTimer = setTimeout(() => root.classList.add('q-idle'), IDLE_MS);
  };
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'focusin']) {
    addEventListener(type, wake, { passive: true });
  }
  wake();

  let toast, toastTimer;
  function say(text, ms = 2200) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'q-toast';
      toast.setAttribute('role', 'status');
      document.body.append(toast);
    }
    toast.textContent = text;
    toast.classList.add('q-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('q-on'), ms);
  }

  async function busy(button, work) {
    button.setAttribute('aria-busy', 'true');
    try { return await work(); } finally { button.removeAttribute('aria-busy'); }
  }

  // Runs in the capture phase so the app's own click handler only sees the second click.
  addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-confirm]');
    if (!btn) return;
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    btn.dataset.label = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = btn.dataset.confirm || 'Sure?';
    setTimeout(() => {
      if (!btn.dataset.armed) return;
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.label;
    }, 3000);
  }, true);

  window.quiet = { say, busy };
})();
