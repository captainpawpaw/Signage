// Board editor: changes what a board shows, from a phone or laptop. Opened
// through a board's private editor link (/b/<token>, maybe with a PIN), or
// from the console (/admin/board-edit.html#board=<id>). Every change is on the
// screens within a second.
(() => {
  'use strict';

  const linkToken = /^\/b\/([^/?#]+)/.exec(location.pathname)?.[1];
  const boardId = new URLSearchParams(location.hash.slice(1)).get('board');
  const base = linkToken ? `/edit/${encodeURIComponent(linkToken)}` : `/api/boards/${encodeURIComponent(boardId || '')}`;
  const PIN_KEY = `signage.pin.${base}`;
  let pin = (() => { try { return sessionStorage.getItem(PIN_KEY) || ''; } catch { return ''; } })();
  let board = null;
  let tab = 'content';

  const $ = (sel) => document.querySelector(sel);
  const main = $('#main');

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else if (k === 'value') node.value = v;
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false && c !== '') node.append(c instanceof Node ? c : String(c));
    return node;
  }

  function status(text, kind = '') {
    const el = $('#status');
    el.textContent = text;
    el.className = `status ${kind}`;
  }

  async function api(method, path = '', body) {
    const opts = { method, headers: pin ? { 'X-Board-Pin': pin } : {} };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(base + path, opts);
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
    if (res.status === 403 && data.error === 'PIN required') { askPin(Boolean(pin)); throw new Error('PIN required'); }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  const mediaUrl = (mediaId) => `${base}/media/${encodeURIComponent(mediaId)}${pin ? `?pin=${encodeURIComponent(pin)}` : ''}`;

  // ---------- PIN ----------
  function askPin(wrong) {
    status('');
    const input = h('input', { type: 'tel', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', placeholder: 'PIN' });
    const go = async (e) => {
      e?.preventDefault();
      pin = input.value.trim();
      try { sessionStorage.setItem(PIN_KEY, pin); } catch {}
      load();
    };
    main.replaceChildren(h('form', { class: 'card pin', onsubmit: go },
      h('h2', {}, 'Enter the PIN'),
      h('p', { class: 'hint' }, wrong ? 'That PIN is not right. Try again.' : 'This board is protected with a PIN. Ask whoever sent you the link.'),
      input,
      h('button', { class: 'primary', type: 'submit' }, 'Open')));
    input.focus();
  }

  // ---------- saving ----------
  const timers = {};
  function saveSoon(what) {
    status('Saving…', 'busy');
    clearTimeout(timers[what]);
    timers[what] = setTimeout(() => save(what), 600);
  }
  async function save(what) {
    try {
      if (what === 'values') await api('PUT', '/values', { values: board.values });
      else await api('PUT', '/steps', { steps: board.steps });
      status('Saved · on screen', 'ok');
    } catch (err) { status(err.message, 'error'); }
  }

  // ---------- preview ----------
  let preview = null;
  const previewBox = h('div', { class: 'preview' });
  function shownValues() {
    const step = board.steps[board.step];
    return { ...board.values, ...(step?.values || {}) };
  }
  function drawPreview() {
    preview?.destroy();
    const values = shownValues();
    const [aw, ah] = board.aspect || [16, 9];
    previewBox.style.aspectRatio = `${aw} / ${ah}`;
    const view = {
      aspect: board.aspect,
      background: { color: board.background?.color, image: board.background?.mediaId ? { mediaId: board.background.mediaId } : null },
      fields: board.fields.map((f) => ({
        ...f, value: f.kind === 'image' ? (values[f.id] ? { mediaId: values[f.id] } : null) : values[f.id] ?? (f.kind === 'list' ? [] : ''),
      })),
    };
    preview = self.SignageBoard.render(previewBox, view, (img) => mediaUrl(img.mediaId));
  }
  let previewTimer;
  const previewSoon = () => { clearTimeout(previewTimer); previewTimer = setTimeout(drawPreview, 150); };

  // ---------- field editors ----------
  // values: the object being edited (the board's values, or a step's).
  // fallback: what shows when a step leaves a field empty.
  function fieldEditor(f, values, onChange, fallback = {}) {
    if (f.kind === 'text') {
      const multi = (values[f.id] || fallback[f.id] || '').includes('\n') || f.h > 0.12;
      const input = h(multi ? 'textarea' : 'input', {
        type: multi ? undefined : 'text', rows: multi ? 2 : undefined, value: values[f.id] ?? '',
        placeholder: fallback[f.id] ? `As on the main board: ${fallback[f.id]}` : '',
        oninput: (e) => { if (e.target.value) values[f.id] = e.target.value; else delete values[f.id]; onChange(); },
      });
      return h('label', { class: 'field' }, f.name, input);
    }
    if (f.kind === 'image') {
      const slot = h('div', { class: 'photo' });
      const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
        const chosen = e.target.files?.[0];
        if (!chosen) return;
        status('Uploading photo…', 'busy');
        try {
          const fd = new FormData();
          fd.append('file', await shrink(chosen), chosen.name.replace(/\.(heic|heif)$/i, '.jpg'));
          const { mediaId } = await api('POST', '/upload', fd);
          values[f.id] = mediaId;
          paint();
          onChange();
        } catch (err) { status(err.message, 'error'); }
        e.target.value = '';
      } });
      const paint = () => {
        const id = values[f.id] || fallback[f.id];
        slot.replaceChildren(
          id ? h('img', { src: mediaUrl(id), alt: '' }) : h('span', { class: 'muted' }, 'No photo'),
          h('button', { type: 'button', onclick: () => file.click() }, values[f.id] ? 'Change photo' : 'Take or choose photo'),
          values[f.id] ? h('button', { type: 'button', class: 'small danger', onclick: () => { delete values[f.id]; paint(); onChange(); } }, 'Remove') : '',
          file);
      };
      paint();
      return h('div', { class: 'field' }, h('label', { class: 'field' }, f.name), slot);
    }
    // list: rows of 1–3 columns (e.g. item | price)
    const cols = f.style.columns || 2;
    const heads = (f.style.header || '').split('|').map((x) => x.trim());
    const rowsBox = h('div', { class: 'list-cells-wrap' });
    const rows = () => values[f.id] || (values[f.id] = (fallback[f.id] || []).map((r) => [...r]));
    const paint = () => rowsBox.replaceChildren(...rows().map((row, i) => h('div', { class: 'list-row' },
      h('div', { class: `list-cells c${cols}` }, Array.from({ length: cols }, (_, c) => h('input', {
        type: 'text', value: row[c] ?? '', placeholder: heads[c] || (c === cols - 1 && cols > 1 ? 'Price' : 'Item'),
        oninput: (e) => { row[c] = e.target.value; onChange(); },
      }))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', disabled: i === 0, onclick: () => { const r = rows(); [r[i - 1], r[i]] = [r[i], r[i - 1]]; paint(); onChange(); } }, '↑'),
        h('button', { type: 'button', class: 'small danger', onclick: () => { rows().splice(i, 1); paint(); onChange(); } }, '✕')))));
    paint();
    return h('div', { class: 'field' },
      h('label', { class: 'field' }, f.name), rowsBox,
      h('button', { type: 'button', onclick: () => { rows().push(Array(cols).fill('')); paint(); onChange(); rowsBox.lastElementChild?.querySelector('input')?.focus(); } }, '+ Add row'));
  }

  // Phone photos are large: send at most 2560 px, as JPEG.
  async function shrink(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && file.type === 'image/jpeg') return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise((r) => canvas.toBlob((b) => r(b || file), 'image/jpeg', 0.88));
    } catch { return file; }
  }

  // ---------- steps (ceremonies) ----------
  async function show(step) {
    status('Changing…', 'busy');
    try {
      const fresh = await api('POST', '/step', { step });
      board.step = fresh.step;
      render();
      status('On screen', 'ok');
    } catch (err) { status(err.message, 'error'); }
  }

  function stepper() {
    const n = board.steps.length;
    const current = board.steps[board.step];
    return h('div', { class: 'card' },
      h('div', { class: 'now' }, current ? `${board.step + 1} of ${n}: ${current.title}` : 'Showing the main board'),
      h('div', { class: 'stepper' },
        h('button', { disabled: board.step < 0, onclick: () => show('previous') }, '◀ Previous'),
        h('button', { class: 'primary', disabled: board.step >= n - 1, onclick: () => show('next') }, 'Next ▶')),
      h('div', { class: 'row' },
        h('button', { class: 'small', disabled: board.step < 0, onclick: () => show(-1) }, 'Back to the main board'),
        h('span', { class: 'hint' }, 'Next shows the following step on the screens straight away.')));
  }

  function stepsEditor() {
    const list = h('div', { class: 'steps' });
    const content = board.fields.filter((f) => ['text', 'image', 'list'].includes(f.kind));
    board.steps.forEach((st, i) => {
      const body = h('div', { class: 'step-body', hidden: true });
      const changed = () => { saveSoon('steps'); previewSoon(); };
      body.append(
        h('label', { class: 'field' }, 'Name of this step', h('input', { type: 'text', value: st.title, oninput: (e) => { st.title = e.target.value; changed(); } })),
        ...content.map((f) => fieldEditor(f, st.values, changed, board.values)));
      list.append(h('div', { class: `step ${i === board.step ? 'on' : ''}` },
        h('div', { class: 'step-head' },
          h('span', { class: 'name' }, `${i + 1}. ${st.title}`),
          h('button', { class: 'small primary', onclick: () => show(i) }, i === board.step ? 'On screen' : 'Show'),
          h('button', { class: 'small', onclick: () => { body.hidden = !body.hidden; } }, 'Edit'),
          h('button', { class: 'small', disabled: i === 0, onclick: () => { [board.steps[i - 1], board.steps[i]] = [board.steps[i], board.steps[i - 1]]; saveSoon('steps'); render(); } }, '↑'),
          h('button', { class: 'small danger', onclick: () => {
            if (!confirm(`Delete “${st.title}”?`)) return;
            board.steps.splice(i, 1);
            if (board.step >= board.steps.length) board.step = board.steps.length - 1;
            saveSoon('steps');
            render();
          } }, '✕')),
        body));
    });
    return h('div', { class: 'card' },
      h('h2', {}, 'Prepared steps'),
      h('p', { class: 'hint' }, 'For ceremonies and announcements: prepare every step (e.g. each award with its winner and photo), then use Next during the event. Fields left empty in a step show the main board’s content.'),
      list,
      h('button', { onclick: () => {
        board.steps.push({ id: crypto.randomUUID?.() || String(Date.now()), title: `Step ${board.steps.length + 1}`, values: {} });
        saveSoon('steps');
        render();
        list.lastElementChild?.querySelector('.step-body')?.removeAttribute('hidden');
      } }, '+ Add step'));
  }

  // ---------- page ----------
  function render() {
    $('#title').textContent = board.name;
    document.title = `${board.name} – board editor`;
    const tabs = h('div', { class: 'tabs' },
      h('button', { class: tab === 'content' ? 'on' : '', onclick: () => { tab = 'content'; render(); } }, 'Main content'),
      h('button', { class: tab === 'steps' ? 'on' : '', onclick: () => { tab = 'steps'; render(); } }, `Steps${board.steps.length ? ` (${board.steps.length})` : ''}`));
    const changed = () => { saveSoon('values'); previewSoon(); };
    const contentCard = h('div', { class: 'card' },
      h('h2', {}, 'Main content'),
      board.fields.length ? board.fields.map((f) => fieldEditor(f, board.values, changed)) : h('p', { class: 'muted' }, 'This board has no fields yet: add them in the console (Boards → Design).'),
      h('p', { class: 'hint' }, 'Changes are saved and on the screens within a second.'));
    main.replaceChildren(
      h('div', { class: 'card' }, h('h2', {}, board.step >= 0 ? 'On screen now' : 'Preview'), previewBox),
      board.steps.length ? stepper() : '',
      tabs,
      tab === 'content' ? contentCard : stepsEditor());
    drawPreview();
  }

  async function load() {
    if (!linkToken && !boardId) { main.replaceChildren(h('p', { class: 'muted center' }, 'No board chosen.')); return; }
    try {
      board = await api('GET');
      board.values ||= {};
      board.steps ||= [];
      render();
      status('Ready', 'ok');
    } catch (err) {
      if (err.message !== 'PIN required') main.replaceChildren(h('div', { class: 'card' }, h('p', {}, err.message)));
    }
  }

  load();
})();
