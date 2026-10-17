// Signage player.
//
// Device mode (inside the add-on, config.js present):
//   finds the server by trying every address it knows, proves its identity with
//   a device key pair kept in IndexedDB (private keys never leave the browser),
//   accepts only messages signed by the server key pinned in config.js, and
//   downloads content as AES-GCM encrypted chunks that only this device can
//   unwrap. Chunks stay encrypted in the Cache API, so screens keep playing
//   offline. Unknown devices show a pairing code for the admin to approve.
// Preview mode (plain browser tab, #token=… in the URL):
//   unencrypted, streams files straight from the server. For testing on any device.
(() => {
  'use strict';

  const PLAYER_VERSION = '2.1.1';
  const CACHE_NAME = 'signage-media-v2';
  const CACHE_PREFIX = 'https://cache.signage.invalid';
  const MANIFEST_KEY = 'signage.manifest';
  const SERVER_KEY = 'signage.server';
  const ADDR_KEY = 'signage.addresses';
  const POLL_MS = 60_000;
  const STATUS_MS = 20_000;
  const SCREENSHOT_MS = 5 * 60_000;
  const BUFFER_AHEAD_S = 30;
  const OFFLINE_AFTER_MS = 15_000;
  // Preview links can't use offline storage (plain http), so they keep the
  // playlist in memory instead: all images, and videos up to this budget.
  const MEMORY_BUDGET_MB = { standard: 300, lowPower: 40 };

  // TV sticks and smart-TV browsers are slow: no cross-fades (two layers being
  // composited at once), no periodic screenshots of video frames. Detected
  // automatically, or forced per screen in the console.
  const WEAK_DEVICE = /\bAFT\w+|Silk\/|SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|Android TV|GoogleTV|CrKey|Roku/i.test(navigator.userAgent)
    || (navigator.deviceMemory && navigator.deviceMemory <= 2);
  let lowPower = WEAK_DEVICE;
  const isLowPower = (settings = {}) => settings.power === 'low' || (settings.power !== 'standard' && WEAK_DEVICE);

  const cfg = self.SIGNAGE_CONFIG?.signKey ? self.SIGNAGE_CONFIG : null;
  const MODE = cfg ? 'device' : 'preview';
  const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  const previewToken = params.get('token');
  let serverUrl = MODE === 'preview' ? (params.get('server') || location.origin).replace(/\/+$/, '') : null;

  const subtle = self.crypto?.subtle;
  const utf8 = new TextEncoder();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b64 = (buf) => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  let addonVersion = (() => { try { return chrome.runtime.getManifest().version; } catch { return null; } })();

  const $ = (sel) => document.querySelector(sel);
  const stage = $('#stage');
  const layers = [$('#layer-a'), $('#layer-b')];
  let front = 0;

  let manifest = null;
  let index = -1;
  let advanceTimer = null;
  let conn = null;            // { ws, cn, seq }
  let backoff = 1000;
  let fatal = null;           // message shown when the server refuses us
  const assets = new Map();   // asset key -> object URL, direct URL, or 'stream'
  const heldBytes = new Map(); // preview videos kept in memory -> size
  const dev = { keys: null, sign: null, wrapKey: null, session: null, screenId: null, contentKeys: new Map() };

  // ---------- storage helpers ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('signage', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', mode);
        const op = fn(tx.objectStore('kv'));
        tx.oncomplete = () => { db.close(); resolve(op.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }

  const openCache = () => (self.caches ? caches.open(CACHE_NAME) : Promise.resolve(null));

  // ---------- device crypto ----------
  async function initDevice() {
    let keys = await idb('readonly', (s) => s.get('device'));
    if (!keys) {
      // Non-extractable: the private keys cannot be read out of this browser profile.
      const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      keys = {
        sign, ecdh,
        signPub: b64(await subtle.exportKey('spki', sign.publicKey)),
        ecdhPub: b64(await subtle.exportKey('spki', ecdh.publicKey)),
      };
      await idb('readwrite', (s) => s.put(keys, 'device'));
    }
    dev.keys = keys;
    dev.sign = await subtle.importKey('spki', unb64(cfg.signKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const serverEcdh = await subtle.importKey('spki', unb64(cfg.ecdhKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = await subtle.deriveBits({ name: 'ECDH', public: serverEcdh }, keys.ecdh.privateKey, 256);
    const hkdf = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    dev.wrapKey = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(cfg.serverId), info: utf8.encode('signage-wrap-v1') },
      hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }

  async function contentKey(e) {
    if (!dev.contentKeys.has(e.f)) {
      const raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.kiv), additionalData: utf8.encode(e.f) }, dev.wrapKey, unb64(e.k));
      dev.contentKeys.set(e.f, await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']));
    }
    return dev.contentKeys.get(e.f);
  }

  function chunkIv(salt, i) {
    const iv = new Uint8Array(12);
    iv.set(unb64(salt).subarray(0, 4), 0);
    new DataView(iv.buffer).setBigUint64(4, BigInt(i));
    return iv;
  }

  // Returns the encrypted chunk, from the local cache or the server.
  async function encryptedChunk(e, i) {
    const key = `${CACHE_PREFIX}/${e.f}/${i}`;
    const cache = await openCache();
    const hit = cache && await cache.match(key);
    if (hit) return hit.arrayBuffer();
    if (!dev.session) throw new Error('not connected');
    const res = await fetch(`${serverUrl}/api/player/chunk/${e.f}/${i}`, { headers: { 'X-Signage-Session': dev.session }, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    if (cache) await cache.put(key, new Response(data));
    return data;
  }

  async function readChunk(e, i) {
    const data = await encryptedChunk(e, i);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(e.salt, i), additionalData: utf8.encode(`${e.f}:${i}:${e.n}`) }, await contentKey(e), data);
    return new Uint8Array(plain);
  }

  async function decryptWhole(e, mime) {
    const parts = [];
    for (let i = 0; i < e.n; i++) parts.push(await readChunk(e, i));
    return new Blob(parts, { type: mime });
  }

  // ---------- assets ----------
  const assetKey = (item) => (item.enc ? item.enc.f : item.url);
  const MediaSourceImpl = self.ManagedMediaSource || self.MediaSource;
  const canStream = (item) => Boolean(item.stream && item.enc && MediaSourceImpl?.isTypeSupported?.(`video/mp4; codecs="${item.codecs}"`));

  function preloadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = resolve;
      img.onerror = () => reject(new Error(`image failed: ${url}`));
      img.src = url;
    });
  }

  async function prepare(item) {
    const key = assetKey(item);
    if (assets.has(key)) return;
    if (!item.enc) {
      const url = `${serverUrl}${item.url}?pt=${encodeURIComponent(previewToken)}`;
      // Keep a copy in memory so the playlist keeps looping if the connection
      // drops. Videos over the budget stream instead (and are skipped offline).
      const budget = MEMORY_BUDGET_MB[lowPower ? 'lowPower' : 'standard'] * 1024 * 1024;
      const used = [...heldBytes.values()].reduce((a, b) => a + b, 0);
      const keep = item.type === 'image' || (item.size && used + item.size <= budget);
      if (!keep) { assets.set(key, url); return; }
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blobUrl = URL.createObjectURL(await res.blob());
      if (item.type === 'video') heldBytes.set(key, item.size);
      assets.set(key, blobUrl);
    } else if (item.type === 'video' && canStream(item)) {
      await encryptedChunk(item.enc, 0); // start fast: the rest streams while playing
      assets.set(key, 'stream');
    } else {
      const blob = await decryptWhole(item.enc, item.mime || (item.type === 'image' ? 'image/png' : 'video/mp4'));
      assets.set(key, URL.createObjectURL(blob));
    }
  }

  // Fills the encrypted cache in the background so streamed videos also play offline.
  let prefetchRun = 0;
  async function prefetchStreams(items) {
    const run = ++prefetchRun;
    for (const it of items) {
      if (assets.get(assetKey(it)) !== 'stream') continue;
      for (let i = 0; i < it.enc.n; i++) {
        if (run !== prefetchRun) return;
        try { await encryptedChunk(it.enc, i); } catch { return; }
      }
    }
  }

  async function pruneAssets(keep) {
    const wanted = new Set(keep);
    const cache = await openCache();
    if (cache) {
      for (const req of await cache.keys()) {
        const f = req.url.startsWith(CACHE_PREFIX) ? req.url.slice(CACHE_PREFIX.length + 1).split('/')[0] : null;
        if (!wanted.has(f)) await cache.delete(req);
      }
    }
    for (const [key, url] of assets) {
      if (wanted.has(key)) continue;
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      assets.delete(key);
      heldBytes.delete(key);
    }
    for (const f of [...dev.contentKeys.keys()]) if (!wanted.has(f)) dev.contentKeys.delete(f);
  }

  // ---------- manifest handling ----------
  let pending = Promise.resolve();
  let latestKeep = [];
  function applyManifest(next) {
    // Serialise so a burst of edits can't interleave preloads.
    pending = pending.then(() => doApply(next)).catch((err) => console.error('[signage] apply failed', err));
  }

  async function doApply(next) {
    if (manifest && next.version === manifest.version) return;
    lowPower = isLowPower(next.settings);
    // One at a time: keeps the memory budget accurate and spares small devices.
    const results = [];
    for (const item of next.items) results.push(await prepare(item).then(() => ({ status: 'fulfilled' }), (reason) => ({ status: 'rejected', reason })));
    results.forEach((r, i) => r.status === 'rejected' && console.warn('[signage] asset failed', next.items[i].id, r.reason));
    const items = next.items.filter((_, i) => results[i].status === 'fulfilled');

    manifest = { ...next, items };
    store.set(MANIFEST_KEY, next);
    applySettings(manifest.settings || {});
    if (!$('#offline').hidden) showOffline();
    document.title = `Signage – ${manifest.screen?.name || ''}`;
    index = -1;
    advance();
    prefetchStreams(items);
    latestKeep = next.items.map(assetKey);
    // Drop what's no longer used once the outgoing item has faded out. Queued on
    // the same chain, and always against the newest manifest, so it never frees
    // files a later manifest has just loaded.
    setTimeout(() => { pending = pending.then(() => pruneAssets(latestKeep)).catch(() => {}); }, 2000);
    sendStatus();
    setTimeout(sendScreenshot, 3000);
  }

  function applySettings(s) {
    lowPower = isLowPower(s);
    stage.className = [s.orientation || 'landscape', s.transition === 'none' || lowPower ? '' : 'fade'].join(' ');
    stage.style.setProperty('--bg', s.background || '#000');
    stage.style.setProperty('--fit', s.fit || 'contain');
  }

  async function forgetContent() {
    manifest = null;
    latestKeep = [];
    store.del(MANIFEST_KEY);
    await pruneAssets([]);
  }

  // ---------- rendering ----------
  function showIdle(message, { title, code, hint } = {}) {
    clearTimeout(advanceTimer);
    for (const l of layers) { l.classList.remove('active'); stopLayer(l); }
    $('#idle').hidden = false;
    $('#idle .idle-name').textContent = title || manifest?.screen?.name || cfg?.screenName || 'Signage';
    $('#idle .idle-code').hidden = !code;
    $('#idle .idle-code').textContent = code || '';
    $('#idle .idle-msg').textContent = message;
    $('#idle .idle-hint').textContent = hint || '';
  }

  function stopLayer(layer) {
    const video = layer.querySelector('video');
    if (video) { video._stop?.(); video.pause(); video.removeAttribute('src'); video.load(); }
    layer.replaceChildren();
    layer.dataset.itemId = '';
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
    const src = assets.get(assetKey(item));
    let el;

    const reveal = () => {
      layers[front].classList.remove('active');
      layer.classList.add('active');
      const old = layers[front];
      front = back;
      // Let the cross-fade finish before tearing down the outgoing element
      // (straight away without a fade, so two videos never decode at once).
      const fading = stage.classList.contains('fade');
      if (fading) setTimeout(() => { if (old !== layers[front]) stopLayer(old); }, 900);
      else stopLayer(old);
      sendStatus();
    };
    let failed = false;
    const fail = (err) => {
      if (failed) return; // a broken video reports via both onerror and play()
      failed = true;
      console.warn('[signage] render failed', item.id, err);
      clearTimeout(advanceTimer);
      advanceTimer = setTimeout(advance, 1000);
    };

    stopLayer(layer);
    if (item.type === 'video') {
      el = document.createElement('video');
      el.muted = item.muted !== false;
      el.playsInline = true;
      el.loop = only && !item.duration && src !== 'stream';
      el.onended = () => advance();
      el.onerror = fail;
      if (src === 'stream') streamInto(el, item, fail); else el.src = src;
      el.play().then(reveal).catch(() => {
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
    layer.append(el);
  }

  // Decrypts chunks into MediaSource as the video plays, keeping ~30 s buffered,
  // so long videos start at once and never sit in memory whole.
  function streamInto(video, item, fail) {
    const ms = new MediaSourceImpl();
    let stopped = false;
    video._stop = () => { stopped = true; };
    if (self.ManagedMediaSource && MediaSourceImpl === self.ManagedMediaSource) video.disableRemotePlayback = true;
    const idle = (sb) => (sb.updating ? new Promise((r) => sb.addEventListener('updateend', r, { once: true })) : Promise.resolve());
    const ahead = () => {
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.5 && b.end(i) > video.currentTime) return b.end(i) - video.currentTime;
      return 0;
    };
    const append = async (sb, data) => {
      for (let attempt = 0; ; attempt++) {
        try { await idle(sb); sb.appendBuffer(data); await idle(sb); return; } catch (err) {
          if (err.name !== 'QuotaExceededError' || attempt > 10) throw err;
          await idle(sb);
          if (video.currentTime > 10) { sb.remove(0, video.currentTime - 5); await idle(sb); } else await sleep(1000);
        }
      }
    };
    ms.addEventListener('sourceopen', async () => {
      try {
        const sb = ms.addSourceBuffer(`video/mp4; codecs="${item.codecs}"`);
        for (let i = 0; i < item.enc.n && !stopped; i++) {
          const data = await readChunk(item.enc, i);
          while (!stopped && ahead() > BUFFER_AHEAD_S) await sleep(500);
          if (stopped) return;
          await append(sb, data);
        }
        if (!stopped && ms.readyState === 'open') { await idle(sb); ms.endOfStream(); }
      } catch (err) {
        if (!stopped) fail(err);
      }
    }, { once: true });
    video.src = URL.createObjectURL(ms);
  }

  // ---------- server connection ----------
  async function discover() {
    const known = [store.get(SERVER_KEY), ...(store.get(ADDR_KEY) || []), ...(cfg.candidates || [])];
    const list = [...new Set(known.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))];
    const probe = async (url) => {
      const res = await fetch(`${url}/api/hello`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const hello = await res.json();
      if (hello.serverId !== cfg.serverId) throw new Error('different server');
      return url;
    };
    return Promise.any(list.map(probe));
  }

  let retryTimer = null;
  function retry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }

  async function connect() {
    if (MODE === 'preview' && !previewToken) return showIdle('No screen token in the link');
    if (MODE === 'device') {
      try { serverUrl = await discover(); } catch {
        if (!manifest) showIdle('Looking for the Signage server…', { hint: (cfg.candidates || []).join('   ') });
        return retry();
      }
    }
    const ws = new WebSocket(`${serverUrl.replace(/^http/, 'ws')}/ws`);
    const c = { ws, cn: b64(crypto.getRandomValues(new Uint8Array(16))), seq: 0, chain: Promise.resolve() };
    conn = c;
    ws.onopen = () => {
      backoff = 1000;
      const info = {
        playerVersion: PLAYER_VERSION, addonVersion, userAgent: navigator.userAgent,
        display: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
      };
      ws.send(JSON.stringify(MODE === 'device'
        ? { type: 'hello', mode: 'device', signPub: dev.keys.signPub, ecdhPub: dev.keys.ecdhPub, cn: c.cn, enrollToken: cfg.enrollToken, ...info }
        : { type: 'hello', mode: 'preview', token: previewToken, ...info }));
    };
    ws.onmessage = (ev) => {
      // Process strictly in order: signature checks are async.
      c.chain = c.chain.then(() => onMessage(c, ev.data)).catch((err) => console.warn('[signage] message rejected:', err.message));
    };
    ws.onclose = (ev) => {
      if (conn === c) { conn = null; dev.session = null; }
      setConnected(false);
      if (ev.code === 4001 && !fatal) fatal = 'refused';
      if (fatal && !manifest) {
        showIdle(fatal === 'encryption-required'
          ? 'This link no longer works: unencrypted players are switched off. Use the add-on.'
          : 'This screen was not accepted by the server. Download a fresh add-on or link from the console.');
      }
      fatal = null;
      retry();
    };
    ws.onerror = () => {};
  }

  async function onMessage(c, raw) {
    const msg = JSON.parse(raw);
    if (msg.type === 'error') { fatal = msg.code; return; }
    if (MODE === 'preview') return dispatch(msg);
    if (msg.type === 'challenge') {
      if (msg.serverId !== cfg.serverId) throw new Error('wrong server');
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.keys.sign.privateKey,
        utf8.encode(`signage-auth-v1|${cfg.serverId}|${msg.nonce}|${c.cn}`));
      c.ws.send(JSON.stringify({ type: 'auth', sig: b64(sig) }));
      return;
    }
    if (msg.type !== 'signed') return; // devices act on signed messages only
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, dev.sign, unb64(msg.s), utf8.encode(msg.p));
    if (!ok) throw new Error('bad signature');
    const inner = JSON.parse(msg.p);
    if (inner.cn !== c.cn || !(inner.seq > c.seq)) throw new Error('replayed message');
    c.seq = inner.seq;
    return dispatch(inner);
  }

  async function dispatch(msg) {
    if (msg.type === 'pairing') {
      setConnected(true);
      await forgetContent();
      showIdle('Pair this screen', {
        title: cfg.serverName || 'Signage', code: msg.code,
        hint: `In the Signage console: Screens → Pair a screen, then enter this code.   Server key ${cfg.fingerprint}`,
      });
      $('#idle .idle-msg').textContent = 'Waiting to be paired';
    } else if (msg.type === 'welcome') {
      dev.session = msg.session;
      dev.screenId = msg.screen.id;
      store.set(SERVER_KEY, serverUrl);
      if (Array.isArray(msg.addresses)) store.set(ADDR_KEY, msg.addresses);
      setConnected(true);
    } else if (msg.type === 'manifest') {
      setConnected(true);
      if (reloadForNewPlayer(msg.playerVersion)) return;
      applyManifest(msg.manifest);
    } else if (msg.type === 'command') {
      runCommand(msg.command);
    }
  }

  // Preview pages run the player straight from the server: when the server has a
  // newer one, reload to pick it up. Guarded so a stale cache can't cause a loop.
  function reloadForNewPlayer(serverVersion) {
    if (MODE !== 'preview' || !serverVersion || serverVersion === PLAYER_VERSION) return false;
    try {
      if (sessionStorage.getItem('signage.reloadedFor') === serverVersion) return false;
      sessionStorage.setItem('signage.reloadedFor', serverVersion);
    } catch { return false; }
    console.log(`[signage] server has player ${serverVersion}, running ${PLAYER_VERSION}: reloading`);
    location.reload();
    return true;
  }

  // HTTP fallback for networks/proxies that break WebSockets (previews only;
  // devices need the signed socket).
  async function poll() {
    if (MODE !== 'preview' || conn?.ws.readyState === WebSocket.OPEN || !previewToken) return;
    try {
      const res = await fetch(`${serverUrl}/api/player/manifest`, { headers: { Authorization: `Bearer ${previewToken}` }, cache: 'no-store' });
      if (!res.ok) return setConnected(false);
      setConnected(true);
      applyManifest(await res.json());
      // The server is back: reconnect the live socket now instead of waiting out the back-off.
      if (!conn) { clearTimeout(retryTimer); backoff = 1000; connect(); }
    } catch { setConnected(false); }
  }

  function send(obj) {
    if (conn?.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(obj));
  }

  function sendStatus() {
    if (!manifest) return;
    const item = manifest.items[index];
    send({
      type: 'status', version: manifest.version, playlistId: manifest.playlist?.id || null,
      index, itemId: item?.id || null, itemCount: manifest.items.length, lowPower,
    });
  }

  // Draws what is on screen into a small JPEG; encrypted for the server in device mode.
  async function sendScreenshot() {
    if (conn?.ws.readyState !== WebSocket.OPEN || (MODE === 'device' && !dev.screenId)) return;
    try {
      const w = 640;
      const h = Math.round((w * stage.offsetHeight) / stage.offsetWidth) || 360;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = manifest?.settings?.background || '#000';
      ctx.fillRect(0, 0, w, h);
      const el = $('#idle').hidden ? layers[front].firstElementChild : null;
      const sw = el?.naturalWidth || el?.videoWidth;
      const sh = el?.naturalHeight || el?.videoHeight;
      if (el && sw && sh) {
        const scale = (manifest?.settings?.fit === 'cover' ? Math.max : Math.min)(w / sw, h / sh);
        ctx.drawImage(el, (w - sw * scale) / 2, (h - sh * scale) / 2, sw * scale, sh * scale);
      } else {
        ctx.fillStyle = '#fff';
        ctx.font = '20px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText($('#idle .idle-msg').textContent || 'Idle', w / 2, h / 2);
      }
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.75));
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      if (MODE === 'device') {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(`screenshot:${dev.screenId}`) }, dev.wrapKey, jpeg);
        send({ type: 'screenshot', iv: b64(iv), data: b64(data) });
      } else {
        send({ type: 'screenshot', data: b64(jpeg) });
      }
    } catch (err) {
      console.warn('[signage] screenshot failed', err);
    }
  }

  // ---------- connection-lost notice ----------
  let connTimer = null;
  let connected = false;
  function setConnected(ok) {
    if (ok === connected && (ok || connTimer)) return;
    connected = ok;
    clearTimeout(connTimer);
    connTimer = null;
    // Only flag an outage that lasts, so brief reconnects stay invisible.
    if (ok) $('#offline').hidden = true;
    else connTimer = setTimeout(showOffline, OFFLINE_AFTER_MS);
  }

  // Message and QR code come from the console (Settings, or per screen) and are
  // stored with the content, so they are available while the server is unreachable.
  function showOffline() {
    const notice = manifest?.offline || store.get(MANIFEST_KEY)?.offline || { position: 'corner' };
    const box = $('#offline');
    if (notice.position === 'none') { box.hidden = true; return; }
    box.className = notice.position === 'fullscreen' ? 'fullscreen' : 'corner';
    const msg = box.querySelector('.offline-msg');
    msg.textContent = notice.message || '';
    msg.hidden = !notice.message;
    const qr = box.querySelector('.offline-qr');
    if (notice.qr && /^data:image\/svg\+xml;base64,/.test(notice.qr)) { qr.src = notice.qr; qr.hidden = false; } else { qr.removeAttribute('src'); qr.hidden = true; }
    box.hidden = false;
  }

  function runCommand(cmd) {
    if (cmd === 'reload') location.reload();
    else if (cmd === 'next') advance();
    else if (cmd === 'screenshot') sendScreenshot();
    else if (cmd === 'identify') {
      const el = $('#identify');
      el.replaceChildren(manifest?.screen?.name || 'Screen');
      const small = document.createElement('small');
      small.textContent = `${manifest?.playlist?.name || 'No playlist'} · ${screen.width}×${screen.height} · ${MODE === 'device' ? 'encrypted' : 'preview'}${lowPower ? ' · low-power' : ''}`;
      el.append(small);
      el.hidden = false;
      setTimeout(() => { el.hidden = true; }, 10_000);
    }
  }

  // Phones and tablets can't be put into fullscreen without a tap.
  document.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  });

  // ---------- boot ----------
  async function boot() {
    // The add-on's files may have been updated on disk since the browser started;
    // report the version of the code that is actually running.
    if (addonVersion) {
      try { addonVersion = (await (await fetch('manifest.json', { cache: 'no-store' })).json()).version; } catch {}
    }
    if (MODE === 'device') {
      if (!subtle) return showIdle('This player needs a secure browser context (the add-on provides one).');
      try { await initDevice(); } catch (err) {
        console.error(err);
        return showIdle('Could not set up encryption keys in this browser.');
      }
    }
    const saved = store.get(MANIFEST_KEY);
    // Offline start: replay the last manifest from the encrypted local cache.
    if (saved && (MODE === 'device' || saved.items.every((it) => it.url))) applyManifest(saved);
    else showIdle('Connecting…');
    setConnected(false); // starts the timer; cleared as soon as the server answers
    connect();
    setInterval(poll, POLL_MS);
    setInterval(sendStatus, STATUS_MS);
    setInterval(() => { if (!lowPower) sendScreenshot(); }, SCREENSHOT_MS);
  }
  boot();
})();
