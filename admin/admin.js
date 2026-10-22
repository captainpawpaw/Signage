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

const isChannel = (m) => m?.type === 'stream';

function thumb(media) {
  if (!media) return h('div', { class: 'thumb' }, 'missing');
  if (isChannel(media)) {
    return h('div', { class: 'thumb channel-thumb' },
      media.logo ? h('img', { src: media.logo, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.replaceWith(h('span', { class: 'tv-glyph' }, '📺')) })
        : h('span', { class: 'tv-glyph' }, '📺'),
      h('span', { class: 'badge live' }, 'live'));
  }
  const src = media.type === 'deck' ? (media.pages?.[0] && `/files/${media.pages[0]}`) : `/files/${media.file}`;
  let inner;
  if (media.status !== 'ready') inner = h('span', {}, media.status === 'error' ? 'Conversion failed' : 'Converting…');
  else if (media.type === 'video' && media.poster) inner = h('img', { src: `/files/${media.poster}`, loading: 'lazy', alt: '' });
  else if (media.type === 'video') inner = h('video', { src: `${src}#t=0.5`, preload: 'metadata', muted: true });
  else inner = h('img', { src, loading: 'lazy', alt: '' });
  const label = media.type === 'deck' && media.pages ? `deck · ${media.pages.length}p` : media.type;
  return h('div', { class: 'thumb' }, inner, h('span', { class: 'badge' }, label));
}

// Playlists made by the Schedule page for directly picked media are hidden.
const listPlaylists = () => api('GET', '/api/playlists').then((list) => list.filter((p) => !p.hidden));

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
  [/^#\/schedule$/, () => scheduleView()],
  [/^#\/schedule\/(screen|group)\/(.+)$/, (kind, sid) => scheduleView(kind, sid)],
  [/^#\/media$/, mediaView],
  [/^#\/channels$/, channelsView],
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
    api('GET', '/api/screens'), listPlaylists(), api('GET', '/api/groups'), api('GET', '/api/pairings'),
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
        s.playNow
          ? [h('dt', {}, 'Now playing'), h('dd', { class: 'play-now-row' },
            h('strong', {}, s.playNow.name), h('span', { class: 'muted' }, s.playNow.until ? ` until ${whenLabel(s.playNow.until)}` : ' until stopped'),
            h('button', { class: 'small', title: 'Go back to the schedule', onclick: guard(async () => {
              await api('POST', '/api/play-now/stop', { targets: { screenIds: [s.id] } });
              toast(`${s.name} is back on its schedule`);
              screensView();
            }) }, 'Stop'))]
          : [h('dt', {}, 'Now playing'), h('dd', {}, plName(s.activePlaylistId), h('span', { class: 'muted' }, via))],
        h('dt', {}, 'Up next'), h('dd', { title: (s.upcoming || []).map((u) => `${whenLabel(u.at)}: ${u.playlistName || 'nothing'}`).join('\n') },
          s.upcoming?.length ? `${s.upcoming[0].playlistName || 'nothing scheduled'} · ${whenLabel(s.upcoming[0].at)}` : '—'),
        h('dt', {}, 'Progress'), h('dd', {}, showing),
        h('dt', {}, 'Display'), h('dd', {}, st.display ? `${st.display.width}×${st.display.height} · ${s.settings.orientation}${st.lowPower ? ' · low-power' : ''}` : s.settings.orientation),
        h('dt', {}, 'Address'), h('dd', {}, st.ip || '—'),
        st.agent ? [h('dt', {}, 'Player'), h('dd', { title: `Signage agent ${st.agent.version}` },
          `${st.agent.model || 'Linux player'} · cache ${bytes(st.agent.cacheBytes || 0)}${st.agent.freeBytes != null ? `, ${bytes(st.agent.freeBytes)} free` : ''}${st.agent.diskFull ? ' · disk full' : ''}`)] : null,
        st.agent && st.agent.version !== info.agentVersion
          ? [h('dt', {}, 'Agent'), h('dd', { class: 'status-processing' }, `v${st.agent.version} – update to v${info.agentVersion} pending`)] : null,
        !st.agent && st.addonVersion && st.addonVersion !== info.addonVersion
          ? [h('dt', {}, 'Add-on'), h('dd', { class: 'status-processing' }, `v${st.addonVersion} – update to v${info.addonVersion} pending`)] : null),
      h('div', { class: 'actions' },
        h('button', { class: 'small', onclick: () => screenEditor(s, playlists, groups) }, 'Edit'),
        h('button', { class: 'small', onclick: guard(() => playNowDialog({ screenIds: [s.id] })) }, 'Play now'),
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

// "14:30", "tomorrow 08:00", "Fri 08:00" or "3 Nov 08:00", in this browser's time.
function whenLabel(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
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
  let links = await api('GET', `/api/screens/${s.id}/preview-url`);
  const isLocal = (u) => /\/\/(localhost|127\.|\[::1\])/.test(u);
  const base = (s.serverUrl || info.publicUrl || location.origin).replace(/\/+$/, '');
  const longInput = h('input', { value: base + links.url, readonly: true, onfocus: (e) => e.target.select() });
  const shortSlot = h('div');

  const renderShort = () => {
    if (!links.shortUrl) {
      shortSlot.replaceChildren(h('div', { class: 'input-row' },
        h('button', { onclick: guard(async () => { links = await api('POST', `/api/screens/${s.id}/short-link`); renderShort(); }) }, 'Create short link'),
        h('span', { class: 'hint' }, 'A short address like /p/K7Q2MX that is easier to type on a phone or TV.')));
      return;
    }
    const shortInput = h('input', { value: base + links.shortUrl, readonly: true, class: 'mono', onfocus: (e) => e.target.select() });
    shortSlot.replaceChildren(h('label', {}, 'Short link', h('div', { class: 'input-row' }, shortInput, copyButton(shortInput),
      h('button', { class: 'danger', title: 'The short link stops working; the long link is unaffected', onclick: guard(async () => {
        if (!confirm('Remove the short link? Anyone using it will get “link not valid”. The long link keeps working.')) return;
        links = await api('DELETE', `/api/screens/${s.id}/short-link`);
        renderShort();
      }) }, 'Remove'))));
  };
  renderShort();

  openModal(
    h('h1', {}, `Preview ${s.name}`),
    h('p', {}, 'Open this link in any browser (PC, phone, tablet or TV) to run this screen’s player without the add-on. Tap the page to go fullscreen.'),
    h('label', {}, 'Player link', h('div', { class: 'input-row' }, longInput, copyButton(longInput))),
    shortSlot,
    isLocal(base) && h('p', { class: 'error' }, 'This link uses localhost, which only works on this PC. For other devices, set the screen’s Preview address (Edit) to this PC’s network address, e.g. http://192.168.1.20:8080.'),
    h('div', { class: 'callout warn-callout' }, 'Preview links are not encrypted: anyone who can see the network traffic, or who has the link, can see the content. Use them for testing. Screens running the add-on are always end-to-end encrypted. “Unpair & reset access” (Edit) replaces these links; Settings can switch previews off.'),
    h('div', { class: 'modal-actions' },
      h('button', { onclick: closeModal }, 'Close'),
      h('button', { class: 'primary', onclick: () => window.open(links.url, `preview-${s.id}`, 'width=960,height=540') }, 'Open here')));
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
  draft.offline = { mode: 'default', ...draft.offline };
  const customOffline = h('div', { hidden: draft.offline.mode !== 'custom' }, offlineFields(draft.offline));
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
    field('Device type', select(draft.settings, 'power', [['auto', 'Auto-detect'], ['low', 'Low-power (TV stick, smart TV)'], ['standard', 'Standard PC']]),
      'Low-power turns off cross-fades and periodic screenshots so video stays smooth. Fire TV and smart-TV browsers are detected automatically.'),
    field('Preview address', h('input', { value: draft.serverUrl, oninput: bind(draft, 'serverUrl'), placeholder: info.publicUrl || location.origin }),
      'Server address used in this screen’s preview links, e.g. http://192.168.1.20:8080. The add-on finds the server by itself.'),
    field('Notes', h('input', { value: draft.notes, oninput: bind(draft, 'notes') })));

  const save = guard(async () => {
    if (!draft.name.trim()) return toast('Name is required');
    const { schedule, ...rest } = draft;
    const body = { ...rest, groupIds: [...groupSet] };
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
    h('h2', {}, 'When this screen loses its connection'),
    h('label', {}, h('select', { onchange: (e) => { draft.offline.mode = e.target.value; customOffline.hidden = e.target.value !== 'custom'; } },
      [['default', 'Use the default from Settings'], ['custom', 'Custom message / QR code for this screen'], ['off', 'Show nothing']]
        .map(([v, t]) => h('option', { value: v, selected: draft.offline.mode === v }, t)))),
    customOffline,
    h('h2', {}, 'Schedule'),
    h('p', { class: 'hint' }, 'What plays when is set in the ', h('a', { href: isNew ? '#/schedule' : `#/schedule/screen/${s.id}`, onclick: closeModal }, 'Schedule'),
      ' section. Outside scheduled times this screen plays its default playlist.'),
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
      dl('/addon/signage-linux-setup.sh', 'Raspberry Pi / Linux player', 'One file for Raspberry Pi OS (Bookworm or newer) or Debian. Copy it to the device and run: sudo bash signage-linux-setup.sh. Keeps all scheduled content on disk and updates itself.'),
      h('a', { class: 'download', href: info.signageOsUrl, target: '_blank', rel: 'noopener' },
        h('strong', {}, 'Signage OS (nothing else to install)'),
        h('span', {}, 'Ready-to-flash system for Raspberry Pi and PCs (old workstations, thin clients, laptops). Write it to an SD card or USB stick with Raspberry Pi Imager or balenaEtcher, copy signage-linux-setup.sh onto its SIGNAGE drive and start the screen. On a PC it can install itself on the internal disk.')),
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
    h('label', {}, 'Player', h('select', { onchange: (e) => { browser = e.target.value; } },
      h('option', { value: 'chrome' }, 'Chrome / Edge add-on'), h('option', { value: 'linux' }, 'Raspberry Pi / Linux player'), h('option', { value: 'firefox' }, 'Firefox add-on (testing)'))),
    h('p', { class: 'hint' }, 'Raspberry Pi / Linux: copy the downloaded .sh file to the device and run sudo bash on it.'),
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

// Message + QR code shown on screens while they can't reach the server.
function offlineFields(draft) {
  const qrImg = h('img', { class: 'qr-preview', alt: 'QR code preview', hidden: true });
  let timer;
  const refreshQr = () => {
    clearTimeout(timer);
    timer = setTimeout(guard(async () => {
      const { dataUrl } = draft.qr ? await api('POST', '/api/qr-preview', { text: draft.qr }) : { dataUrl: null };
      qrImg.hidden = !dataUrl;
      if (dataUrl) qrImg.src = dataUrl;
    }), 300);
  };
  refreshQr();
  return h('div', { class: 'offline-fields' },
    h('div', { class: 'form-grid' },
      h('label', {}, 'Message', h('textarea', { rows: 3, maxlength: 300, placeholder: 'e.g. This screen is temporarily offline. Latest news: scan the code.', oninput: (e) => { draft.message = e.target.value; } }, draft.message || '')),
      h('label', {}, 'QR code link or text', h('input', { value: draft.qr || '', maxlength: 500, placeholder: 'https://intranet.example.com/news', oninput: (e) => { draft.qr = e.target.value; refreshQr(); } }),
        h('span', { class: 'hint' }, 'Leave empty for no QR code.')),
      h('label', {}, 'Show as', h('select', { onchange: (e) => { draft.position = e.target.value; } },
        [['corner', 'Small box in the corner (content keeps playing)'], ['fullscreen', 'Full-screen overlay'], ['none', 'Nothing']]
          .map(([v, t]) => h('option', { value: v, selected: (draft.position || 'corner') === v }, t))))),
    qrImg);
}

// ---------- groups ----------
async function groupsView() {
  const [groups, screens, playlists] = await Promise.all([api('GET', '/api/groups'), api('GET', '/api/screens'), listPlaylists()]);
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
    const body = { name: draft.name, defaultPlaylistId: draft.defaultPlaylistId || null, screenIds: [...selected] };
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
    h('p', { class: 'hint' }, 'Schedule content for this group in the ', h('a', { href: isNew ? '#/schedule' : `#/schedule/group/${g.id}`, onclick: closeModal }, 'Schedule'), ' section.'),
    h('div', { class: 'modal-actions' },
      isNew ? '' : h('button', { class: 'danger', onclick: remove }, 'Delete'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: closeModal }, 'Cancel'),
      h('button', { class: 'primary', onclick: save }, isNew ? 'Create group' : 'Save')));
}

// ---------- media ----------
async function mediaView() {
  const media = (await api('GET', '/api/media')).filter((m) => !isChannel(m));
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
    media.length ? h('div', { class: 'media-grid' }, [...media].reverse().map(card)) : h('div', { class: 'card empty' }, 'No media yet.'),
    h('p', { class: 'hint' }, 'Live TV streams are added under ', h('a', { href: '#/channels' }, 'Channels'), '.'));

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
  const [playlists, screens, groups, schedules] = await Promise.all([listPlaylists(), api('GET', '/api/screens'), api('GET', '/api/groups'), api('GET', '/api/schedules')]);
  const usedBy = (p) => {
    const names = new Set(screens.filter((s) => s.defaultPlaylistId === p.id).map((s) => s.name));
    for (const g of groups) if (g.defaultPlaylistId === p.id) names.add(g.name);
    for (const e of schedules.filter((x) => x.playlistId === p.id)) {
      for (const sid of e.targets.screenIds) names.add(screens.find((x) => x.id === sid)?.name);
      for (const gid of e.targets.groupIds) names.add(groups.find((x) => x.id === gid)?.name);
    }
    return [...names].filter(Boolean);
  };
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
    if (isChannel(m)) return channelRow(it, i, m);
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
  const rowActions = (i) => h('td', {}, h('div', { class: 'actions' },
    h('button', { class: 'small', disabled: i === 0, onclick: () => { [draft.items[i - 1], draft.items[i]] = [draft.items[i], draft.items[i - 1]]; renderRows(); } }, '↑'),
    h('button', { class: 'small', disabled: i === draft.items.length - 1, onclick: () => { [draft.items[i + 1], draft.items[i]] = [draft.items[i], draft.items[i + 1]]; renderRows(); } }, '↓'),
    h('button', { class: 'small danger', onclick: () => { draft.items.splice(i, 1); renderRows(); } }, '✕')));
  // A channel plays non-stop when it is the only item; otherwise for its seconds (5 minutes if empty).
  function channelRow(it, i, m) {
    return h('tr', {},
      h('td', {}, i + 1),
      h('td', {}, h('div', { class: 'mini-thumb' }, thumb(m))),
      h('td', {}, m.name, h('div', { class: 'hint' }, `live TV${m.group ? ` · ${m.group}` : ''} · ${draft.items.length > 1 ? 'empty seconds = 5 minutes' : 'empty seconds = non-stop'}`)),
      h('td', {}, h('input', { type: 'number', min: 0, step: 1, value: it.duration || '', placeholder: draft.items.length > 1 ? '300' : '∞', oninput: (e) => { it.duration = Number(e.target.value) || 0; } })),
      h('td', {}, h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: it.muted !== false, onchange: (e) => { it.muted = e.target.checked; } }), 'muted')),
      rowActions(i));
  }
  renderRows();

  const picker = () => {
    openModal(
      h('h1', {}, 'Add media or a channel'),
      media.some((m) => m.status === 'ready')
        ? mediaPicker(media, { onPick: (m) => { draft.items.push({ mediaId: m.id, duration: 0, muted: !isChannel(m) }); renderRows(); toast(`Added ${m.name}`); } })
        : h('p', { class: 'muted' }, 'No media uploaded yet — go to Media or Channels first.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: closeModal }, 'Done')));
  };

  const save = guard(async () => {
    await api('PUT', `/api/playlists/${pid}`, { name: draft.name, defaultDuration: draft.defaultDuration, items: draft.items, overlay: draft.overlay });
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
      h('div', { class: 'toolbar', style: 'margin-top:12px' }, h('button', { onclick: picker }, '+ Add media or channel'))),
    overlayEditor(draft, media));
}

// Ticker and logo shown on top of everything in a playlist.
function overlayEditor(draft, media) {
  draft.overlay ||= {};
  const o = draft.overlay;
  o.ticker ||= { text: '', position: 'bottom', speed: 'normal', size: 'medium', color: '#ffffff', background: '#000000' };
  o.logo ||= { mediaId: '', corner: 'top-right', size: 12 };
  const images = media.filter((m) => m.type === 'image' && m.status === 'ready');
  const select = (value, options, onchange) => h('select', { onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  // Colours are stored with transparency (e.g. #000000cc); the picker edits the colour part.
  const bg = (o.ticker.background || '#000000cc').slice(0, 7);
  return h('div', { class: 'card' },
    h('h2', {}, 'Ticker and logo'),
    h('p', { class: 'hint' }, 'Shown on top of this playlist, for example over a TV channel. Leave the text empty for no ticker.'),
    h('label', {}, 'Ticker text', h('textarea', { rows: 2, placeholder: 'Welcome to reception. Each line becomes a separate message.', oninput: (e) => { o.ticker.text = e.target.value; } }, o.ticker.text || '')),
    h('div', { class: 'form-grid' },
      h('label', {}, 'Position', select(o.ticker.position, [['bottom', 'Bottom'], ['top', 'Top']], (v) => { o.ticker.position = v; })),
      h('label', {}, 'Speed', select(o.ticker.speed, [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']], (v) => { o.ticker.speed = v; })),
      h('label', {}, 'Text size', select(o.ticker.size, [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], (v) => { o.ticker.size = v; })),
      h('label', {}, 'Text colour', h('input', { type: 'color', value: o.ticker.color || '#ffffff', oninput: (e) => { o.ticker.color = e.target.value; } })),
      h('label', {}, 'Bar colour', h('input', { type: 'color', value: bg, oninput: (e) => { o.ticker.background = `${e.target.value}cc`; } }))),
    h('div', { class: 'form-grid' },
      h('label', {}, 'Logo', images.length
        ? select(o.logo.mediaId || '', [['', 'No logo'], ...[...images].reverse().map((m) => [m.id, m.name])], (v) => { o.logo.mediaId = v; })
        : h('span', { class: 'hint' }, 'Upload a logo image under Media first (PNG with a transparent background works best).')),
      h('label', {}, 'Corner', select(o.logo.corner, [['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']], (v) => { o.logo.corner = v; })),
      h('label', {}, 'Logo width (% of screen)', h('input', { type: 'number', min: 3, max: 40, value: o.logo.size || 12, oninput: (e) => { o.logo.size = Number(e.target.value) || 12; } }))));
}

// Media and channel picker with search, for long channel lists.
function mediaPicker(media, { onPick, picked = () => 0, label = (m) => m.name }) {
  const ready = [...media].reverse().filter((m) => m.status === 'ready');
  const hasBoth = ready.some(isChannel) && ready.some((m) => !isChannel(m));
  let query = '';
  let kind = 'all';
  const LIMIT = 120;
  const grid = h('div', { class: 'picker' });
  const more = h('p', { class: 'hint' });
  const render = () => {
    const q = query.trim().toLowerCase();
    const list = ready.filter((m) => (kind === 'all' || (kind === 'live') === isChannel(m))
      && (!q || m.name.toLowerCase().includes(q) || (m.group || '').toLowerCase().includes(q)));
    grid.replaceChildren(...list.slice(0, LIMIT).map((m) => {
      const n = picked(m);
      return h('button', { type: 'button', class: n ? 'picked' : '', onclick: () => { onPick(m); render(); } }, thumb(m), h('span', { title: m.name }, label(m)));
    }));
    more.textContent = list.length > LIMIT ? `Showing ${LIMIT} of ${list.length}: type to narrow it down.` : list.length ? '' : 'Nothing matches.';
  };
  render();
  return h('div', {},
    h('div', { class: 'picker-controls' },
      h('input', { type: 'search', placeholder: 'Search by name or group', oninput: (e) => { query = e.target.value; render(); } }),
      hasBoth ? h('select', { onchange: (e) => { kind = e.target.value; render(); } },
        h('option', { value: 'all' }, 'Everything'), h('option', { value: 'files' }, 'Images, videos, decks'), h('option', { value: 'live' }, 'TV channels')) : ''),
    grid, more);
}

// ---------- channels ----------
async function channelsView() {
  const channels = (await api('GET', '/api/media')).filter(isChannel);
  const groups = [...new Set(channels.map((c) => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const selected = new Set();
  let query = '';
  let group = '';
  const LIMIT = 300;
  const tbody = h('tbody');
  const count = h('span', { class: 'muted' });
  const deleteSelected = h('button', { class: 'danger', hidden: true, onclick: guard(async () => {
    if (!confirm(`Delete ${selected.size} channel(s)? They are removed from every playlist.`)) return;
    await api('POST', '/api/channels/delete', { ids: [...selected] });
    channelsView();
  }) });
  const visible = () => {
    const q = query.trim().toLowerCase();
    return channels.filter((c) => (!group || c.group === group) && (!q || c.name.toLowerCase().includes(q) || c.url.toLowerCase().includes(q)));
  };
  const syncSelection = () => {
    deleteSelected.hidden = !selected.size;
    deleteSelected.textContent = `Delete ${selected.size} selected`;
  };
  const render = () => {
    const list = visible();
    count.textContent = `${list.length} of ${channels.length} channels${list.length > LIMIT ? ` (showing ${LIMIT}: search to narrow down)` : ''}`;
    tbody.replaceChildren(...list.slice(0, LIMIT).map((c) => h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', checked: selected.has(c.id), onchange: (e) => { e.target.checked ? selected.add(c.id) : selected.delete(c.id); syncSelection(); } })),
      h('td', {}, h('div', { class: 'mini-thumb' }, thumb(c))),
      h('td', {}, h('strong', {}, c.name), h('div', { class: 'hint mono', title: c.url }, c.url.length > 70 ? `${c.url.slice(0, 67)}…` : c.url)),
      h('td', {}, c.group || h('span', { class: 'muted' }, '—')),
      h('td', {}, { hls: 'HLS', ts: 'MPEG-TS', file: 'Video file' }[c.format] || c.format, c.relay === 'always' ? h('div', { class: 'hint' }, 'via server') : ''),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small', onclick: () => channelPreview(c) }, 'Preview'),
        h('button', { class: 'small', onclick: guard(() => playNowDialog({ channel: c })) }, 'Play on…'),
        h('button', { class: 'small', onclick: () => channelEditor(c) }, 'Edit'),
        h('button', { class: 'small danger', onclick: guard(async () => {
          if (!confirm(`Delete “${c.name}”? It is removed from every playlist.`)) return;
          await api('DELETE', `/api/media/${c.id}`);
          channelsView();
        }) }, '✕'))))));
  };
  const allBox = h('input', { type: 'checkbox', title: 'Select all shown', onchange: (e) => {
    for (const c of visible().slice(0, LIMIT)) e.target.checked ? selected.add(c.id) : selected.delete(c.id);
    syncSelection();
    render();
  } });

  view.replaceChildren(
    h('div', { class: 'toolbar' },
      h('h1', {}, 'Channels'),
      h('button', { onclick: () => importDialog() }, 'Import channel list'),
      h('button', { class: 'primary', onclick: () => channelEditor(null) }, '+ Add channel')),
    channels.length
      ? h('div', { class: 'card' },
        h('div', { class: 'picker-controls' },
          h('input', { type: 'search', placeholder: 'Search channels', oninput: (e) => { query = e.target.value; render(); } }),
          groups.length ? h('select', { onchange: (e) => { group = e.target.value; render(); } },
            h('option', { value: '' }, 'All groups'), groups.map((g) => h('option', { value: g }, g))) : '',
          count, deleteSelected),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, allBox), ['', 'Channel', 'Group', 'Type', ''].map((t) => h('th', {}, t)))), tbody)))
      : h('div', { class: 'card empty' },
        h('p', {}, 'No TV channels yet.'),
        h('p', {}, 'Add a stream link (for example https://…/live.m3u8 from your IPTV provider or a streaming encoder), or import your provider’s channel list (.m3u). Channels then go into playlists, the Schedule, or straight onto screens with ', h('strong', {}, 'Play now'), '.')),
    h('p', { class: 'hint' }, 'Screens play channels straight from the source. If a screen can’t open a stream directly (some providers block browsers), it plays it through this server instead, which uses this server’s internet connection.'));
  render();
}

function channelEditor(c) {
  const draft = c ? { ...c } : { name: '', url: '', logo: '', group: '', relay: 'auto' };
  const save = guard(async () => {
    const body = { name: draft.name, url: draft.url, logo: draft.logo, group: draft.group, relay: draft.relay };
    if (c) await api('PUT', `/api/channels/${c.id}`, body); else await api('POST', '/api/channels', body);
    closeModal();
    toast(c ? 'Saved — screens update now' : 'Channel added');
    channelsView();
  });
  openModal(
    h('h1', {}, c ? `Edit ${c.name}` : 'Add channel'),
    h('label', {}, 'Stream link', h('input', { value: draft.url, placeholder: 'https://example.com/live/channel.m3u8', oninput: (e) => { draft.url = e.target.value; } }),
      h('span', { class: 'hint' }, 'HLS (.m3u8), MPEG-TS over HTTP (common in IPTV lists) or a video file link.')),
    h('label', {}, 'Name', h('input', { value: draft.name, placeholder: 'e.g. BBC News', oninput: (e) => { draft.name = e.target.value; } })),
    h('div', { class: 'form-grid' },
      h('label', {}, 'Group', h('input', { value: draft.group, placeholder: 'optional, e.g. News', oninput: (e) => { draft.group = e.target.value; } })),
      h('label', {}, 'Logo link', h('input', { value: draft.logo, placeholder: 'optional, https://…/logo.png', oninput: (e) => { draft.logo = e.target.value; } }))),
    h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: draft.relay === 'always', onchange: (e) => { draft.relay = e.target.checked ? 'always' : 'auto'; } }),
      'Always play through this server'),
    h('p', { class: 'hint' }, 'Turn this on when the stream only works from this server’s network (e.g. a provider that checks the address), or so many screens on the same channel share one download.'),
    h('div', { class: 'modal-actions' }, h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: save }, c ? 'Save' : 'Add')));
}

function importDialog() {
  let source = 'url';
  let found = null;
  const groupSet = new Set();
  const urlInput = h('input', { placeholder: 'https://provider.example/get.php?…&type=m3u_plus' });
  const textInput = h('textarea', { rows: 6, placeholder: '#EXTM3U\n#EXTINF:-1 group-title="News",News 24\nhttps://…/news24.m3u8', hidden: true });
  const groupSlot = h('div');
  const readRow = h('div', { class: 'modal-actions' }, h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: () => read() }, 'Read list'));
  const body = () => (source === 'url' ? { url: urlInput.value.trim() } : { text: textInput.value });
  const read = guard(async () => {
    found = await api('POST', '/api/channels/import', { ...body(), preview: true });
    groupSet.clear();
    for (const g of found.groups) groupSet.add(g.name);
    const named = found.groups.map((g) => ({ id: g.name, name: g.name || 'No group', count: g.count }));
    groupSlot.replaceChildren(
      h('p', {}, `${found.total} channels in ${found.groups.length} group(s). Untick the groups you don’t want.`),
      found.groups.length > 1 ? memberChecklist(named, groupSet, (g) => `${g.name} (${g.count})`) : '',
      h('div', { class: 'modal-actions' }, h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: doImport }, 'Import')));
    readRow.hidden = true;
  });
  const doImport = guard(async () => {
    const res = await api('POST', '/api/channels/import', { ...body(), groups: [...groupSet] });
    closeModal();
    toast(`Imported ${res.created} channel(s)${res.skipped ? `, ${res.skipped} skipped (already added or not chosen)` : ''}`);
    channelsView();
  });
  const radio = (value, label) => h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'm3u-source', checked: source === value, onchange: () => {
    source = value; urlInput.hidden = value !== 'url'; textInput.hidden = value !== 'text';
  } }), label);
  openModal(
    h('h1', {}, 'Import channel list'),
    h('p', {}, 'IPTV providers give a channel list as an .m3u link or file. All its channels are added here, with their names, groups and logos.'),
    h('div', { class: 'segmented' }, radio('url', 'Link to the list'), radio('text', 'Paste the list')),
    urlInput, textInput, readRow, groupSlot);
}

// Plays a channel in the console with the same libraries the screens use.
async function channelPreview(c) {
  const video = h('video', { controls: true, muted: true, autoplay: true, playsinline: true, class: 'channel-preview' });
  const status = h('p', { class: 'hint' }, 'Connecting…');
  let engine = null;
  const stop = () => { try { engine?.destroy(); } catch {} engine = null; video.removeAttribute('src'); video.load(); };
  const loadLib = (file, global) => new Promise((resolve, reject) => {
    if (window[global]) return resolve(window[global]);
    const s = document.createElement('script');
    s.src = `/player/${file}`;
    s.onload = () => resolve(window[global]);
    s.onerror = reject;
    document.head.append(s);
  });
  const play = async (src) => {
    stop();
    return new Promise(async (resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no picture after 20 seconds')), 20_000);
      video.onplaying = () => { clearTimeout(t); resolve(); };
      video.onerror = () => { clearTimeout(t); reject(new Error('the browser could not play it')); };
      try {
        if (c.format === 'hls') {
          const Hls = await loadLib('hls.min.js', 'Hls');
          if (Hls.isSupported()) {
            engine = new Hls();
            engine.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) { clearTimeout(t); reject(new Error(d.details)); } });
            engine.loadSource(src);
            engine.attachMedia(video);
          } else video.src = src;
        } else if (c.format === 'ts') {
          const mpegts = await loadLib('mpegts.js', 'mpegts');
          engine = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src });
          engine.on(mpegts.Events.ERROR, (type, detail) => { clearTimeout(t); reject(new Error(`${type} ${detail}`)); });
          engine.attachMediaElement(video);
          engine.load();
        } else video.src = src;
        video.play().catch(() => {});
      } catch (err) { clearTimeout(t); reject(err); }
    });
  };
  const viaServer = guard(async () => {
    status.textContent = 'Connecting through the server…';
    const { relay } = await api('GET', `/api/channels/${c.id}/relay`);
    try { await play(relay); status.textContent = 'Playing through this server. Screens that can’t open the stream directly do the same.'; } catch (err) { status.textContent = `It doesn’t play through the server either (${err.message}). Check the link with your provider.`; }
  });
  modal.addEventListener('close', stop, { once: true });
  openModal(
    h('h1', {}, c.name),
    video, status,
    h('div', { class: 'modal-actions' }, h('button', { onclick: viaServer }, 'Try through the server'), h('button', { class: 'primary', onclick: closeModal }, 'Close')));
  if (c.relay === 'always') return viaServer();
  try { await play(c.url); status.textContent = 'Playing straight from the source.'; } catch (err) {
    status.textContent = `This browser can’t open the stream directly (${err.message}). Trying through the server…`;
    viaServer();
  }
}

// Puts a channel, media or a playlist on screens now, ahead of their schedule.
async function playNowDialog({ channel = null, screenIds = [], groupIds = [] } = {}) {
  const [media, playlists, screens, groups] = await Promise.all([api('GET', '/api/media'), listPlaylists(), api('GET', '/api/screens'), api('GET', '/api/groups')]);
  const screenSet = new Set(screenIds);
  const groupSet = new Set(groupIds);
  let what = channel || !playlists.length ? 'media' : 'playlist';
  let pickedMedia = channel;
  let playlistId = playlists[0]?.id;
  let sound = true;
  let minutes = '60';
  const pickedLabel = h('p', { class: 'hint' });
  const showPicked = () => { pickedLabel.textContent = pickedMedia ? `Selected: ${pickedMedia.name}` : 'Click a channel or media item.'; };
  showPicked();
  const mediaPane = h('div', {},
    mediaPicker(media, { picked: (m) => (pickedMedia?.id === m.id ? 1 : 0), onPick: (m) => { pickedMedia = m; showPicked(); } }),
    pickedLabel,
    h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: sound, onchange: (e) => { sound = e.target.checked; } }), 'Sound on (TV channels and videos)'));
  const playlistPane = h('div', {}, playlists.length
    ? h('select', { onchange: (e) => { playlistId = e.target.value; } }, playlists.map((p) => h('option', { value: p.id }, p.name)))
    : h('p', { class: 'muted' }, 'No playlists yet.'));
  const showWhat = () => { mediaPane.hidden = what !== 'media'; playlistPane.hidden = what !== 'playlist'; };
  showWhat();
  const radio = (name, checked, label, onchange) => h('label', { class: 'inline' }, h('input', { type: 'radio', name, checked, onchange }), label);
  const start = guard(async () => {
    const targets = { screenIds: [...screenSet], groupIds: [...groupSet] };
    if (!targets.screenIds.length && !targets.groupIds.length) return toast('Choose at least one screen or group');
    let content;
    if (what === 'media') {
      if (!pickedMedia) return toast('Choose a channel or media item');
      content = { type: 'media', items: [{ mediaId: pickedMedia.id, duration: 0, muted: !sound }] };
    } else content = { type: 'playlist', playlistId };
    let until = null;
    if (minutes === 'today') until = new Date(new Date().setHours(24, 0, 0, 0)).toISOString();
    const res = await api('POST', '/api/play-now', { targets, content, minutes: minutes === 'today' || minutes === 'stop' ? 0 : Number(minutes), until });
    closeModal();
    toast(`Playing on ${res.screens.length} screen(s)`);
    if (location.hash === '#/screens' || location.hash === '') screensView();
  });
  openModal(
    h('h1', {}, 'Play now'),
    h('p', { class: 'hint' }, 'Shows this straight away, ahead of the schedule. When it ends (or you press Stop on the screen), the screen goes back to its schedule.'),
    h('div', { class: 'step' }, h('h2', {}, 'What'),
      h('div', { class: 'segmented' },
        radio('pn-what', what === 'media', 'A channel or media item', () => { what = 'media'; showWhat(); }),
        radio('pn-what', what === 'playlist', 'A playlist', () => { what = 'playlist'; showWhat(); })),
      mediaPane, playlistPane),
    h('div', { class: 'step' }, h('h2', {}, 'Where'),
      groups.length ? [h('div', { class: 'field-label' }, 'Groups'), memberChecklist(groups, groupSet, (g) => g.name)] : '',
      h('div', { class: 'field-label' }, 'Screens'), memberChecklist(screens, screenSet, (x) => x.name)),
    h('div', { class: 'step' }, h('h2', {}, 'For how long'),
      h('select', { onchange: (e) => { minutes = e.target.value; } },
        [['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours'], ['today', 'Until the end of today'], ['stop', 'Until I stop it']]
          .map(([v, label]) => h('option', { value: v, selected: v === minutes }, label)))),
    h('div', { class: 'modal-actions' }, h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: start }, 'Play now')));
}

// ---------- schedule ----------
const SCHEDULE_COLORS = ['#2f6fed', '#d97706', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#65a30d', '#dc2626'];
// One colour per playlist, assigned in order so the ones on a page differ.
let scheduleColors = new Map();
function colorFor(id) {
  if (!scheduleColors.has(id)) scheduleColors.set(id, SCHEDULE_COLORS[scheduleColors.size % SCHEDULE_COLORS.length]);
  return scheduleColors.get(id);
}

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon … Sun
function whenText(e) {
  const days = e.days?.length && e.days.length < 7
    ? (e.days.join() === '1,2,3,4,5' ? 'Weekdays' : e.days.join() === '0,6' ? 'Weekends' : DAY_ORDER.filter((d) => e.days.includes(d)).map((d) => DAYS[d]).join(', '))
    : 'Every day';
  const time = e.start === e.end ? 'all day' : `${e.start}–${e.end}`;
  const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const dates = e.startDate || e.endDate ? ` · ${e.startDate ? fmt(e.startDate) : '…'} – ${e.endDate ? fmt(e.endDate) : '…'}` : '';
  return `${days}, ${time}${dates}`;
}

async function scheduleView(kind, targetId) {
  const [entries, screens, groups, playlists, media] = await Promise.all([
    api('GET', '/api/schedules'), api('GET', '/api/screens'), api('GET', '/api/groups'), listPlaylists(), api('GET', '/api/media'),
  ]);
  const ctx = { screens, groups, playlists, media };
  scheduleColors = new Map();
  for (const pid of [...new Set([...entries.map((e) => e.playlistId), ...playlists.map((pl) => pl.id)])]) colorFor(pid);
  if (!kind) {
    if (screens[0]) { kind = 'screen'; targetId = screens[0].id; } else if (groups[0]) { kind = 'group'; targetId = groups[0].id; }
  }
  const target = kind === 'screen' ? screens.find((x) => x.id === targetId) : groups.find((x) => x.id === targetId);
  const affects = (e) => target && (kind === 'screen'
    ? e.targets.screenIds.includes(target.id) || e.targets.groupIds.some((gid) => target.groupIds.includes(gid))
    : e.targets.groupIds.includes(target.id));
  const nameOf = (list, xid) => list.find((x) => x.id === xid)?.name;

  const picker = h('select', { onchange: (e) => { location.hash = `#/schedule/${e.target.value}`; } },
    screens.length ? h('optgroup', { label: 'Screens' }, screens.map((x) => h('option', { value: `screen/${x.id}`, selected: kind === 'screen' && x.id === targetId }, x.name))) : '',
    groups.length ? h('optgroup', { label: 'Groups' }, groups.map((x) => h('option', { value: `group/${x.id}`, selected: kind === 'group' && x.id === targetId }, x.name))) : '');

  const defaultSelect = target && h('select', { onchange: guard(async (e) => {
    await api('PUT', `/api/${kind === 'screen' ? 'screens' : 'groups'}/${target.id}`, { defaultPlaylistId: e.target.value || null });
    toast('Saved');
    scheduleView(kind, targetId);
  }) }, h('option', { value: '' }, kind === 'screen' ? '— none (use its group’s) —' : '— none —'),
  playlists.map((pl) => h('option', { value: pl.id, selected: pl.id === target.defaultPlaylistId }, pl.name)));

  const weekSlot = h('div', { class: 'week-slot' }, h('p', { class: 'muted' }, 'Loading…'));
  const row = (e) => h('tr', { class: affects(e) ? 'affects' : '' },
    h('td', {}, h('input', { type: 'checkbox', checked: e.enabled !== false, title: 'On / off', onchange: guard(async (ev) => {
      await api('PUT', `/api/schedules/${e.id}`, { enabled: ev.target.checked });
      scheduleView(kind, targetId);
    }) })),
    h('td', {}, h('span', { class: 'swatch', style: `background:${colorFor(e.playlistId)}` }), h('strong', {}, e.name),
      h('div', { class: 'hint' }, e.content.type === 'media' ? `${e.content.items.length} media item${e.content.items.length === 1 ? '' : 's'}` : `Playlist: ${e.content.name || '—'}`)),
    h('td', {}, h('div', { class: 'chips' },
      e.targets.groupIds.map((gid) => h('span', { class: 'badge-inline' }, '👥 ', nameOf(groups, gid) || '?')),
      e.targets.screenIds.map((sid) => h('span', { class: 'badge-inline' }, nameOf(screens, sid) || '?')),
      !e.targets.groupIds.length && !e.targets.screenIds.length ? h('span', { class: 'status-error' }, 'No screens') : '')),
    h('td', {}, whenText(e)),
    h('td', {}, e.priority || 0),
    h('td', {}, h('div', { class: 'actions' },
      h('button', { class: 'small', onclick: () => entryEditor(e, ctx, () => scheduleView(kind, targetId)) }, 'Edit'),
      h('button', { class: 'small danger', onclick: guard(async () => {
        if (!confirm(`Remove “${e.name}” from the schedule?`)) return;
        await api('DELETE', `/api/schedules/${e.id}`);
        scheduleView(kind, targetId);
      }) }, '✕'))));

  const sorted = [...entries].sort((a, b) => Number(affects(b)) - Number(affects(a)));
  view.replaceChildren(
    h('div', { class: 'toolbar' },
      h('h1', {}, 'Schedule'),
      h('button', { class: 'primary', disabled: !screens.length && !groups.length, onclick: () => entryEditor(null, ctx, () => scheduleView(kind, targetId), { kind, id: targetId }) }, '+ Schedule content')),
    !screens.length && !groups.length
      ? h('div', { class: 'card empty' }, 'Add a screen first, then schedule content to it here.')
      : h('div', { class: 'card week-card' },
        h('div', { class: 'week-head' },
          h('label', { class: 'inline' }, 'Week view for ', picker),
          defaultSelect && h('label', { class: 'inline' }, 'When nothing is scheduled: ', defaultSelect)),
        weekSlot),
    h('h2', {}, 'Scheduled content'),
    entries.length
      ? h('div', { class: 'card table-wrap' }, h('table', { class: 'schedule-table' },
        h('thead', {}, h('tr', {}, ['On', 'Content', 'Screens & groups', 'When', 'Priority', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, sorted.map(row))))
      : h('div', { class: 'card empty' }, 'Nothing scheduled yet. Click “+ Schedule content” to choose screens, content and times.'));

  if (target) {
    const week = await api('GET', `/api/schedule/week?${kind}Id=${encodeURIComponent(target.id)}`);
    weekSlot.replaceChildren(weekGrid(week));
  }
}

function weekGrid(week) {
  const tz = week.timezone;
  const dayFmt = new Intl.DateTimeFormat([], { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  const timeFmt = new Intl.DateTimeFormat([], { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const days = week.dayStarts.slice(0, 7).map((start, i) => {
    const end = week.dayStarts[i + 1];
    const col = h('div', { class: 'week-day' });
    for (const b of week.blocks) {
      const from = Math.max(b.from, start);
      const to = Math.min(b.to, end);
      if (to <= from) continue;
      const top = ((from - start) / (end - start)) * 100;
      const height = ((to - from) / (end - start)) * 100;
      const label = b.playlistName || 'Nothing scheduled';
      const range = `${timeFmt.format(b.from)}–${timeFmt.format(b.to)}`;
      col.append(h('div', {
        class: `week-block ${b.scheduleId ? '' : 'is-default'} ${b.playlistId ? '' : 'is-empty'}`,
        style: `top:${top}%;height:${height}%;--c:${b.playlistId ? colorFor(b.playlistId) : '#8a93a3'}`,
        title: `${label}\n${range}\n${b.scheduleName ? `Scheduled: ${b.scheduleName}` : 'Default playlist (nothing scheduled)'}`,
      }, height > 3.5 ? h('span', {}, label, height > 7 ? h('small', {}, range) : '') : ''));
    }
    if (week.now >= start && week.now < end) col.append(h('div', { class: 'week-now', style: `top:${((week.now - start) / (end - start)) * 100}%` }));
    return h('div', { class: 'week-col' }, h('div', { class: 'week-label' }, i === 0 ? 'Today' : dayFmt.format(start)), col);
  });
  const hours = h('div', { class: 'week-hours' }, [0, 3, 6, 9, 12, 15, 18, 21].map((hr) => h('span', { style: `top:${(hr / 24) * 100}%` }, `${String(hr).padStart(2, '0')}:00`)));
  return h('div', {},
    h('div', { class: 'week-grid' }, h('div', { class: 'week-col week-col-hours' }, h('div', { class: 'week-label' }, ''), hours), ...days),
    h('p', { class: 'hint' }, `Times in ${tz}. Solid blocks are scheduled content; pale blocks are the default playlist. Hover a block for details.`));
}

function entryEditor(entry, { screens, groups, playlists, media }, done, preselect) {
  const isNew = !entry;
  const draft = entry ? structuredClone(entry) : {
    name: '', targets: { screenIds: preselect?.kind === 'screen' ? [preselect.id] : [], groupIds: preselect?.kind === 'group' ? [preselect.id] : [] },
    content: { type: playlists.length ? 'playlist' : 'media', playlistId: playlists[0]?.id, items: [], seconds: 10 },
    days: [], start: '00:00', end: '00:00', startDate: null, endDate: null, priority: 0, enabled: true,
  };
  if (draft.content.type === 'media') draft.content.items ||= [];
  draft.content.seconds ||= 10;
  const screenSet = new Set(draft.targets.screenIds);
  const groupSet = new Set(draft.targets.groupIds);
  let always = draft.start === draft.end && !draft.days?.length && !draft.startDate && !draft.endDate;
  const ready = media.filter((m) => m.status === 'ready');

  // What
  const playlistPane = h('div', {}, playlists.length
    ? h('select', { onchange: (e) => { draft.content.playlistId = e.target.value; } },
      playlists.map((pl) => h('option', { value: pl.id, selected: pl.id === draft.content.playlistId }, pl.name)))
    : h('p', { class: 'muted' }, 'No playlists yet: choose media instead, or create one under Playlists.'));
  const order = h('p', { class: 'hint' });
  const position = (m) => draft.content.items.findIndex((it) => it.mediaId === m.id) + 1;
  const renderOrder = () => {
    order.textContent = draft.content.items.length ? `${draft.content.items.length} selected; they play in the order you picked them.` : 'Click media or channels to add them, in the order they should play.';
  };
  const mediaGrid = mediaPicker(media, {
    picked: position,
    label: (m) => (position(m) ? `${position(m)}. ${m.name}` : m.name),
    onPick: (m) => {
      const n = position(m);
      if (n) draft.content.items.splice(n - 1, 1); else draft.content.items.push({ mediaId: m.id, duration: 0, muted: !isChannel(m) });
      renderOrder();
    },
  });
  renderOrder();
  const mediaPane = h('div', {},
    ready.length ? mediaGrid : h('p', { class: 'muted' }, 'No media yet: upload some under Media first.'), order,
    h('label', { class: 'inline' }, 'Seconds per image or slide ', h('input', { type: 'number', min: 1, value: draft.content.seconds, style: 'width:80px', oninput: (e) => { draft.content.seconds = Number(e.target.value) || 10; } })));
  const showWhat = () => { playlistPane.hidden = draft.content.type !== 'playlist'; mediaPane.hidden = draft.content.type !== 'media'; };
  showWhat();

  // When
  const dayBoxes = h('div', { class: 'day-toggles' });
  const renderDays = () => dayBoxes.replaceChildren(...DAY_ORDER.map((d) => {
    const on = !draft.days.length || draft.days.includes(d);
    return h('button', { type: 'button', class: on ? 'on' : '', onclick: () => {
      const set = new Set(draft.days.length ? draft.days : [0, 1, 2, 3, 4, 5, 6]);
      set.has(d) ? set.delete(d) : set.add(d);
      draft.days = set.size === 7 ? [] : [...set].sort();
      renderDays();
    } }, DAYS[d]);
  }), h('span', { class: 'quick' },
    h('button', { type: 'button', class: 'small ghost', onclick: () => { draft.days = []; renderDays(); } }, 'Every day'),
    h('button', { type: 'button', class: 'small ghost', onclick: () => { draft.days = [1, 2, 3, 4, 5]; renderDays(); } }, 'Weekdays'),
    h('button', { type: 'button', class: 'small ghost', onclick: () => { draft.days = [0, 6]; renderDays(); } }, 'Weekends')));
  renderDays();
  const hasDates = h('input', { type: 'checkbox', checked: Boolean(draft.startDate || draft.endDate), onchange: (e) => { datesRow.hidden = !e.target.checked; if (!e.target.checked) { draft.startDate = null; draft.endDate = null; } } });
  const datesRow = h('div', { class: 'form-grid', hidden: !(draft.startDate || draft.endDate) },
    h('label', {}, 'From date', h('input', { type: 'date', value: draft.startDate || '', onchange: (e) => { draft.startDate = e.target.value || null; } })),
    h('label', {}, 'To date', h('input', { type: 'date', value: draft.endDate || '', onchange: (e) => { draft.endDate = e.target.value || null; } })));
  const timesPane = h('div', { class: 'when-pane' },
    h('div', {}, h('div', { class: 'field-label' }, 'Days'), dayBoxes),
    h('div', { class: 'form-grid' },
      h('label', {}, 'From', h('input', { type: 'time', value: draft.start === draft.end ? '09:00' : draft.start, onchange: (e) => { draft.start = e.target.value; } })),
      h('label', {}, 'To', h('input', { type: 'time', value: draft.start === draft.end ? '17:00' : draft.end, onchange: (e) => { draft.end = e.target.value; } }),
        h('span', { class: 'hint' }, 'Earlier than “From” runs overnight.'))),
    h('label', { class: 'inline' }, hasDates, 'Only between certain dates'),
    datesRow);
  const showWhen = () => { timesPane.hidden = always; };
  showWhen();

  const radio = (name, checked, label, onchange) => h('label', { class: 'inline' }, h('input', { type: 'radio', name, checked, onchange }), label);
  const save = guard(async () => {
    const targets = { screenIds: [...screenSet], groupIds: [...groupSet] };
    if (!targets.screenIds.length && !targets.groupIds.length) return toast('Choose at least one screen or group');
    let timing;
    if (always) timing = { days: [], start: '00:00', end: '00:00', startDate: null, endDate: null };
    else {
      if (draft.start === draft.end) { draft.start = timesPane.querySelectorAll('input[type=time]')[0].value; draft.end = timesPane.querySelectorAll('input[type=time]')[1].value; }
      timing = { days: draft.days, start: draft.start, end: draft.end, startDate: draft.startDate, endDate: draft.endDate };
    }
    const body = { name: draft.name, targets, content: draft.content, priority: draft.priority, enabled: draft.enabled, ...timing };
    if (isNew) await api('POST', '/api/schedules', body); else await api('PUT', `/api/schedules/${entry.id}`, body);
    closeModal();
    toast('Scheduled — screens update now');
    done();
  });

  openModal(
    h('h1', {}, isNew ? 'Schedule content' : `Edit “${entry.name}”`),
    h('div', { class: 'step' }, h('h2', {}, '1. Where'),
      groups.length ? [h('div', { class: 'field-label' }, 'Groups'), memberChecklist(groups, groupSet, (g) => `${g.name} (${screens.filter((x) => x.groupIds.includes(g.id)).length})`)] : '',
      h('div', { class: 'field-label' }, 'Screens'), memberChecklist(screens, screenSet, (x) => x.name)),
    h('div', { class: 'step' }, h('h2', {}, '2. What'),
      h('div', { class: 'segmented' },
        radio('what', draft.content.type === 'playlist', 'A playlist', () => { draft.content.type = 'playlist'; draft.content.playlistId ||= playlists[0]?.id; showWhat(); }),
        radio('what', draft.content.type === 'media', 'Choose media', () => { draft.content.type = 'media'; showWhat(); })),
      playlistPane, mediaPane),
    h('div', { class: 'step' }, h('h2', {}, '3. When'),
      h('div', { class: 'segmented' },
        radio('when', always, 'Always', () => { always = true; showWhen(); }),
        radio('when', !always, 'At set times', () => { always = false; showWhen(); })),
      timesPane),
    h('details', {}, h('summary', {}, 'Name and priority'),
      h('div', { class: 'form-grid' },
        h('label', {}, 'Name', h('input', { value: draft.name, placeholder: 'e.g. Lunch menu', oninput: (e) => { draft.name = e.target.value; } })),
        h('label', {}, 'Priority', h('input', { type: 'number', value: draft.priority || 0, oninput: (e) => { draft.priority = Number(e.target.value) || 0; } }),
          h('span', { class: 'hint' }, 'When two schedules overlap, the higher number wins.')))),
    h('div', { class: 'modal-actions' },
      h('button', { onclick: closeModal }, 'Cancel'),
      h('button', { class: 'primary', onclick: save }, isNew ? 'Schedule' : 'Save')));
}

// ---------- settings ----------
async function settingsView() {
  info = await api('GET', '/api/info');
  const general = { serverName: info.serverName, allowPlaintext: info.allowPlaintext };
  const offline = { message: info.offline.message, qr: info.offline.qr, position: info.offline.position };
  const saveGeneral = guard(async () => {
    const res = await api('PUT', '/api/settings', { ...general, offline });
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
    h('h2', {}, 'When a screen loses its connection'),
    h('div', { class: 'card' },
      h('p', { class: 'hint' }, 'After 15 seconds without the server, screens show a small “Reconnecting…” box and keep playing what they have. Add a message or QR code to show with it. Screens store this with their content, so it works while the server is unreachable. Individual screens can override it under Edit.'),
      offlineFields(offline),
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
