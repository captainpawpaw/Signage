// WebSocket hub: one socket per connected player.
//
// Encrypted devices (the add-on):
//   hello {mode:'device', signPub, ecdhPub, cn, enrollToken?}  → challenge {nonce}
//   auth {sig over "signage-auth-v1|serverId|nonce|cn"}          → proves the device holds its key
//   then: a known device is attached to its screen; a pre-configured add-on
//   enrols with its one-time token; anything else gets a pairing code that an
//   admin approves in the console. Every server→device message is signed and
//   bound to this connection (cn) with an increasing sequence number.
// Unencrypted players (browser previews, v1 add-ons):
//   hello {mode:'preview', token} → plain manifests with /files URLs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { buildManifest, forPlayer } from './manifest.js';
import { screenByPreviewToken, findByToken, randomToken } from './auth.js';
import { AUTH_PREFIX, isValidDeviceKey, verifyDeviceSignature, seal, open } from './crypto.js';

const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const SCHEDULE_TICK_MS = 15_000;
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class Hub {
  constructor(store, { keys, files, screenshotsDir, candidates, addonVersion, log = console.log }) {
    Object.assign(this, { store, keys, files, screenshotsDir, candidates, addonVersion, log });
    this.connections = new Map(); // screenId -> Set<conn>
    this.pairing = new Map();     // code -> conn
    this.sessions = new Map();    // session token -> conn (for encrypted chunk downloads)
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this.#onConnection(ws, req));
    this.pinger = setInterval(() => this.#pingAll(), PING_INTERVAL_MS);
    this.ticker = setInterval(() => this.refresh(), SCHEDULE_TICK_MS);
  }

  get serverId() { return this.store.settings.serverId; }

  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  #onConnection(ws, req) {
    const conn = { ws, mode: null, screenId: null, seq: 0, alive: true, ip: req.socket.remoteAddress?.replace(/^::ffff:/, ''), connectedAt: Date.now() };
    ws.conn = conn;
    const helloTimer = setTimeout(() => ws.close(4000, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        if (msg.type === 'hello' && !conn.mode) { clearTimeout(helloTimer); this.#hello(conn, msg); }
        else if (msg.type === 'auth' && conn.mode === 'challenge') this.#auth(conn, msg);
        else if (msg.type === 'status' && conn.screenId) {
          const { type, ...status } = msg;
          conn.status = { ...conn.status, ...status, at: Date.now() };
          this.#touch(conn.screenId, false);
        } else if (msg.type === 'screenshot' && conn.screenId) this.#screenshot(conn, msg);
      } catch (err) {
        this.log(`[signage] bad message from ${conn.ip}: ${err.message}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (conn.code) this.pairing.delete(conn.code);
      if (conn.session) this.sessions.delete(conn.session);
      if (!conn.screenId) return;
      this.connections.get(conn.screenId)?.delete(conn);
      this.#touch(conn.screenId);
    });
    ws.on('error', () => {});
  }

  #reject(conn, code = 'unauthorized') {
    conn.ws.send(JSON.stringify({ type: 'error', code }));
    conn.ws.close(4001, code);
  }

  #info(msg) {
    const clip = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    return {
      playerVersion: clip(msg.playerVersion, 20), addonVersion: clip(msg.addonVersion, 20), userAgent: clip(msg.userAgent),
      display: msg.display && typeof msg.display === 'object'
        ? { width: Number(msg.display.width) || 0, height: Number(msg.display.height) || 0, dpr: Number(msg.display.dpr) || 1 } : undefined,
    };
  }

  #hello(conn, msg) {
    conn.status = this.#info(msg);
    if (msg.mode === 'device') {
      if (!isValidDeviceKey(msg.signPub) || !isValidDeviceKey(msg.ecdhPub) || typeof msg.cn !== 'string' || msg.cn.length > 64) {
        return this.#reject(conn, 'bad-hello');
      }
      Object.assign(conn, { mode: 'challenge', signPub: msg.signPub, ecdhPub: msg.ecdhPub, cn: msg.cn, enrollToken: msg.enrollToken, nonce: randomToken(24) });
      conn.ws.send(JSON.stringify({ type: 'challenge', nonce: conn.nonce, serverId: this.serverId }));
      return;
    }
    // Preview / legacy v1 player: unencrypted, token-only.
    const screen = this.store.settings.allowPlaintext ? screenByPreviewToken(this.store, msg.token) : null;
    if (!screen) return this.#reject(conn, this.store.settings.allowPlaintext ? 'unauthorized' : 'encryption-required');
    conn.mode = 'preview';
    this.#join(conn, screen);
  }

  #auth(conn, msg) {
    const message = `${AUTH_PREFIX}|${this.serverId}|${conn.nonce}|${conn.cn}`;
    if (!verifyDeviceSignature(conn.signPub, message, msg.sig)) return this.#reject(conn);

    let screen = this.store.screens.find((s) => s.device?.signPub === conn.signPub);
    if (!screen && conn.enrollToken) {
      screen = findByToken(this.store.screens, 'enrollToken', conn.enrollToken);
      if (screen) {
        if (screen.device) this.#dropDevice(screen.id);
        this.#bindDevice(screen, conn);
        screen.enrollToken = null; // one-time
        this.store.save();
        this.log(`[signage] device enrolled for screen "${screen.name}" from ${conn.ip}`);
      }
    }
    if (screen) return this.#join(conn, screen);

    // Unknown device: hand out a pairing code and wait for an admin.
    let code;
    do code = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    while (this.pairing.has(code));
    Object.assign(conn, { mode: 'pairing', code, since: Date.now() });
    this.pairing.set(code, conn);
    this.#sendSigned(conn, { type: 'pairing', code, serverName: this.store.settings.serverName });
    this.log(`[signage] screen waiting to pair from ${conn.ip}: code ${code}`);
  }

  #bindDevice(screen, conn) {
    screen.device = { signPub: conn.signPub, ecdhPub: conn.ecdhPub, pairedAt: new Date().toISOString(), userAgent: conn.status?.userAgent || '' };
  }

  // Admin approved a pairing code.
  claim(code, screen) {
    const conn = this.pairing.get(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) return false;
    this.pairing.delete(conn.code);
    conn.code = null;
    if (screen.device) this.#dropDevice(screen.id);
    this.#bindDevice(screen, conn);
    this.store.save();
    this.log(`[signage] paired ${conn.ip} with screen "${screen.name}"`);
    this.#join(conn, screen);
    return true;
  }

  pending() {
    return [...this.pairing.values()].map((c) => ({ code: c.code, ip: c.ip, since: new Date(c.since).toISOString(), ...c.status }));
  }

  #join(conn, screen) {
    conn.screenId = screen.id;
    if (conn.mode !== 'preview') {
      conn.mode = 'device';
      conn.key = this.keys.deviceKey(conn.ecdhPub, this.serverId);
      conn.session = randomToken(24);
      this.sessions.set(conn.session, conn);
      this.#sendSigned(conn, {
        type: 'welcome', screen: { id: screen.id, name: screen.name }, session: conn.session,
        addresses: this.candidates(), addonVersion: this.addonVersion,
      });
    }
    if (!this.connections.has(screen.id)) this.connections.set(screen.id, new Set());
    this.connections.get(screen.id).add(conn);
    this.#touch(screen.id);
    this.log(`[signage] screen "${screen.name}" connected from ${conn.ip} (${conn.mode === 'device' ? 'encrypted' : 'unencrypted preview'})`);
    this.#sendManifest(conn, true);
  }

  #send(conn, obj) {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.mode === 'preview') return conn.ws.send(JSON.stringify(obj));
    this.#sendSigned(conn, obj);
  }

  #sendSigned(conn, obj) {
    const p = JSON.stringify({ ...obj, cn: conn.cn, seq: ++conn.seq, ts: Date.now() });
    conn.ws.send(JSON.stringify({ type: 'signed', p, s: this.keys.sign(p) }));
  }

  #sendManifest(conn, force = false) {
    const screen = this.store.screens.find((s) => s.id === conn.screenId);
    if (!screen) return conn.ws.close(4001, 'screen deleted');
    const manifest = buildManifest(this.store, screen);
    if (!force && manifest.version === conn.version) return;
    conn.version = manifest.version;
    const shaped = conn.mode === 'preview'
      ? forPlayer(manifest, 'plain')
      : forPlayer(manifest, 'device', {
        fileEntry: this.files.entry,
        wrap: (entry) => {
          const { iv, data } = seal(conn.key, Buffer.from(entry.key, 'base64'), entry.id);
          return { k: data.toString('base64'), kiv: iv.toString('base64') };
        },
      });
    this.#send(conn, { type: 'manifest', manifest: shaped });
  }

  #screenshot(conn, msg) {
    if (typeof msg.data !== 'string' || msg.data.length > MAX_SCREENSHOT_BYTES * 1.4) return;
    let jpeg = Buffer.from(msg.data, 'base64');
    if (conn.mode === 'device') jpeg = open(conn.key, Buffer.from(String(msg.iv), 'base64'), jpeg, `screenshot:${conn.screenId}`);
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return; // JPEG only
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    fs.writeFileSync(path.join(this.screenshotsDir, `${conn.screenId}.jpg`), jpeg);
    const screen = this.store.screens.find((s) => s.id === conn.screenId);
    if (screen) { screen.screenshotAt = new Date().toISOString(); this.store.save(); }
  }

  #touch(screenId, persist = true) {
    const screen = this.store.screens.find((s) => s.id === screenId);
    if (!screen) return;
    screen.lastSeen = new Date().toISOString();
    if (persist) this.store.save();
  }

  #pingAll() {
    for (const ws of this.wss.clients) {
      if (!ws.conn.alive) { ws.terminate(); continue; }
      ws.conn.alive = false;
      ws.ping();
    }
  }

  // Re-resolve content and push to players whose manifest changed.
  refresh(screenId) {
    for (const [id, set] of this.connections) {
      if (screenId && id !== screenId) continue;
      for (const conn of set) this.#sendManifest(conn);
    }
  }

  command(screenId, command) {
    const set = this.connections.get(screenId);
    for (const conn of set || []) this.#send(conn, { type: 'command', command });
    return set?.size || 0;
  }

  // Kick a screen's players, e.g. after its tokens were regenerated.
  disconnect(screenId, { devicesOnly = false } = {}) {
    for (const conn of this.connections.get(screenId) || []) {
      if (!devicesOnly || conn.mode === 'device') conn.ws.close(4001, 'revoked');
    }
  }

  #dropDevice(screenId) { this.disconnect(screenId, { devicesOnly: true }); }

  // Preview players lose access when unencrypted playback is switched off.
  dropPreviews() {
    for (const set of this.connections.values()) for (const conn of set) if (conn.mode === 'preview') conn.ws.close(4001, 'encryption-required');
  }

  sessionConn(token) {
    const conn = typeof token === 'string' ? this.sessions.get(token) : null;
    return conn && conn.ws.readyState === conn.ws.OPEN ? conn : null;
  }

  status(screenId) {
    const conns = [...(this.connections.get(screenId) || [])];
    const latest = conns.sort((a, b) => (b.status?.at || 0) - (a.status?.at || 0))[0];
    return {
      online: conns.length > 0,
      connections: conns.length,
      encrypted: latest ? latest.mode === 'device' : null,
      ip: latest?.ip || null,
      ...(latest?.status || {}),
    };
  }

  close() {
    clearInterval(this.pinger);
    clearInterval(this.ticker);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}
