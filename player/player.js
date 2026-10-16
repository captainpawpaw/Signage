// Signage player. Runs inside the per-screen browser add-on (config baked into
// config.js) or as a browser-preview tab (token passed in the URL hash).
//
// Flow: open a WebSocket to the server, authenticate with the screen token,
// receive manifests (pushed on every change), pre-cache every asset with the
// Cache API, then swap to the new playlist. The last good manifest and its
// assets survive restarts, so a screen keeps playing while the server is down.
(() => {
  'use strict';

  const PLAYER_VERSION = '1.0.0';
  const CACHE_NAME = 'signage-media-v1';
  const MANIFEST_KEY = 'signage.manifest';
  const POLL_MS = 60_000;
  const STATUS_MS = 20_000;

  const config = (() => {
    if (self.SIGNAGE_CONFIG?.token) return self.SIGNAGE_CONFIG;
    const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
    return { serverUrl: params.get('server') || location.origin, token: params.get('token') };
  })();
  const serverUrl = (config.serverUrl || '').replace(/\/+$/, '');
  const authHeaders = { Authorization: `Bearer ${config.token}` };

  const $ = (sel) => document.querySelector(sel);
  const stage = $('#stage');
  const layers = [$('#layer-a'), $('#layer-b')];
  let front = 0;

  let manifest = null;
  let index = -1;
  let advanceTimer = null;
  let ws = null;
  let wsBackoff = 1000;
  let unauthorized = false;
  const objectUrls = new Map(); // asset url -> blob: URL
  let latestUrls = [];

  // ---------- Assets ----------
  async function loadAsset(url) {
    if (objectUrls.has(url)) return objectUrls.get(url);
    const full = serverUrl + url;
    const cache = await caches.open(CACHE_NAME);
    let res = await cache.match(full);
    if (!res) {
      res = await fetch(full, { headers: authHeaders });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      await cache.put(full, res.clone());
    }
    const blobUrl = URL.createObjectURL(await res.blob());
    objectUrls.set(url, blobUrl);
    return blobUrl;
  }

  async function pruneAssets(keep) {
    const wanted = new Set(keep.map((u) => serverUrl + u));
    const cache = await caches.open(CACHE_NAME);
    for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
    for (const [url, blobUrl] of objectUrls) {
      if (!keep.includes(url)) { URL.revokeObjectURL(blobUrl); objectUrls.delete(url); }
    }
  }

  // ---------- Manifest handling ----------
  let pending = Promise.resolve();
  function applyManifest(next) {
    // Serialise so a burst of edits can't interleave preloads.
    pending = pending.then(() => doApply(next)).catch((err) => console.error('[signage] apply failed', err));
  }

  async function doApply(next) {
    if (manifest && next.version === manifest.version) return;
    const results = await Promise.allSettled(next.items.map((it) => loadAsset(it.url)));
    const items = next.items.filter((_, i) => results[i].status === 'fulfilled');
    results.forEach((r, i) => r.status === 'rejected' && console.warn('[signage] asset failed', next.items[i].url, r.reason));

    manifest = { ...next, items };
    latestUrls = next.items.map((it) => it.url);
    try { localStorage.setItem(MANIFEST_KEY, JSON.stringify(next)); } catch {}
    applySettings(manifest.settings || {});
    document.title = `Signage – ${manifest.screen?.name || ''}`;
    index = -1;
    advance();
    // Drop assets no longer referenced once the outgoing item has faded out.
    // Queued on the same chain so it never races a newer manifest's preload.
    setTimeout(() => { pending = pending.then(() => pruneAssets(latestUrls)).catch(() => {}); }, 2000);
    sendStatus();
  }

  function applySettings(s) {
    stage.className = [s.orientation || 'landscape', s.transition === 'none' ? '' : 'fade'].join(' ');
    stage.style.setProperty('--bg', s.background || '#000');
    stage.style.setProperty('--fit', s.fit || 'contain');
  }

  // ---------- Rendering ----------
  function showIdle(message) {
    clearTimeout(advanceTimer);
    layers.forEach((l) => { l.classList.remove('active'); l.replaceChildren(); });
    $('#idle').hidden = false;
    $('#idle .idle-name').textContent = manifest?.screen?.name || config.screenName || 'Signage';
    $('#idle .idle-msg').textContent = message;
  }

  function advance() {
    clearTimeout(advanceTimer);
    const items = manifest?.items || [];
    if (!items.length) return showIdle(manifest?.playlist ? 'Playlist is empty' : 'No content scheduled');
    $('#idle').hidden = true;
    index = (index + 1) % items.length;
    const item = items[index];
    // A single still image needs no re-render; it just stays up.
    if (items.length === 1 && item.type === 'image' && layers[front].dataset.itemId === item.id) return;
    render(item, items.length === 1);
  }

  function render(item, only) {
    const back = 1 - front;
    const layer = layers[back];
    const src = objectUrls.get(item.url);
    let el;

    const reveal = () => {
      layers[front].classList.remove('active');
      layer.classList.add('active');
      const old = layers[front];
      front = back;
      // Let the cross-fade finish before tearing down the outgoing element.
      setTimeout(() => { if (old !== layers[front]) { old.querySelector('video')?.pause(); old.replaceChildren(); old.dataset.itemId = ''; } }, 900);
      sendStatus();
    };
    let failed = false;
    const fail = (err) => {
      if (failed) return; // a broken video reports via both onerror and play()
      failed = true;
      console.warn('[signage] render failed', item.url, err);
      clearTimeout(advanceTimer);
      advanceTimer = setTimeout(advance, 1000);
    };

    if (item.type === 'video') {
      el = document.createElement('video');
      el.muted = item.muted !== false;
      el.playsInline = true;
      el.loop = only && !item.duration;
      el.onended = () => advance();
      el.onerror = fail;
      el.src = src;
      el.play().then(reveal).catch((err) => {
        // Autoplay with sound can be blocked; retry muted rather than stall.
        el.muted = true;
        el.play().then(reveal).catch(fail);
      });
      if (item.duration) advanceTimer = setTimeout(advance, item.duration);
    } else {
      el = new Image();
      el.decoding = 'async';
      el.onload = () => { reveal(); advanceTimer = setTimeout(advance, item.duration || 10_000); };
      el.onerror = fail;
      el.src = src;
    }
    el.alt = '';
    layer.dataset.itemId = item.id;
    layer.replaceChildren(el);
  }

  // ---------- Server connection ----------
  function connect() {
    if (!config.token) return showIdle('No screen token configured');
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      wsBackoff = 1000;
      ws.send(JSON.stringify({
        type: 'hello', token: config.token, playerVersion: PLAYER_VERSION, userAgent: navigator.userAgent,
        display: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
      }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'manifest') { setConnected(true); applyManifest(msg.manifest); }
      else if (msg.type === 'command') runCommand(msg.command);
      else if (msg.type === 'error' && msg.code === 'unauthorized') unauthorized = true;
    };
    ws.onclose = (ev) => {
      setConnected(false);
      ws = null;
      if (ev.code === 4001 || unauthorized) {
        unauthorized = true;
        if (!manifest) showIdle('This screen is not authorised. Download a fresh add-on from the admin console.');
        wsBackoff = 60_000; // keep trying slowly in case the screen is re-created with the same token
      }
      setTimeout(connect, wsBackoff);
      wsBackoff = Math.min(wsBackoff * 2, 30_000);
    };
    ws.onerror = () => {};
  }

  // HTTP fallback for networks/proxies that break WebSockets.
  async function poll() {
    if (ws?.readyState === WebSocket.OPEN || !config.token) return;
    try {
      const res = await fetch(`${serverUrl}/api/player/manifest`, { headers: authHeaders, cache: 'no-store' });
      if (res.ok) applyManifest(await res.json());
    } catch {}
  }

  function sendStatus() {
    if (ws?.readyState !== WebSocket.OPEN || !manifest) return;
    const item = manifest.items[index];
    ws.send(JSON.stringify({
      type: 'status', version: manifest.version, playlistId: manifest.playlist?.id || null,
      index, itemId: item?.id || null, itemCount: manifest.items.length,
    }));
  }

  let connTimer = null;
  function setConnected(ok) {
    clearTimeout(connTimer);
    // Only flag an outage that lasts, so brief reconnects stay invisible.
    if (ok) $('#conn').hidden = true;
    else connTimer = setTimeout(() => { $('#conn').hidden = false; }, 30_000);
  }

  function runCommand(cmd) {
    if (cmd === 'reload') location.reload();
    else if (cmd === 'next') advance();
    else if (cmd === 'identify') {
      const el = $('#identify');
      el.innerHTML = '';
      el.append(manifest?.screen?.name || 'Screen');
      const small = document.createElement('small');
      small.textContent = `${manifest?.playlist?.name || 'No playlist'} · ${screen.width}×${screen.height}`;
      el.append(small);
      el.hidden = false;
      setTimeout(() => { el.hidden = true; }, 10_000);
    }
  }

  // ---------- Boot ----------
  try {
    const saved = JSON.parse(localStorage.getItem(MANIFEST_KEY) || 'null');
    if (saved) applyManifest(saved); else showIdle('Connecting…');
  } catch { showIdle('Connecting…'); }
  connect();
  setInterval(poll, POLL_MS);
  setInterval(sendStatus, STATUS_MS);
})();
