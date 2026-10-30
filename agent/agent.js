// Signage agent: the Linux player (Raspberry Pi OS, Debian, Ubuntu…).
//
// Server side it behaves exactly like the encrypted browser add-on: it holds a
// device key pair (kept on this device), finds the server by itself, proves its
// identity with a signed challenge, shows a pairing code until an admin
// approves it, and accepts only messages signed by the server key it was
// installed with. Content arrives as AES-GCM chunks that only this device can
// unwrap; they are stored encrypted on disk and decrypted only while playing.
//
// Screen side it serves the regular player on http://127.0.0.1:8099 to a
// kiosk Chromium, speaking the same protocol the server uses for preview
// links, so the player code is shared with every other kind of screen.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import makeMdns from 'multicast-dns';

const run = promisify(execFile);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const CONFIG_PATH = process.env.SIGNAGE_CONFIG || '/etc/signage-agent/config.json';
const STATE_DIR = process.env.SIGNAGE_STATE || '/var/lib/signage-agent';
const CACHE_DIR = path.join(STATE_DIR, 'cache');
const PLAYER_DIR = path.join(APP_DIR, 'player');
const LOCAL_PORT = Number(process.env.SIGNAGE_LOCAL_PORT) || 8099;
const DISK_RESERVE = (Number(process.env.SIGNAGE_DISK_RESERVE_MB) || 1024) * 1024 * 1024;
const CHUNK = 1024 * 1024;
const UPDATE_CHECK_MS = (Number(process.env.SIGNAGE_UPDATE_CHECK_SECONDS) || 15 * 60) * 1000;
const PLAYER_STALL_MS = 90_000;

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
fs.mkdirSync(CACHE_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString(), '[agent]', ...a);

// ---------- persistent state ----------
const statePath = path.join(STATE_DIR, 'state.json');
const state = (() => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } })();
function saveState() {
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
  fs.renameSync(`${statePath}.tmp`, statePath);
}
if (!state.localToken) { state.localToken = crypto.randomBytes(24).toString('base64url'); saveState(); }

// ---------- device identity ----------
const spkiB64 = (key) => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
const keys = (() => {
  const file = path.join(STATE_DIR, 'device-keys.json');
  if (!fs.existsSync(file)) {
    const pem = (k) => k.export({ type: 'pkcs8', format: 'pem' });
    const sign = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const ecdh = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    fs.writeFileSync(file, JSON.stringify({ sign: pem(sign), ecdh: pem(ecdh) }), { mode: 0o600 });
    log('created device keys');
  }
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sign = crypto.createPrivateKey(stored.sign);
  const ecdh = crypto.createPrivateKey(stored.ecdh);
  return { sign, ecdh, signPub: spkiB64(sign), ecdhPub: spkiB64(ecdh) };
})();
const serverSignKey = crypto.createPublicKey({ key: Buffer.from(cfg.signKey, 'base64'), format: 'der', type: 'spki' });
const serverEcdhKey = crypto.createPublicKey({ key: Buffer.from(cfg.ecdhKey, 'base64'), format: 'der', type: 'spki' });
// Same derivation as the browser add-on: HKDF(ECDH(device, server)).
const wrapKey = Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey: keys.ecdh, publicKey: serverEcdhKey }),
  Buffer.from(cfg.serverId), Buffer.from('signage-wrap-v1'), 32));

function gcmOpen(key, iv, data, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
}
function gcmSeal(key, data, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  return { iv, data: Buffer.concat([c.update(data), c.final(), c.getAuthTag()]) };
}

const model = (() => {
  try { return fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim(); } catch {}
  try { return fs.readFileSync('/sys/devices/virtual/dmi/id/product_name', 'utf8').trim(); } catch {}
  return `${os.type()} ${os.arch()}`;
})();

// ---------- content cache (encrypted on disk) ----------
const files = new Map();   // file id -> enc entry { f, n, size, salt, k, kiv } + mime
const fileKeys = new Map(); // file id -> unwrapped AES key
const chunkPath = (f, i) => path.join(CACHE_DIR, f, `${i}.bin`);
const isComplete = (e) => fs.existsSync(path.join(CACHE_DIR, e.f, 'complete'));

function contentKey(e) {
  if (!fileKeys.has(e.f)) fileKeys.set(e.f, gcmOpen(wrapKey, Buffer.from(e.kiv, 'base64'), Buffer.from(e.k, 'base64'), e.f));
  return fileKeys.get(e.f);
}
function chunkIv(salt, i) {
  const iv = Buffer.alloc(12);
  Buffer.from(salt, 'base64').copy(iv, 0, 0, 4);
  iv.writeBigUInt64BE(BigInt(i), 4);
  return iv;
}
async function readChunk(e, i) {
  return gcmOpen(contentKey(e), chunkIv(e.salt, i), await fsp.readFile(chunkPath(e.f, i)), `${e.f}:${i}:${e.n}`);
}

function diskStats() {
  let cacheBytes = 0;
  for (const dir of fs.readdirSync(CACHE_DIR)) {
    for (const f of fs.readdirSync(path.join(CACHE_DIR, dir))) cacheBytes += fs.statSync(path.join(CACHE_DIR, dir, f)).size;
  }
  let freeBytes = null;
  try { const s = fs.statfsSync(CACHE_DIR); freeBytes = s.bavail * s.bsize; } catch {}
  return { cacheBytes, freeBytes };
}

let downloading = Promise.resolve();
let diskFull = false;
async function download(e) {
  if (isComplete(e)) return true;
  await fsp.mkdir(path.join(CACHE_DIR, e.f), { recursive: true });
  for (let i = 0; i < e.n; i++) {
    if (fs.existsSync(chunkPath(e.f, i))) continue;
    const free = diskStats().freeBytes;
    if (free !== null && free < DISK_RESERVE + CHUNK) { diskFull = true; log('disk nearly full: not caching more'); return false; }
    if (!session) return false;
    const res = await fetch(`${serverUrl}/api/player/chunk/${e.f}/${i}`, { headers: { 'X-Signage-Session': session } });
    if (!res.ok) throw new Error(`chunk ${e.f}/${i}: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    gcmOpen(contentKey(e), chunkIv(e.salt, i), data, `${e.f}:${i}:${e.n}`); // verify before keeping
    await fsp.writeFile(`${chunkPath(e.f, i)}.tmp`, data);
    await fsp.rename(`${chunkPath(e.f, i)}.tmp`, chunkPath(e.f, i));
  }
  await fsp.writeFile(path.join(CACHE_DIR, e.f, 'complete'), '');
  diskFull = false;
  return true;
}

// ---------- manifests ----------
// serverManifest: as received (encrypted refs). localManifest: what the player
// gets, with /media URLs, and only files that are fully on disk.
let serverManifest = null;
let localManifest = null;
let clockOffset = state.clockOffset || 0;
const manifestPath = path.join(STATE_DIR, 'manifest.json');

function allEnc(m) {
  const out = new Map();
  const logos = Object.values(m.playlists || {}).map((p) => p.overlay?.logo?.image).filter(Boolean);
  // Pictures inside boards (background and photo fields).
  const boardImages = [m.items || [], ...Object.values(m.playlists || {}).map((p) => p.items)].flat()
    .filter((it) => it.type === 'board')
    .flatMap((it) => [it.board.background?.image, ...it.board.fields.map((f) => (f.kind === 'image' ? f.value : null))])
    .filter(Boolean);
  for (const list of [m.items || [], ...Object.values(m.playlists || {}).map((p) => p.items), logos, boardImages]) {
    for (const it of list) if (it.enc) out.set(it.enc.f, { ...it.enc, mime: it.mime });
  }
  return [...out.values()];
}

function toLocal(m) {
  const local = ({ enc, stream, codecs, ...it }) => ({ ...it, url: `/media/${enc.f}`, size: enc.size });
  // Live channels stream from their source; the relay is on the server, not here.
  const picture = (img) => (img?.enc && isComplete(img.enc) ? local(img) : null);
  const board = (it) => ({
    ...it,
    board: {
      ...it.board,
      background: { ...it.board.background, image: picture(it.board.background?.image) },
      fields: it.board.fields.map((f) => (f.kind === 'image' ? { ...f, value: picture(f.value) } : f)),
    },
  });
  const shape = (items) => items
    .filter((it) => it.type === 'live' || it.type === 'board' || (it.enc && isComplete(it.enc)))
    .map((it) => (it.type === 'live' ? { ...it, relay: serverUrl && it.relay ? serverUrl + it.relay : it.relay }
      : it.type === 'board' ? board(it) : local(it)));
  const overlay = (o) => {
    const image = o?.logo?.image;
    if (!image) return o;
    if (image.enc && isComplete(image.enc)) return { ...o, logo: { ...o.logo, image: local(image) } };
    return o.ticker ? { ticker: o.ticker } : undefined;
  };
  const playlists = Object.fromEntries(Object.entries(m.playlists || {}).map(([id, p]) => [id, { ...p, items: shape(p.items), overlay: overlay(p.overlay) }]));
  const body = { ...m, playlists, items: shape(m.items || []) };
  delete body.serverTime;
  const version = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { ...body, version, serverTime: Date.now() + clockOffset };
}

let shownFrom = null; // the server manifest the screen is currently based on
function publish(m, reason) {
  shownFrom = m;
  for (const e of allEnc(m)) files.set(e.f, e);
  const next = toLocal(m);
  if (localManifest && next.version === localManifest.version) return;
  localManifest = next;
  log(`showing ${reason}: ${next.playlist?.name || 'no playlist'} (${next.items.length} items on now)`);
  broadcast({ type: 'manifest', manifest: localManifest, playerVersion: playerVersion() });
}

async function applyServerManifest(m) {
  if (typeof m.serverTime === 'number') { clockOffset = m.serverTime - Date.now(); state.clockOffset = clockOffset; saveState(); }
  serverManifest = m;
  await fsp.writeFile(`${manifestPath}.tmp`, JSON.stringify(m));
  await fsp.rename(`${manifestPath}.tmp`, manifestPath);
  for (const e of allEnc(m)) files.set(e.f, e);
  const needed = allEnc(m);
  const missing = needed.filter((e) => !isComplete(e));
  // Nothing on screen yet: show what we have and fill in as it arrives.
  // Otherwise keep the current content until the new one is fully on disk.
  if (!localManifest || !missing.length) publish(m, missing.length ? 'partial content' : 'new content');
  if (!missing.length) return prune(needed);
  downloading = downloading.then(async () => {
    if (serverManifest !== m) return;
    log(`downloading ${missing.length} file(s)…`);
    for (const e of missing) {
      try { await download(e); } catch (err) { log('download failed:', err.message); }
      if (serverManifest !== m) return;
      if (shownFrom === m) publish(m, 'partial content'); // fill in progressively
    }
    if (serverManifest === m && needed.every(isComplete)) { publish(m, 'new content'); await prune(needed); }
  });
}
// Keep only what the current manifest uses.
async function prune(needed) {
  const keep = new Set(needed.map((e) => e.f));
  for (const dir of await fsp.readdir(CACHE_DIR)) {
    if (!keep.has(dir)) { await fsp.rm(path.join(CACHE_DIR, dir), { recursive: true, force: true }); files.delete(dir); fileKeys.delete(dir); }
  }
}

// ---------- server connection (device protocol, like the add-on) ----------
let ws = null;
let session = null;
let serverUrl = null;
let screenId = null;
let online = false;
let pairing = null;
let backoff = 1000;

async function resolveLocalName(host) {
  const mdns = makeMdns();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no mDNS answer')), 3000);
      mdns.on('response', (r) => {
        const a = r.answers.find((x) => x.type === 'A' && x.name.toLowerCase() === host);
        if (a) { clearTimeout(timer); resolve(a.data); }
      });
      mdns.query({ questions: [{ name: host, type: 'A' }] });
    });
  } finally { mdns.destroy(); }
}

async function discover() {
  const list = [...new Set([state.server, ...(state.addresses || []), ...cfg.candidates].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))];
  const probe = async (url) => {
    const res = await fetch(`${url}/api/hello`, { signal: AbortSignal.timeout(5000) });
    if ((await res.json()).serverId !== cfg.serverId) throw new Error('different server');
    return url;
  };
  try { return await Promise.any(list.map(probe)); } catch {}
  // The system resolver may not do .local names: ask mDNS ourselves.
  for (const u of list) {
    const url = new URL(u);
    if (!url.hostname.endsWith('.local')) continue;
    try { url.hostname = await resolveLocalName(url.hostname); return await probe(url.origin); } catch {}
  }
  throw new Error('server not found');
}

function setOnline(value) {
  if (online === value) return;
  online = value;
  broadcast({ type: 'connection', online });
}

async function connect() {
  try { serverUrl = await discover(); } catch {
    setOnline(false);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
    return;
  }
  const cn = crypto.randomBytes(16).toString('base64');
  let seq = 0;
  const socket = new WebSocket(`${serverUrl.replace(/^http/, 'ws')}/ws`);
  ws = socket;
  socket.on('open', () => {
    backoff = 1000;
    socket.send(JSON.stringify({
      type: 'hello', mode: 'device', signPub: keys.signPub, ecdhPub: keys.ecdhPub, cn, enrollToken: cfg.enrollToken,
      playerVersion: playerVersion(), addonVersion: `agent-${AGENT_VERSION}`, userAgent: `SignageAgent/${AGENT_VERSION} (${model}; ${os.platform()} ${os.arch()})`,
      display: playerInfo.display,
    }));
  });
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'challenge') {
      if (msg.serverId !== cfg.serverId) return socket.close();
      const sig = crypto.sign('sha256', Buffer.from(`signage-auth-v1|${cfg.serverId}|${msg.nonce}|${cn}`), { key: keys.sign, dsaEncoding: 'ieee-p1363' });
      return socket.send(JSON.stringify({ type: 'auth', sig: sig.toString('base64') }));
    }
    if (msg.type === 'error') return log('server refused:', msg.code);
    if (msg.type !== 'signed') return;
    const ok = crypto.verify('sha256', Buffer.from(msg.p), { key: serverSignKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(msg.s, 'base64'));
    const inner = ok ? JSON.parse(msg.p) : null;
    if (!inner || inner.cn !== cn || !(inner.seq > seq)) return log('rejected a message that is not signed by the server');
    seq = inner.seq;
    onServerMessage(inner);
  });
  socket.on('close', () => {
    if (ws === socket) { ws = null; session = null; }
    setOnline(false);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  socket.on('error', () => {});
}

async function onServerMessage(msg) {
  if (msg.type === 'pairing') {
    setOnline(true);
    pairing = { code: msg.code, serverName: msg.serverName || cfg.serverName, fingerprint: cfg.fingerprint };
    log(`waiting to be paired: code ${msg.code}`);
    localManifest = null;
    serverManifest = null;
    await fsp.rm(manifestPath, { force: true });
    await prune([]);
    broadcast({ type: 'pairing', ...pairing });
  } else if (msg.type === 'welcome') {
    pairing = null;
    session = msg.session;
    screenId = msg.screen.id;
    state.server = serverUrl;
    if (Array.isArray(msg.addresses)) state.addresses = msg.addresses;
    saveState();
    setOnline(true);
    log(`connected to ${serverUrl} as screen "${msg.screen.name}"`);
  } else if (msg.type === 'manifest') {
    setOnline(true);
    applyServerManifest(msg.manifest).catch((err) => log('manifest failed:', err.message));
  } else if (msg.type === 'command') {
    broadcast({ type: 'command', command: msg.command });
  }
}

function sendToServer(obj) {
  if (ws?.readyState === WebSocket.OPEN && session) ws.send(JSON.stringify(obj));
}

// ---------- local player (kiosk Chromium) ----------
const playerFile = path.join(PLAYER_DIR, 'player.js');
const playerVersion = () => { try { return /PLAYER_VERSION = '([^']+)'/.exec(fs.readFileSync(playerFile, 'utf8'))[1]; } catch { return null; } };
const players = new Set();
const playerInfo = { display: null, lastStatus: 0 };

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const p of players) if (p.readyState === WebSocket.OPEN) p.send(text);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const localToken = (req) => {
  const u = new URL(req.url, 'http://x');
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : u.searchParams.get('pt');
};
const tokenOk = (t) => typeof t === 'string' && t.length === state.localToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(state.localToken));

async function serveMedia(req, res, f) {
  const e = files.get(f);
  if (!e || !isComplete(e)) { res.writeHead(404); return res.end(); }
  let start = 0;
  let end = e.size - 1;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = Math.min(Number(range[2]), e.size - 1);
    if (!range[1] && range[2]) { start = Math.max(0, e.size - Number(range[2])); end = e.size - 1; }
    if (start > end || start >= e.size) { res.writeHead(416, { 'Content-Range': `bytes */${e.size}` }); return res.end(); }
  }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': e.mime || 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${e.size}` } : {}),
  });
  // Decrypt only the chunks this range needs, one at a time.
  for (let i = Math.floor(start / CHUNK); i <= Math.floor(end / CHUNK) && !res.destroyed; i++) {
    const plain = await readChunk(e, i);
    const from = i * CHUNK;
    const part = plain.subarray(Math.max(0, start - from), Math.min(plain.length, end - from + 1));
    if (!res.write(part)) await new Promise((r) => res.once('drain', r));
  }
  res.end();
}

const localServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      res.writeHead(302, { Location: `/player/player.html#token=${state.localToken}` });
      return res.end();
    }
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname === '/player/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      return res.end('// Linux player: content comes from the local agent.\nself.SIGNAGE_LOCAL = true;\n');
    }
    if (url.pathname.startsWith('/player/')) {
      const name = path.basename(url.pathname);
      const file = path.join(PLAYER_DIR, name);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
    if (!tokenOk(localToken(req))) { res.writeHead(401); return res.end(); }
    if (url.pathname.startsWith('/media/')) return await serveMedia(req, res, url.pathname.slice(7));
    if (url.pathname === '/api/player/manifest') {
      if (!localManifest) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ...localManifest, serverTime: Date.now() + clockOffset }));
    }
    res.writeHead(404);
    res.end();
  } catch (err) {
    log('local request failed:', err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

const localWss = new WebSocketServer({ server: localServer, path: '/ws', maxPayload: 8 * 1024 * 1024 });
localWss.on('connection', (p) => {
  let authed = false;
  p.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!authed) {
      if (msg.type !== 'hello' || !tokenOk(msg.token)) return p.close(4001);
      authed = true;
      players.add(p);
      playerInfo.display = msg.display || playerInfo.display;
      playerInfo.lastStatus = Date.now();
      p.send(JSON.stringify({ type: 'connection', online }));
      if (pairing) p.send(JSON.stringify({ type: 'pairing', ...pairing }));
      else if (localManifest) p.send(JSON.stringify({ type: 'manifest', manifest: { ...localManifest, serverTime: Date.now() + clockOffset }, playerVersion: playerVersion() }));
      return;
    }
    if (msg.type === 'status') {
      playerInfo.lastStatus = Date.now();
      const { cacheBytes, freeBytes } = diskStats();
      const { type, ...status } = msg;
      sendToServer({ type: 'status', ...status, display: playerInfo.display, agent: { version: AGENT_VERSION, model, cacheBytes, freeBytes, diskFull } });
    } else if (msg.type === 'screenshot' && screenId && typeof msg.data === 'string') {
      // The player hands over a plain JPEG; it travels to the server encrypted.
      const sealed = gcmSeal(wrapKey, Buffer.from(msg.data, 'base64'), `screenshot:${screenId}`);
      sendToServer({ type: 'screenshot', iv: sealed.iv.toString('base64'), data: sealed.data.toString('base64') });
    }
  });
  p.on('close', () => players.delete(p));
  p.on('error', () => {});
});

// A player page that stops reporting is reloaded.
setInterval(() => {
  if (players.size && Date.now() - playerInfo.lastStatus > PLAYER_STALL_MS) {
    log('player stopped responding: reloading it');
    playerInfo.lastStatus = Date.now();
    broadcast({ type: 'command', command: 'reload' });
  }
}, 30_000);

// ---------- self-update ----------
// New versions are installed only if they carry a valid signature from the
// server key this device was set up with.
async function checkForUpdate() {
  if (!serverUrl || process.env.SIGNAGE_NO_UPDATE) return;
  try {
    const v = await (await fetch(`${serverUrl}/agent/version.json`, { signal: AbortSignal.timeout(10_000) })).json();
    if (v.serverId !== cfg.serverId || v.version === AGENT_VERSION) return;
    const res = await fetch(`${serverUrl}/agent/signage-agent.tar.gz`, { signal: AbortSignal.timeout(300_000) });
    const body = Buffer.from(await res.arrayBuffer());
    const sig = Buffer.from(res.headers.get('x-signage-signature') || '', 'base64');
    if (!crypto.verify('sha256', body, { key: serverSignKey, dsaEncoding: 'ieee-p1363' }, sig)) return log('rejected an update: bad signature');
    const staging = `${APP_DIR}.new`;
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    await fsp.writeFile(path.join(staging, 'update.tar.gz'), body);
    await run('tar', ['-xzf', 'update.tar.gz'], { cwd: staging });
    await fsp.rm(path.join(staging, 'update.tar.gz'));
    if (!fs.existsSync(path.join(staging, 'agent', 'agent.js'))) throw new Error('update has no agent');
    const old = `${APP_DIR}.old`;
    await fsp.rm(old, { recursive: true, force: true });
    await fsp.rename(APP_DIR, old);
    await fsp.rename(staging, APP_DIR);
    log(`updated ${AGENT_VERSION} → ${v.version}; restarting`);
    process.exit(0); // the service manager starts the new version
  } catch (err) {
    log('update check failed:', err.message);
  }
}
setInterval(checkForUpdate, UPDATE_CHECK_MS);
setTimeout(checkForUpdate, Math.min(60_000, UPDATE_CHECK_MS));

// ---------- start ----------
// Last known content first, so the screen plays straight away, even offline.
try {
  const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  serverManifest = saved;
  publish(saved, 'saved content');
} catch {}

localServer.listen(LOCAL_PORT, '127.0.0.1', () => log(`agent ${AGENT_VERSION} on ${model}; player at http://127.0.0.1:${LOCAL_PORT}/`));
connect();
