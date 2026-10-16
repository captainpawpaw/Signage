// Signage admin console: a dependency-free single-page app over the REST API.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const view = document.getElementById('view');
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
let info = null;
let refreshTimer = null;

// ---------- helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  if (res.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('Login required'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

const guard = (fn) => async (...args) => { try { await fn(...args); } catch (err) { if (err.message !== 'Login required') toast(err.message); } };

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function openModal(...content) {
  modalBody.replaceChildren(...content);
  if (!modal.open) modal.showModal();
}
const closeModal = () => modal.close();

function thumb(media) {
  if (!media) return h('div', { class: 'thumb' }, 'missing');
  const src = media.type === 'deck' ? (media.pages?.[0] && `/files/${media.pages[0]}`) : `/files/${media.file}`;
  let inner;
  if (media.status !== 'ready') inner = h('span', {}, media.status === 'error' ? 'Conversion failed' : 'Converting…');
  else if (media.type === 'video') inner = h('video', { src: `${src}#t=0.5`, preload: 'metadata', muted: true });
  else inner = h('img', { src, loading: 'lazy', alt: '' });
  const label = media.type === 'deck' && media.pages ? `deck · ${media.pages.length}p` : media.type;
  return h('div', { class: 'thumb' }, inner, h('span', { class: 'badge' }, label));
}

// ---------- auth ----------
function showLogin() {
  clearInterval(refreshTimer);
  document.getElementById('app').hidden = true;
  document.getElementById('login').hidden = false;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  try {
    await api('POST', '/api/login', { password: e.target.password.value });
    e.target.reset();
    err.textContent = '';
    boot();
  } catch (ex) { err.textContent = ex.message; }
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  showLogin();
});

// ---------- router ----------
const routes = [
  [/^#\/screens$/, screensView],
  [/^#\/media$/, mediaView],
  [/^#\/playlists$/, playlistsView],
  [/^#\/playlists\/(.+)$/, playlistEditor],
  [/^#\/settings$/, settingsView],
];

async function route() {
  clearInterval(refreshTimer);
  const hash = location.hash || '#/screens';
  const section = hash.split('/')[1];
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  for (const [re, fn] of routes) {
    const m = re.exec(hash);
    if (m) { await guard(fn)(...m.slice(1)); return; }
  }
  location.hash = '#/screens';
}

async function boot() {
  try { info = await api('GET', '/api/info'); } catch { showLogin(); return; }
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  route();
}

window.addEventListener('hashchange', route);
boot();

// ---------- screens ----------
async function screensView() {
  const [screens, playlists] = await Promise.all([api('GET', '/api/screens'), api('GET', '/api/playlists')]);
  const plName = (pid) => playlists.find((p) => p.id === pid)?.name || '—';

  const card = (s) => {
    const st = s.status;
    const showing = st.online && st.itemCount ? `item ${st.index + 1} of ${st.itemCount}` : st.online ? 'idle' : '—';
    return h('div', { class: 'card screen-card' },
      h('div', { class: 'screen-head' },
        h('span', { class: `dot ${st.online ? 'on' : ''}`, title: st.online ? 'Online' : 'Offline' }),
        h('h3', { title: s.name }, s.name),
        h('span', { class: 'muted' }, st.online ? 'online' : `seen ${ago(s.lastSeen)}`)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Location'), h('dd', {}, s.location || '—'),
        h('dt', {}, 'Now playing'), h('dd', {}, plName(s.activePlaylistId), s.activeRuleId ? h('span', { class: 'muted' }, ' (scheduled)') : ''),
        h('dt', {}, 'Progress'), h('dd', {}, showing),
        h('dt', {}, 'Display'), h('dd', {}, st.display ? `${st.display.width}×${st.display.height} · ${s.settings.orientation}` : s.settings.orientation),
        h('dt', {}, 'Address'), h('dd', {}, st.ip || '—')),
      h('div', { class: 'actions' },
        h('button', { class: 'small', onclick: () => screenEditor(s, playlists) }, 'Edit'),
        h('button', { class: 'small', onclick: () => extensionDialog(s) }, 'Add-on'),
        h('button', { class: 'small', onclick: guard(() => preview(s)) }, 'Preview'),
        h('button', { class: 'small', disabled: !st.online, onclick: guard(() => command(s, 'identify')) }, 'Identify'),
        h('button', { class: 'small', disabled: !st.online, onclick: guard(() => command(s, 'next')) }, 'Skip'),
        h('button', { class: 'small', disabled: !st.online, onclick: guard(() => command(s, 'reload')) }, 'Reload')));
  };

  view.replaceChildren(
    h('div', { class: 'toolbar' },
      h('h1', {}, 'Screens'),
      h('button', { class: 'primary', onclick: () => screenEditor(null, playlists) }, '+ Add screen')),
    screens.length
      ? h('div', { class: 'grid' }, screens.map(card))
      : h('div', { class: 'card empty' }, 'No screens yet. Add one, then download its add-on onto the PC that drives the display.'));

  refreshTimer = setInterval(guard(async () => {
    if (location.hash !== '#/screens' && location.hash !== '') return;
    const fresh = await api('GET', '/api/screens');
    const grid = view.querySelector('.grid');
    if (grid && fresh.length === screens.length) grid.replaceChildren(...fresh.map(card));
    else if (fresh.length !== screens.length) screensView();
  }), 5000);
}

async function command(s, cmd) {
  const { delivered } = await api('POST', `/api/screens/${s.id}/command`, { command: cmd });
  toast(delivered ? `Sent “${cmd}” to ${s.name}` : `${s.name} is offline`);
}

async function preview(s) {
  const { url } = await api('GET', `/api/screens/${s.id}/preview-url`);
  const isLocal = (u) => /\/\/(localhost|127\.|\[::1\])/.test(u);
  const base = s.serverUrl || info.publicUrl || location.origin;
  const input = h('input', { value: base.replace(/\/+$/, '') + url, readonly: true, onfocus: (e) => e.target.select() });
  const copy = async () => {
    try { await navigator.clipboard.writeText(input.value); toast('Link copied'); } catch { input.focus(); document.execCommand('copy'); toast('Link copied'); }
  };
  openModal(
    h('h1', {}, `Preview ${s.name}`),
    h('p', {}, 'Open this link in any browser (PC, phone or tablet) to run this screen’s player without the add-on. Tap the page to go fullscreen.'),
    h('label', {}, 'Player link', input),
    isLocal(input.value) && h('p', { class: 'error' }, 'This link uses localhost, which only works on this PC. For a phone, set the screen’s Server URL (Edit) to this PC’s network address, e.g. http://192.168.1.20:8080.'),
    h('p', { class: 'hint' }, 'The link contains the screen’s access token — share it only with devices you trust. Over plain http, phones can’t store content for offline playback; the add-on and https setups can.'),
    h('div', { class: 'modal-actions' },
      h('button', { onclick: closeModal }, 'Close'),
      h('button', { onclick: copy }, 'Copy link'),
      h('button', { class: 'primary', onclick: () => window.open(url, `preview-${s.id}`, 'width=960,height=540') }, 'Open here')));
}

function scheduleTable(rules, playlists, activeRuleId) {
  const tbody = h('tbody');
  const row = (r) => {
    const tr = h('tr', { class: r.id && r.id === activeRuleId ? 'active-rule' : '' });
    tr.rule = r;
    const days = h('div', { class: 'days' }, DAYS.map((d, i) => h('label', {}, d[0], h('input', {
      type: 'checkbox', checked: !r.days?.length || r.days.includes(i), onchange: (e) => {
        const set = new Set(r.days?.length ? r.days : [0, 1, 2, 3, 4, 5, 6]);
        e.target.checked ? set.add(i) : set.delete(i);
        r.days = [...set].sort();
      },
    }))));
    tr.append(
      h('td', {}, h('input', { type: 'checkbox', checked: r.enabled !== false, title: 'Enabled', onchange: (e) => { r.enabled = e.target.checked; } })),
      h('td', {}, h('select', { onchange: (e) => { r.playlistId = e.target.value; } },
        playlists.map((p) => h('option', { value: p.id, selected: p.id === r.playlistId }, p.name)))),
      h('td', {}, days),
      h('td', {}, h('input', { type: 'time', value: r.start || '00:00', onchange: (e) => { r.start = e.target.value; } })),
      h('td', {}, h('input', { type: 'time', value: r.end || '00:00', onchange: (e) => { r.end = e.target.value; } })),
      h('td', {}, h('input', { type: 'date', value: r.startDate || '', onchange: (e) => { r.startDate = e.target.value || null; } })),
      h('td', {}, h('input', { type: 'date', value: r.endDate || '', onchange: (e) => { r.endDate = e.target.value || null; } })),
      h('td', {}, h('input', { type: 'number', value: r.priority || 0, onchange: (e) => { r.priority = Number(e.target.value); } })),
      h('td', {}, h('button', { class: 'small danger', type: 'button', onclick: () => { rules.splice(rules.indexOf(r), 1); tr.remove(); } }, '✕')));
    return tr;
  };
  rules.forEach((r) => tbody.append(row(r)));
  const add = h('button', {
    type: 'button', class: 'small', disabled: !playlists.length,
    onclick: () => {
      const r = { playlistId: playlists[0].id, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', priority: 0, enabled: true };
      rules.push(r);
      tbody.append(row(r));
    },
  }, '+ Add rule');
  return h('div', {},
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['On', 'Playlist', 'Days', 'From', 'To', 'Start date', 'End date', 'Priority', ''].map((t) => h('th', {}, t)))),
      tbody)),
    h('p', { class: 'hint' }, 'Times use the screen’s time zone. “To” earlier than “From” runs overnight; equal times mean all day. Highest priority wins; otherwise the default playlist plays.'),
    add);
}

function screenEditor(s, playlists) {
  const isNew = !s;
  const draft = structuredClone(s || { name: '', location: '', notes: '', timezone: info.defaultTimezone, serverUrl: '', defaultPlaylistId: playlists[0]?.id || null, settings: { ...info.defaults }, schedule: [] });
  const form = h('form', { class: 'form-grid', onsubmit: (e) => e.preventDefault() });
  const field = (label, input, hint) => h('label', {}, label, input, hint && h('span', { class: 'hint' }, hint));
  const bind = (obj, key) => (e) => { obj[key] = e.target.value; };
  const select = (obj, key, options) => h('select', { onchange: bind(obj, key) },
    options.map(([v, t]) => h('option', { value: v, selected: obj[key] === v }, t)));

  form.append(
    field('Name', h('input', { value: draft.name, required: true, oninput: bind(draft, 'name'), placeholder: 'Reception lobby' })),
    field('Location', h('input', { value: draft.location, oninput: bind(draft, 'location'), placeholder: 'Building A, ground floor' })),
    field('Default playlist', select(draft, 'defaultPlaylistId', [['', '— none —'], ...playlists.map((p) => [p.id, p.name])])),
    field('Time zone', h('input', { value: draft.timezone, list: 'tz-list', oninput: bind(draft, 'timezone') }),
      h('datalist', { id: 'tz-list' }, info.timezones.map((tz) => h('option', { value: tz })))),
    field('Orientation', select(draft.settings, 'orientation', [['landscape', 'Landscape'], ['portrait', 'Portrait (rotate 90°)'], ['portrait-flipped', 'Portrait (rotate 270°)'], ['landscape-flipped', 'Landscape (upside down)']])),
    field('Fit', select(draft.settings, 'fit', [['contain', 'Fit (letterbox)'], ['cover', 'Fill (crop)']])),
    field('Transition', select(draft.settings, 'transition', [['fade', 'Cross-fade'], ['none', 'Cut']])),
    field('Background', h('input', { type: 'color', value: draft.settings.background || '#000000', oninput: bind(draft.settings, 'background') })),
    field('Server URL for this screen', h('input', { value: draft.serverUrl, oninput: bind(draft, 'serverUrl'), placeholder: info.publicUrl || location.origin }),
      'How this screen reaches the server (LAN IP or WAN hostname). Baked into its add-on.'),
    field('Notes', h('input', { value: draft.notes, oninput: bind(draft, 'notes') })));

  const save = guard(async () => {
    if (!draft.name.trim()) return toast('Name is required');
    const body = { ...draft };
    if (isNew) await api('POST', '/api/screens', body);
    else await api('PUT', `/api/screens/${s.id}`, body);
    closeModal();
    toast(isNew ? 'Screen added — now download its add-on' : 'Saved — screen updated live');
    screensView();
  });

  const danger = isNew ? [] : [
    h('button', { class: 'danger', onclick: guard(async () => {
      if (!confirm(`Delete screen “${s.name}”? Its add-on will stop working.`)) return;
      await api('DELETE', `/api/screens/${s.id}`);
      closeModal(); screensView();
    }) }, 'Delete'),
    h('button', { onclick: guard(async () => {
      if (!confirm('Regenerate the access token? The currently installed add-on will be disconnected until you install the new one.')) return;
      await api('POST', `/api/screens/${s.id}/regenerate-token`);
      toast('Token regenerated — download the add-on again');
      closeModal(); screensView();
    }) }, 'Regenerate token'),
  ];

  openModal(
    h('h1', {}, isNew ? 'Add screen' : `Edit ${s.name}`),
    form,
    h('h2', {}, 'Schedule'),
    scheduleTable(draft.schedule, playlists, s?.activeRuleId),
    h('div', { class: 'modal-actions' }, ...danger, h('span', { class: 'spacer' }),
      h('button', { onclick: closeModal }, 'Cancel'),
      h('button', { class: 'primary', onclick: save }, isNew ? 'Add screen' : 'Save')));
}

function extensionDialog(s) {
  const input = h('input', { value: s.serverUrl || info.publicUrl || location.origin });
  const warn = h('p', { class: 'error' });
  const check = () => {
    warn.textContent = /\/\/(localhost|127\.|\[::1\])/.test(input.value)
      ? 'This URL points at the screen PC itself. Use the server’s LAN IP or hostname instead.' : '';
  };
  input.addEventListener('input', check);
  check();
  const download = () => {
    const url = `/api/screens/${s.id}/extension.zip?serverUrl=${encodeURIComponent(input.value)}`;
    h('a', { href: url, download: '' }).click();
  };
  openModal(
    h('h1', {}, `Add-on for ${s.name}`),
    h('label', {}, 'Server URL as seen from this screen', input,
      h('span', { class: 'hint' }, 'Use https:// behind a reverse proxy for WAN screens.')),
    warn,
    h('div', { class: 'callout' },
      h('strong', {}, 'Install on the screen PC (Chrome or Edge):'),
      h('ol', {},
        h('li', {}, 'Unzip the download into a permanent folder, e.g. ', h('code', {}, 'C:\\Signage\\')),
        h('li', {}, 'Open ', h('code', {}, 'chrome://extensions'), ' (or ', h('code', {}, 'edge://extensions'), '), enable Developer mode.'),
        h('li', {}, 'Click “Load unpacked” and choose the folder. The player opens fullscreen.'),
        h('li', {}, 'Set the browser to start at login; the add-on reopens the player automatically.'))),
    h('p', { class: 'hint' }, 'The add-on contains this screen’s secret token. Regenerate the token from Edit if a copy leaks.'),
    h('div', { class: 'modal-actions' },
      h('button', { onclick: closeModal }, 'Close'),
      h('button', { class: 'primary', onclick: download }, 'Download add-on (.zip)')));
}

// ---------- media ----------
async function mediaView() {
  const media = await api('GET', '/api/media');
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, accept: 'image/*,video/*,.pdf,.ppt,.pptx,.pps,.ppsx,.odp,.key', onchange: (e) => uploadFiles(e.target.files) });
  const decksNote = info.converters.office ? 'PDF and PowerPoint/ODP decks are converted to slides.'
    : info.converters.pdf ? 'PDF decks are converted to slides (install LibreOffice for PowerPoint).' : 'Install poppler-utils on the server to upload PDF decks.';
  const zone = h('div', { class: 'dropzone', onclick: () => fileInput.click() },
    h('strong', {}, 'Drop files here or click to upload'), h('br'),
    h('span', { class: 'hint' }, `Images, videos and slide decks. ${decksNote}`));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); uploadFiles(e.dataTransfer.files); });

  const card = (m) => h('div', { class: 'card media-card' }, thumb(m),
    h('div', { class: 'media-meta' },
      h('div', { class: 'name', title: m.name }, m.name),
      h('div', { class: 'row' },
        h('span', { class: `muted status-${m.status}` }, m.status === 'ready' ? bytes(m.size) : m.status === 'error' ? (m.error || 'error') : 'converting…'),
        h('span', {},
          h('button', { class: 'small ghost', title: 'Rename', onclick: guard(async () => {
            const name = prompt('Rename media', m.name);
            if (name) { await api('PATCH', `/api/media/${m.id}`, { name }); mediaView(); }
          }) }, '✎'),
          h('button', { class: 'small ghost danger', title: 'Delete', onclick: guard(async () => {
            if (!confirm(`Delete “${m.name}”? It will be removed from every playlist.`)) return;
            await api('DELETE', `/api/media/${m.id}`); mediaView();
          }) }, '🗑')))));

  view.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', {}, 'Media'), h('button', { class: 'primary', onclick: () => fileInput.click() }, '+ Upload')),
    zone, fileInput,
    media.length ? h('div', { class: 'media-grid' }, [...media].reverse().map(card)) : h('div', { class: 'card empty' }, 'No media yet.'));

  if (media.some((m) => m.status === 'processing')) {
    refreshTimer = setInterval(guard(async () => {
      const fresh = await api('GET', '/api/media');
      if (!fresh.some((m) => m.status === 'processing')) mediaView();
    }), 2000);
  }
}

async function uploadFiles(files) {
  if (!files?.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  toast(`Uploading ${files.length} file(s)…`);
  try {
    const { created, rejected } = await api('POST', '/api/media', fd);
    toast(`Uploaded ${created.length}${rejected.length ? `, rejected ${rejected.length}: ${rejected.map((r) => `${r.name} (${r.reason})`).join(', ')}` : ''}`);
  } catch (err) { toast(err.message); }
  if (location.hash === '#/media') mediaView();
}

// ---------- playlists ----------
async function playlistsView() {
  const [playlists, screens] = await Promise.all([api('GET', '/api/playlists'), api('GET', '/api/screens')]);
  const usedBy = (p) => screens.filter((s) => s.defaultPlaylistId === p.id || s.schedule.some((r) => r.playlistId === p.id)).map((s) => s.name);
  const create = guard(async () => {
    const name = prompt('Playlist name');
    if (!name) return;
    const p = await api('POST', '/api/playlists', { name });
    location.hash = `#/playlists/${p.id}`;
  });
  view.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', {}, 'Playlists'), h('button', { class: 'primary', onclick: create }, '+ New playlist')),
    playlists.length
      ? h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Name', 'Items', 'Used by', 'Live on', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, playlists.map((p) => h('tr', {},
          h('td', {}, h('a', { href: `#/playlists/${p.id}` }, p.name)),
          h('td', {}, p.items.length),
          h('td', {}, usedBy(p).join(', ') || h('span', { class: 'muted' }, 'unused')),
          h('td', {}, screens.filter((s) => s.activePlaylistId === p.id).length || '—'),
          h('td', {}, h('a', { class: 'btn small', href: `#/playlists/${p.id}` }, 'Edit')))))))
      : h('div', { class: 'card empty' }, 'No playlists yet. A playlist is an ordered loop of images, slide decks and videos.'));
}

async function playlistEditor(pid) {
  const [playlist, media] = await Promise.all([api('GET', '/api/playlists').then((l) => l.find((p) => p.id === pid)), api('GET', '/api/media')]);
  if (!playlist) { location.hash = '#/playlists'; return; }
  const draft = structuredClone(playlist);
  const byId = (id) => media.find((m) => m.id === id);
  const tbody = h('tbody');

  const renderRows = () => tbody.replaceChildren(...draft.items.map((it, i) => {
    const m = byId(it.mediaId);
    const move = (d) => { const j = i + d; if (j < 0 || j >= draft.items.length) return; [draft.items[i], draft.items[j]] = [draft.items[j], draft.items[i]]; renderRows(); };
    const src = m?.type === 'deck' ? m.pages?.[0] && `/files/${m.pages[0]}` : m && `/files/${m.file}`;
    return h('tr', {},
      h('td', {}, i + 1),
      h('td', {}, m?.type === 'video' ? h('video', { class: 'mini-thumb', src: `${src}#t=0.5`, preload: 'metadata', muted: true }) : h('img', { class: 'mini-thumb', src, alt: '' })),
      h('td', {}, m?.name || 'missing', h('div', { class: 'hint' }, m?.type === 'deck' ? `deck · ${m.pages?.length || '?'} slides (duration is per slide)` : m?.type)),
      h('td', {}, h('input', { type: 'number', min: 0, step: 1, value: it.duration || '', placeholder: m?.type === 'video' ? 'full' : String(draft.defaultDuration), oninput: (e) => { it.duration = Number(e.target.value) || 0; } })),
      h('td', {}, m?.type === 'video' ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: it.muted !== false, onchange: (e) => { it.muted = e.target.checked; } }), 'muted') : ''),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small', disabled: i === 0, onclick: () => move(-1) }, '↑'),
        h('button', { class: 'small', disabled: i === draft.items.length - 1, onclick: () => move(1) }, '↓'),
        h('button', { class: 'small danger', onclick: () => { draft.items.splice(i, 1); renderRows(); } }, '✕'))));
  }));
  renderRows();

  const picker = () => {
    const ready = media.filter((m) => m.status === 'ready');
    openModal(
      h('h1', {}, 'Add media'),
      ready.length ? h('div', { class: 'picker' }, [...ready].reverse().map((m) => h('button', {
        onclick: () => { draft.items.push({ mediaId: m.id, duration: 0, muted: true }); renderRows(); toast(`Added ${m.name}`); },
      }, thumb(m), h('span', {}, m.name)))) : h('p', { class: 'muted' }, 'No media uploaded yet — go to Media first.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: closeModal }, 'Done')));
  };

  const save = guard(async () => {
    await api('PUT', `/api/playlists/${pid}`, { name: draft.name, defaultDuration: draft.defaultDuration, items: draft.items });
    toast('Saved — screens showing this playlist update now');
  });
  const remove = guard(async () => {
    if (!confirm(`Delete playlist “${draft.name}”? It will be removed from all screens and schedules.`)) return;
    await api('DELETE', `/api/playlists/${pid}`);
    location.hash = '#/playlists';
  });

  view.replaceChildren(
    h('div', { class: 'toolbar' },
      h('h1', {}, h('a', { href: '#/playlists' }, 'Playlists'), ' / ', draft.name),
      h('button', { class: 'danger', onclick: remove }, 'Delete'),
      h('button', { class: 'primary', onclick: save }, 'Save & publish')),
    h('div', { class: 'card' },
      h('div', { class: 'form-grid' },
        h('label', {}, 'Name', h('input', { value: draft.name, oninput: (e) => { draft.name = e.target.value; } })),
        h('label', {}, 'Default seconds per image/slide', h('input', { type: 'number', min: 1, value: draft.defaultDuration, oninput: (e) => { draft.defaultDuration = Number(e.target.value) || 10; renderRows(); } }))),
      h('h2', {}, 'Items'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['#', '', 'Media', 'Seconds', '', ''].map((t) => h('th', {}, t)))), tbody)),
      h('div', { class: 'toolbar', style: 'margin-top:12px' }, h('button', { onclick: picker }, '+ Add media'))));
}

// ---------- settings ----------
async function settingsView() {
  const form = h('form', { class: 'card form-grid', onsubmit: guard(async (e) => {
    e.preventDefault();
    await api('POST', '/api/password', { current: form.current.value, next: form.next.value });
    form.reset();
    toast('Password changed');
  }) },
  h('label', {}, 'Current password', h('input', { type: 'password', name: 'current', required: true, autocomplete: 'current-password' })),
  h('label', {}, 'New password', h('input', { type: 'password', name: 'next', required: true, minlength: 8, autocomplete: 'new-password' })),
  h('div', {}, h('button', { class: 'primary', type: 'submit' }, 'Change password')));

  view.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', {}, 'Settings')),
    h('h2', {}, 'Admin password'), form,
    h('h2', {}, 'Server'),
    h('div', { class: 'card' }, h('dl', { class: 'kv' },
      h('dt', {}, 'Public URL'), h('dd', {}, info.publicUrl || `not set (using ${location.origin})`),
      h('dt', {}, 'Default time zone'), h('dd', {}, info.defaultTimezone),
      h('dt', {}, 'PDF decks'), h('dd', {}, info.converters.pdf ? 'available' : 'install poppler-utils'),
      h('dt', {}, 'PowerPoint decks'), h('dd', {}, info.converters.office ? 'available' : 'install LibreOffice'))));
}
