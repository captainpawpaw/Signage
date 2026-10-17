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
  modalBody.replaceChildren(...content.flat().filter((c) => c !== false && c !== null && c !== undefined && c !== ''));
  if (!modal.open) modal.showModal();
}
const closeModal = () => modal.close();

function thumb(media) {
  if (!media) return h('div', { class: 'thumb' }, 'missing');
  const src = media.type === 'deck' ? (media.pages?.[0] && `/files/${media.pages[0]}`) : `/files/${media.file}`;
  let inner;
  if (media.status !== 'ready') inner = h('span', {}, media.status === 'error' ? 'Conversion failed' : 'Converting…');
  else if (media.type === 'video' && media.poster) inner = h('img', { src: `/files/${media.poster}`, loading: 'lazy', alt: '' });
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
  [/^#\/groups$/, groupsView],
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
const securityLabel = (s) => {
  if (s.status.online && s.status.encrypted === false) return h('span', { class: 'badge-inline warn', title: 'Browser preview link: content is sent unencrypted' }, 'Unencrypted preview');
  if (s.paired) return h('span', { class: 'badge-inline ok', title: `Paired ${new Date(s.device.pairedAt).toLocaleString()}` }, '🔒 Encrypted');
  return h('span', { class: 'badge-inline', title: 'No add-on paired yet' }, 'Not paired');
};

function screenshotThumb(s) {
  if (!s.screenshotAt) return h('div', { class: 'shot empty-shot' }, 'No screenshot yet');
  const src = `/api/screens/${s.id}/screenshot.jpg?t=${encodeURIComponent(s.screenshotAt)}`;
  return h('button', { class: 'shot', title: `Taken ${ago(s.screenshotAt)} – click to enlarge`, onclick: () => openModal(
    h('h1', {}, `${s.name} – screenshot`),
    h('img', { src, class: 'shot-full', alt: `What ${s.name} was showing` }),
    h('p', { class: 'hint' }, `Taken ${new Date(s.screenshotAt).toLocaleString()}. Screens send one every 5 minutes, after content changes, or when you click Screenshot.`),
    h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: closeModal }, 'Close'))) },
  h('img', { src, alt: '' }), h('span', { class: 'shot-age' }, ago(s.screenshotAt)));
}

async function screensView() {
  const [screens, playlists, groups, pairings] = await Promise.all([
    api('GET', '/api/screens'), api('GET', '/api/playlists'), api('GET', '/api/groups'), api('GET', '/api/pairings'),
  ]);
  const plName = (pid) => playlists.find((p) => p.id === pid)?.name || '—';
  const groupNames = (s) => s.groupIds.map((id) => groups.find((g) => g.id === id)?.name).filter(Boolean);

  const card = (s) => {
    const st = s.status;
    const showing = st.online && st.itemCount ? `item ${st.index + 1} of ${st.itemCount}` : st.online ? 'idle' : '—';
    const via = s.activeGroup ? ` (${s.activeGroup.name} schedule)` : s.activeRuleId ? ' (scheduled)' : '';
    return h('div', { class: 'card screen-card' },
      screenshotThumb(s),
      h('div', { class: 'screen-head' },
        h('span', { class: `dot ${st.online ? 'on' : ''}`, title: st.online ? 'Online' : 'Offline' }),
        h('h3', { title: s.name }, s.name),
        h('span', { class: 'muted' }, st.online ? 'online' : `seen ${ago(s.lastSeen)}`)),
      h('div', { class: 'chips' }, securityLabel(s), groupNames(s).map((g) => h('span', { class: 'badge-inline' }, g))),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Location'), h('dd', {}, s.location || '—'),
        h('dt', {}, 'Now playing'), h('dd', {}, plName(s.activePlaylistId), h('span', { class: 'muted' }, via)),
        h('dt', {}, 'Progress'), h('dd', {}, showing),
        h('dt', {}, 'Display'), h('dd', {}, st.display ? `${st.display.width}×${st.display.height} · ${s.settings.orientation}` : s.settings.orientation),
        h('dt', {}, 'Address'), h('dd', {}, st.ip || '—'),
        st.addonVersion && st.addonVersion !== info.addonVersion
          ? [h('dt', {}, 'Add-on'), h('dd', { class: 'status-processing' }, `v${st.addonVersion} – update to v${info.addonVersion} pending`)] : null),
      h('div', { class: 'actions' },
        h('button', { class: 'small', onclick: () => screenEditor(s, playlists, groups) }, 'Edit'),
        h('button', { class: 'small', onclick: () => extensionDialog(s) }, 'Add-on'),
        h('button', { class: 'small', disabled: !info.allowPlaintext, onclick: guard(() => preview(s)) }, 'Preview'),
        h('button', { class: 'small', disabled: !st.online, onclick: guard(() => command(s, 'identify')) }, 'Identify'),
        h('button', { class: 'small', disabled: !st.online, onclick: guard(() => command(s, 'screenshot')) }, 'Screenshot'),
        h('button', { class: 'small', disabled: !st.online, onclick: guard(() => command(s, 'next')) }, 'Skip'),
        h('button', { class: 'small', disabled: !st.online, onclick: guard(() => command(s, 'reload')) }, 'Reload')));
  };

  const waiting = (list) => (list.length ? h('div', { class: 'card pairing-banner' },
    h('strong', {}, `${list.length} screen${list.length > 1 ? 's are' : ' is'} waiting to be paired`),
    h('div', { class: 'pairing-list' }, list.map((p) => h('div', { class: 'pairing-row' },
      h('span', { class: 'code' }, p.code),
      h('span', { class: 'muted' }, `${p.ip || ''} · ${browserName(p.userAgent)} · ${ago(p.since)}`),
      h('button', { class: 'small primary', onclick: () => pairDialog(p.code, screens, groups, playlists) }, 'Pair'))))) : '');

  const bannerSlot = h('div', {}, waiting(pairings));
  view.replaceChildren(
    h('div', { class: 'toolbar' },
      h('h1', {}, 'Screens'),
      h('button', { onclick: () => addonDialog() }, 'Install add-on'),
      h('button', { onclick: () => pairDialog('', screens, groups, playlists) }, 'Pair a screen'),
      h('button', { class: 'primary', onclick: () => screenEditor(null, playlists, groups) }, '+ Add screen')),
    bannerSlot,
    screens.length
      ? h('div', { class: 'grid' }, screens.map(card))
      : h('div', { class: 'card empty' },
        h('p', {}, 'No screens yet.'),
        h('p', {}, 'Click ', h('strong', {}, 'Install add-on'), ', install it on the PC behind a display, then pair the code it shows.')));

  refreshTimer = setInterval(guard(async () => {
    if (location.hash !== '#/screens' && location.hash !== '') return;
    const [fresh, freshPairings] = await Promise.all([api('GET', '/api/screens'), api('GET', '/api/pairings')]);
    if (fresh.length !== screens.length) return screensView();
    view.querySelector('.grid')?.replaceChildren(...fresh.map(card));
    bannerSlot.replaceChildren(waiting(freshPairings));
  }), 5000);
}

function browserName(ua = '') {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'browser';
}

async function command(s, cmd) {
  const { delivered } = await api('POST', `/api/screens/${s.id}/command`, { command: cmd });
  toast(delivered ? `Sent “${cmd}” to ${s.name}` : `${s.name} is offline`);
  if (cmd === 'screenshot' && delivered) setTimeout(() => location.hash === '#/screens' && screensView(), 2500);
}

function copyButton(input) {
  return h('button', { onclick: async () => {
    try { await navigator.clipboard.writeText(input.value); } catch { input.focus(); input.select(); document.execCommand('copy'); }
    toast('Copied');
  } }, 'Copy');
}

async function preview(s) {
  const { url } = await api('GET', `/api/screens/${s.id}/preview-url`);
  const isLocal = (u) => /\/\/(localhost|127\.|\[::1\])/.test(u);
  const base = s.serverUrl || info.publicUrl || location.origin;
  const input = h('input', { value: base.replace(/\/+$/, '') + url, readonly: true, onfocus: (e) => e.target.select() });
  openModal(
    h('h1', {}, `Preview ${s.name}`),
    h('p', {}, 'Open this link in any browser (PC, phone or tablet) to run this screen’s player without the add-on. Tap the page to go fullscreen.'),
    h('label', {}, 'Player link', h('div', { class: 'input-row' }, input, copyButton(input))),
    isLocal(input.value) && h('p', { class: 'error' }, 'This link uses localhost, which only works on this PC. For a phone, set the screen’s Preview address (Edit) to this PC’s network address, e.g. http://192.168.1.20:8080.'),
    h('div', { class: 'callout warn-callout' }, 'Preview links are not encrypted: anyone who can see the network traffic can see the content and reuse the link. Use them for testing. Screens running the add-on are always end-to-end encrypted. You can switch previews off in Settings.'),
    h('div', { class: 'modal-actions' },
      h('button', { onclick: closeModal }, 'Close'),
      h('button', { class: 'primary', onclick: () => window.open(url, `preview-${s.id}`, 'width=960,height=540') }, 'Open here')));
}

function scheduleTable(rules, playlists, activeRuleId, scope = 'screen') {
  const tbody = h('tbody');
  const row = (r) => {
    const tr = h('tr', { class: r.id && r.id === activeRuleId ? 'active-rule' : '' });
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
    h('p', { class: 'hint' }, scope === 'group'
      ? 'Applies to every screen in the group, in each screen’s own time zone. A screen’s own rules win ties; otherwise the highest priority wins.'
      : 'Times use the screen’s time zone. “To” earlier than “From” runs overnight; equal times mean all day. Highest priority wins, including rules from the screen’s groups; otherwise the default playlist plays.'),
    add);
}

function memberChecklist(items, selected, labelOf) {
  return h('div', { class: 'checklist' }, items.length ? items.map((it) => h('label', { class: 'inline' },
    h('input', { type: 'checkbox', checked: selected.has(it.id), onchange: (e) => (e.target.checked ? selected.add(it.id) : selected.delete(it.id)) }),
    labelOf(it))) : h('span', { class: 'muted' }, 'None yet'));
}

function screenEditor(s, playlists, groups) {
  const isNew = !s;
  const draft = structuredClone(s || { name: '', location: '', notes: '', timezone: info.defaultTimezone, serverUrl: '', defaultPlaylistId: playlists[0]?.id || null, settings: { ...info.defaults }, schedule: [], groupIds: [] });
  const groupSet = new Set(draft.groupIds);
  const form = h('form', { class: 'form-grid', onsubmit: (e) => e.preventDefault() });
  const field = (label, input, hint) => h('label', {}, label, input, hint && h('span', { class: 'hint' }, hint));
  const bind = (obj, key) => (e) => { obj[key] = e.target.value; };
  const select = (obj, key, options) => h('select', { onchange: bind(obj, key) },
    options.map(([v, t]) => h('option', { value: v, selected: obj[key] === v }, t)));

  form.append(
    field('Name', h('input', { value: draft.name, required: true, oninput: bind(draft, 'name'), placeholder: 'Reception lobby' })),
    field('Location', h('input', { value: draft.location, oninput: bind(draft, 'location'), placeholder: 'Building A, ground floor' })),
    field('Default playlist', select(draft, 'defaultPlaylistId', [['', '— none (use group’s) —'], ...playlists.map((p) => [p.id, p.name])])),
    field('Time zone', h('input', { value: draft.timezone, list: 'tz-list', oninput: bind(draft, 'timezone') }),
      h('datalist', { id: 'tz-list' }, info.timezones.map((tz) => h('option', { value: tz })))),
    field('Orientation', select(draft.settings, 'orientation', [['landscape', 'Landscape'], ['portrait', 'Portrait (rotate 90°)'], ['portrait-flipped', 'Portrait (rotate 270°)'], ['landscape-flipped', 'Landscape (upside down)']])),
    field('Fit', select(draft.settings, 'fit', [['contain', 'Fit (letterbox)'], ['cover', 'Fill (crop)']])),
    field('Transition', select(draft.settings, 'transition', [['fade', 'Cross-fade'], ['none', 'Cut']])),
    field('Background', h('input', { type: 'color', value: draft.settings.background || '#000000', oninput: bind(draft.settings, 'background') })),
    field('Preview address', h('input', { value: draft.serverUrl, oninput: bind(draft, 'serverUrl'), placeholder: info.publicUrl || location.origin }),
      'Server address used in this screen’s preview links, e.g. http://192.168.1.20:8080. The add-on finds the server by itself.'),
    field('Notes', h('input', { value: draft.notes, oninput: bind(draft, 'notes') })));

  const save = guard(async () => {
    if (!draft.name.trim()) return toast('Name is required');
    const body = { ...draft, groupIds: [...groupSet] };
    if (isNew) await api('POST', '/api/screens', body);
    else await api('PUT', `/api/screens/${s.id}`, body);
    closeModal();
    toast(isNew ? 'Screen added — install the add-on on its PC' : 'Saved — screen updated live');
    screensView();
  });

  const danger = isNew ? [] : [
    h('button', { class: 'danger', onclick: guard(async () => {
      if (!confirm(`Delete screen “${s.name}”? Its add-on will stop working.`)) return;
      await api('DELETE', `/api/screens/${s.id}`);
      closeModal(); screensView();
    }) }, 'Delete'),
    h('button', { onclick: guard(async () => {
      if (!confirm('Unpair this screen and reset its access? The installed add-on is disconnected and shows a new pairing code; preview links and pre-configured downloads stop working.')) return;
      await api('POST', `/api/screens/${s.id}/regenerate-token`);
      toast('Screen unpaired — pair it again to resume');
      closeModal(); screensView();
    }) }, 'Unpair & reset access'),
  ];

  openModal(
    h('h1', {}, isNew ? 'Add screen' : `Edit ${s.name}`),
    s?.device && h('p', { class: 'hint' }, `🔒 Paired ${new Date(s.device.pairedAt).toLocaleString()} · ${browserName(s.device.userAgent)}`),
    form,
    h('h2', {}, 'Groups'),
    memberChecklist(groups, groupSet, (g) => g.name),
    h('h2', {}, 'Schedule'),
    scheduleTable(draft.schedule, playlists, s?.activeRuleId),
    h('div', { class: 'modal-actions' }, ...danger, h('span', { class: 'spacer' }),
      h('button', { onclick: closeModal }, 'Cancel'),
      h('button', { class: 'primary', onclick: save }, isNew ? 'Add screen' : 'Save')));
}

function pairDialog(code, screens, groups, playlists) {
  const draft = { code, mode: 'new', name: '', screenId: screens[0]?.id || '', groupId: '', defaultPlaylistId: playlists[0]?.id || '' };
  const codeInput = h('input', { value: code, placeholder: 'e.g. K7Q2MX', class: 'code-input', maxlength: 8, autocomplete: 'off', oninput: (e) => { draft.code = e.target.value; } });
  const newFields = h('div', { class: 'form-grid' },
    h('label', {}, 'Screen name', h('input', { placeholder: 'Reception lobby', oninput: (e) => { draft.name = e.target.value; } })),
    h('label', {}, 'Playlist', h('select', { onchange: (e) => { draft.defaultPlaylistId = e.target.value; } },
      h('option', { value: '' }, '— none —'), playlists.map((p) => h('option', { value: p.id, selected: p.id === draft.defaultPlaylistId }, p.name)))),
    groups.length ? h('label', {}, 'Group', h('select', { onchange: (e) => { draft.groupId = e.target.value; } },
      h('option', { value: '' }, '— none —'), groups.map((g) => h('option', { value: g.id }, g.name)))) : '');
  const existing = h('label', { hidden: true }, 'Screen', h('select', { onchange: (e) => { draft.screenId = e.target.value; } },
    screens.map((s) => h('option', { value: s.id }, `${s.name}${s.paired ? ' (replaces its current device)' : ''}`))));
  const choose = (mode) => { draft.mode = mode; newFields.hidden = mode !== 'new'; existing.hidden = mode !== 'existing'; };
  const pair = guard(async () => {
    if (!draft.code.trim()) return toast('Enter the code shown on the screen');
    const body = draft.mode === 'new'
      ? { name: draft.name, defaultPlaylistId: draft.defaultPlaylistId || null, groupIds: draft.groupId ? [draft.groupId] : [] }
      : { screenId: draft.screenId };
    const screen = await api('POST', `/api/pairings/${encodeURIComponent(draft.code.trim())}`, body);
    closeModal();
    toast(`Paired “${screen.name}” — content is on its way, encrypted`);
    screensView();
  });
  openModal(
    h('h1', {}, 'Pair a screen'),
    h('p', {}, 'Type the code shown on the screen. The screen must be on and running the add-on.'),
    h('label', {}, 'Pairing code', codeInput),
    h('div', { class: 'segmented' },
      h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'pair-mode', checked: true, onchange: () => choose('new') }), 'New screen'),
      h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'pair-mode', disabled: !screens.length, onchange: () => choose('existing') }), 'Existing screen')),
    newFields, existing,
    h('p', { class: 'hint' }, `The screen shows this server’s key fingerprint (${info.fingerprint}); it only accepts content signed with that key.`),
    h('div', { class: 'modal-actions' }, h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: pair }, 'Pair')));
  if (!code) codeInput.focus();
}

function addonDialog() {
  const pageUrl = `${(info.publicUrl || location.origin).replace(/\/+$/, '')}/addon/`;
  const pageInput = h('input', { value: pageUrl, readonly: true, onfocus: (e) => e.target.select() });
  const dl = (href, title, text) => h('a', { class: 'download', href, download: '' }, h('strong', {}, title), h('span', {}, text));
  openModal(
    h('h1', {}, 'Install the add-on'),
    h('p', {}, 'One add-on works for every screen. It finds this server on the network by itself (as ', h('code', {}, 'signage.local'), ', by PC name or by address), then shows a pairing code for you to approve under ', h('strong', {}, 'Pair a screen'), '.'),
    h('div', { class: 'downloads' },
      dl('/addon/screen-setup.zip', 'Windows screen PC installer', 'Add-on, fullscreen start at login and automatic updates. Unzip on the screen PC and run setup-screen.bat.'),
      dl('/addon/signage-chrome.zip', 'Chrome / Edge add-on', 'Unzip, open chrome://extensions, turn on Developer mode, click Load unpacked.'),
      dl('/addon/signage-firefox.zip', 'Firefox add-on (testing)', 'about:debugging → This Firefox → Load Temporary Add-on → pick manifest.json. Needs signing by Mozilla for permanent use.')),
    h('label', {}, 'Or open this page on the screen PC to download there', h('div', { class: 'input-row' }, pageInput, copyButton(pageInput))),
    h('details', {},
      h('summary', {}, 'Managed roll-out (Group Policy / Intune)'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Extension ID'), h('dd', { class: 'mono' }, info.extensionId),
        h('dt', {}, 'Update URL'), h('dd', { class: 'mono' }, info.updateUrl),
        h('dt', {}, 'Version'), h('dd', {}, info.addonVersion)),
      h('p', { class: 'hint' }, 'Add “', h('code', {}, `${info.extensionId};${info.updateUrl}`), '” to the ExtensionInstallForcelist policy for Chrome or Edge. Browsers then install the add-on and keep it updated with no clicks. Windows only allows this on PCs managed by a domain, Intune or the browser’s cloud management.')),
    h('p', { class: 'hint' }, `Server key fingerprint: ${info.fingerprint}`),
    h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: closeModal }, 'Done')));
}

function extensionDialog(s) {
  let browser = 'chrome';
  const download = () => h('a', { href: `/api/screens/${s.id}/extension.zip?browser=${browser}`, download: '' }).click();
  openModal(
    h('h1', {}, `Pre-configured add-on for ${s.name}`),
    h('p', {}, 'This add-on pairs itself with ', h('strong', {}, s.name), ' the first time it starts, so no code is needed. Use it when you are setting up this one screen; otherwise use the universal add-on (Install add-on) and pair it.'),
    h('label', {}, 'Browser', h('select', { onchange: (e) => { browser = e.target.value; } },
      h('option', { value: 'chrome' }, 'Chrome / Edge'), h('option', { value: 'firefox' }, 'Firefox (testing)'))),
    h('div', { class: 'callout' },
      h('strong', {}, 'Install on the screen PC:'),
      h('ol', {},
        h('li', {}, 'Unzip the download into a permanent folder, e.g. ', h('code', {}, 'C:\\Signage\\')),
        h('li', {}, 'Open ', h('code', {}, 'chrome://extensions'), ' (or ', h('code', {}, 'edge://extensions'), '), turn on Developer mode.'),
        h('li', {}, 'Click “Load unpacked” and choose the folder. The player opens fullscreen and starts playing.'))),
    h('p', { class: 'hint' }, 'The download contains a one-time pairing token; each new download replaces the previous one. Once used, the zip is worthless to anyone else.'),
    h('div', { class: 'modal-actions' },
      h('button', { onclick: closeModal }, 'Close'),
      h('button', { class: 'primary', onclick: download }, 'Download add-on (.zip)')));
}

// ---------- groups ----------
async function groupsView() {
  const [groups, screens, playlists] = await Promise.all([api('GET', '/api/groups'), api('GET', '/api/screens'), api('GET', '/api/playlists')]);
  const members = (g) => screens.filter((s) => s.groupIds.includes(g.id));
  const groupCommand = guard(async (g, cmd) => {
    const { delivered } = await api('POST', `/api/groups/${g.id}/command`, { command: cmd });
    toast(`Sent “${cmd}” to ${delivered} screen${delivered === 1 ? '' : 's'}`);
  });
  view.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', {}, 'Groups'), h('button', { class: 'primary', onclick: () => groupEditor(null, screens, playlists) }, '+ New group')),
    groups.length
      ? h('div', { class: 'grid' }, groups.map((g) => {
        const m = members(g);
        return h('div', { class: 'card screen-card' },
          h('div', { class: 'screen-head' }, h('h3', {}, g.name), h('span', { class: 'muted' }, `${m.length} screen${m.length === 1 ? '' : 's'}`)),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Default'), h('dd', {}, playlists.find((p) => p.id === g.defaultPlaylistId)?.name || '—'),
            h('dt', {}, 'Rules'), h('dd', {}, g.schedule.length ? `${g.schedule.length} schedule rule${g.schedule.length === 1 ? '' : 's'}` : '—'),
            h('dt', {}, 'Screens'), h('dd', { title: m.map((s) => s.name).join(', ') }, m.map((s) => s.name).join(', ') || '—'),
            h('dt', {}, 'Online'), h('dd', {}, `${m.filter((s) => s.status.online).length} of ${m.length}`)),
          h('div', { class: 'actions' },
            h('button', { class: 'small', onclick: () => groupEditor(g, screens, playlists) }, 'Edit'),
            h('button', { class: 'small', onclick: () => groupCommand(g, 'identify') }, 'Identify all'),
            h('button', { class: 'small', onclick: () => groupCommand(g, 'screenshot') }, 'Screenshots'),
            h('button', { class: 'small', onclick: () => groupCommand(g, 'reload') }, 'Reload all')));
      }))
      : h('div', { class: 'card empty' }, 'No groups yet. Groups let you schedule content for many screens at once, e.g. “Ground floor” or “Canteen”.'));
}

function groupEditor(g, screens, playlists) {
  const isNew = !g;
  const draft = structuredClone(g || { name: '', defaultPlaylistId: '', schedule: [] });
  const selected = new Set(isNew ? [] : screens.filter((s) => s.groupIds.includes(g.id)).map((s) => s.id));
  const save = guard(async () => {
    if (!draft.name.trim()) return toast('Name is required');
    const body = { name: draft.name, defaultPlaylistId: draft.defaultPlaylistId || null, schedule: draft.schedule, screenIds: [...selected] };
    if (isNew) await api('POST', '/api/groups', body); else await api('PUT', `/api/groups/${g.id}`, body);
    closeModal();
    toast('Saved — screens in the group update live');
    groupsView();
  });
  const remove = guard(async () => {
    if (!confirm(`Delete group “${g.name}”? Its screens keep their own settings.`)) return;
    await api('DELETE', `/api/groups/${g.id}`);
    closeModal();
    groupsView();
  });
  openModal(
    h('h1', {}, isNew ? 'New group' : `Edit ${g.name}`),
    h('div', { class: 'form-grid' },
      h('label', {}, 'Name', h('input', { value: draft.name, placeholder: 'Ground floor', oninput: (e) => { draft.name = e.target.value; } })),
      h('label', {}, 'Default playlist', h('select', { onchange: (e) => { draft.defaultPlaylistId = e.target.value; } },
        h('option', { value: '' }, '— none —'), playlists.map((p) => h('option', { value: p.id, selected: p.id === draft.defaultPlaylistId }, p.name))),
      h('span', { class: 'hint' }, 'Used by member screens that have no default playlist of their own.'))),
    h('h2', {}, 'Screens'),
    memberChecklist(screens, selected, (s) => s.name),
    h('h2', {}, 'Schedule'),
    scheduleTable(draft.schedule, playlists, null, 'group'),
    h('div', { class: 'modal-actions' },
      isNew ? '' : h('button', { class: 'danger', onclick: remove }, 'Delete'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: closeModal }, 'Cancel'),
      h('button', { class: 'primary', onclick: save }, isNew ? 'Create group' : 'Save')));
}

// ---------- media ----------
async function mediaView() {
  const media = await api('GET', '/api/media');
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, accept: 'image/*,video/*,.pdf,.ppt,.pptx,.pps,.ppsx,.odp,.key', onchange: (e) => uploadFiles(e.target.files) });
  const decksNote = info.converters.office ? 'PDF and PowerPoint/ODP decks are converted to slides.'
    : info.converters.pdf ? 'PDF decks are converted to slides (install LibreOffice for PowerPoint).' : 'Install poppler-utils on the server to upload PDF decks.';
  const zone = h('div', { class: 'dropzone', onclick: () => fileInput.click() },
    h('strong', {}, 'Drop files here or click to upload'), h('br'),
    h('span', { class: 'hint' }, `Images, videos and slide decks. ${decksNote} ${info.converters.video
      ? 'Videos are converted to MP4 that plays everywhere (iPhone HEVC included) and streams to screens.'
      : 'Install ffmpeg on the server to convert videos (e.g. iPhone HEVC) and stream them.'}`));
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
      h('td', {}, m?.type === 'video' && !m.poster ? h('video', { class: 'mini-thumb', src: `${src}#t=0.5`, preload: 'metadata', muted: true })
        : h('img', { class: 'mini-thumb', src: m?.poster ? `/files/${m.poster}` : src, alt: '' })),
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
  info = await api('GET', '/api/info');
  const general = { serverName: info.serverName, allowPlaintext: info.allowPlaintext };
  const saveGeneral = guard(async () => {
    const res = await api('PUT', '/api/settings', general);
    Object.assign(info, res);
    toast('Settings saved');
  });
  const form = h('form', { class: 'card form-grid', onsubmit: guard(async (e) => {
    e.preventDefault();
    await api('POST', '/api/password', { current: form.current.value, next: form.next.value });
    form.reset();
    toast('Password changed');
  }) },
  h('label', {}, 'Current password', h('input', { type: 'password', name: 'current', required: true, autocomplete: 'current-password' })),
  h('label', {}, 'New password', h('input', { type: 'password', name: 'next', required: true, minlength: 8, autocomplete: 'new-password' })),
  h('div', {}, h('button', { class: 'primary', type: 'submit' }, 'Change password')));

  const tool = (ok, yes, no) => (ok ? h('span', { class: 'status-ok' }, yes) : h('span', { class: 'muted' }, no));
  view.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', {}, 'Settings')),
    h('h2', {}, 'General'),
    h('div', { class: 'card form-grid' },
      h('label', {}, 'Server name', h('input', { value: general.serverName, oninput: (e) => { general.serverName = e.target.value; } }),
        h('span', { class: 'hint' }, 'Shown on screens while they wait to be paired.')),
      h('label', { class: 'inline toggle' },
        h('input', { type: 'checkbox', checked: general.allowPlaintext, onchange: (e) => { general.allowPlaintext = e.target.checked; } }),
        h('span', {}, h('strong', {}, 'Allow unencrypted preview links'), h('br'),
          h('span', { class: 'hint' }, 'Needed for testing on phones and tablets (they can’t run the add-on). Switch off once all screens use the add-on: only end-to-end encrypted screens can then play content.'))),
      h('div', {}, h('button', { class: 'primary', onclick: saveGeneral }, 'Save'))),
    h('h2', {}, 'Security'),
    h('div', { class: 'card' },
      h('p', {}, 'Screens running the add-on create their own key pair; the private key never leaves the screen. Every file is encrypted with its own random key (AES-256-GCM), and that key is locked separately for each paired screen (ECDH P-256), as in PGP. Everything the server sends is signed (ECDSA P-256) and screens reject anything else.'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Key fingerprint'), h('dd', { class: 'mono' }, info.fingerprint),
        h('dt', {}, 'Connection'), h('dd', {}, info.tls ? 'HTTPS' : 'HTTP — screen content is still end-to-end encrypted; set TLS_CERT/TLS_KEY to also protect this console'),
        h('dt', {}, 'Key files'), h('dd', {}, h('code', {}, 'data/keys/'), ' — back these up with the data folder. Losing them means re-pairing every screen.'))),
    h('h2', {}, 'Admin password'), form,
    h('h2', {}, 'Server'),
    h('div', { class: 'card' }, h('dl', { class: 'kv' },
      h('dt', {}, 'Reachable at'), h('dd', {}, info.candidates.join('  ·  ')),
      h('dt', {}, 'Default time zone'), h('dd', {}, info.defaultTimezone),
      h('dt', {}, 'Add-on version'), h('dd', {}, info.addonVersion),
      h('dt', {}, 'PDF decks'), h('dd', {}, tool(info.converters.pdf, 'available', 'install poppler')),
      h('dt', {}, 'PowerPoint decks'), h('dd', {}, tool(info.converters.office, 'available', 'install LibreOffice')),
      h('dt', {}, 'Video conversion'), h('dd', {}, tool(info.converters.video, 'available (ffmpeg)', 'install ffmpeg')))),
    h('p', { class: 'hint' }, 'Installed a tool? Restart the server (or re-run windows\\install-autostart.bat) so it is detected.'));
}
