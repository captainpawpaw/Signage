// WebSocket hub: one socket per connected player. The server pushes a fresh
// manifest whenever a screen's resolved content changes (admin edit or a
// schedule boundary), and players report what they are showing.
import { WebSocketServer } from 'ws';
import { buildManifest } from './manifest.js';
import { screenByToken } from './auth.js';

const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const SCHEDULE_TICK_MS = 15_000;

export class Hub {
  constructor(store, { log = console.log } = {}) {
    this.store = store;
    this.log = log;
    this.connections = new Map(); // screenId -> Set<conn>
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.wss.on('connection', (ws, req) => this.#onConnection(ws, req));
    this.pinger = setInterval(() => this.#pingAll(), PING_INTERVAL_MS);
    this.ticker = setInterval(() => this.refresh(), SCHEDULE_TICK_MS);
  }

  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  #onConnection(ws, req) {
    const conn = { ws, screenId: null, version: null, status: null, alive: true, ip: req.socket.remoteAddress, connectedAt: Date.now() };
    const helloTimer = setTimeout(() => ws.close(4000, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!conn.screenId) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimer);
        const screen = screenByToken(this.store, msg.token);
        if (!screen) {
          ws.send(JSON.stringify({ type: 'error', code: 'unauthorized' }));
          return ws.close(4001, 'unauthorized');
        }
        conn.screenId = screen.id;
        conn.status = { playerVersion: msg.playerVersion, userAgent: msg.userAgent, display: msg.display };
        if (!this.connections.has(screen.id)) this.connections.set(screen.id, new Set());
        this.connections.get(screen.id).add(conn);
        this.#touch(screen.id);
        this.log(`[signage] screen "${screen.name}" connected from ${conn.ip}`);
        this.#sendManifest(conn, true);
        return;
      }
      if (msg.type === 'status') {
        conn.status = { ...conn.status, ...msg, type: undefined, at: Date.now() };
        this.#touch(conn.screenId, false);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!conn.screenId) return;
      this.connections.get(conn.screenId)?.delete(conn);
      this.#touch(conn.screenId);
    });
    ws.on('error', () => {});
  }

  #touch(screenId, persist = true) {
    const screen = this.store.screens.find((s) => s.id === screenId);
    if (!screen) return;
    screen.lastSeen = new Date().toISOString();
    if (persist) this.store.save();
  }

  #pingAll() {
    for (const set of this.connections.values()) {
      for (const conn of set) {
        if (!conn.alive) { conn.ws.terminate(); continue; }
        conn.alive = false;
        conn.ws.ping();
      }
    }
  }

  #sendManifest(conn, force = false) {
    const screen = this.store.screens.find((s) => s.id === conn.screenId);
    if (!screen) return conn.ws.close(4001, 'screen deleted');
    const manifest = buildManifest(this.store, screen);
    if (!force && manifest.version === conn.version) return;
    conn.version = manifest.version;
    conn.ws.send(JSON.stringify({ type: 'manifest', manifest }));
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
    for (const conn of set || []) conn.ws.send(JSON.stringify({ type: 'command', command }));
    return set?.size || 0;
  }

  // Kick a screen's players, e.g. after its token was regenerated.
  disconnect(screenId) {
    for (const conn of this.connections.get(screenId) || []) conn.ws.close(4001, 'token revoked');
  }

  status(screenId) {
    const conns = [...(this.connections.get(screenId) || [])];
    const latest = conns.sort((a, b) => (b.status?.at || 0) - (a.status?.at || 0))[0];
    return {
      online: conns.length > 0,
      connections: conns.length,
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
