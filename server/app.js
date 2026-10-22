import express from 'express';
import multer from 'multer';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Hub } from './realtime.js';
import { buildManifest, forPlayer, DEFAULT_SETTINGS } from './manifest.js';
import { activeRule, activeOverride, resolvePlaylistId, scheduleTimeline, localMidnights, defaultPlaylistId, DEFAULT_TIMEZONE, OVERRIDE_RULE_ID } from './schedule.js';
import { createRelay, parseM3u, cleanStreamUrl, streamFormat, PLAYER_VENDOR } from './live.js';
import { ADDON_VERSION, addonId, addonConfig, buildAddonZip, buildAddonCrx, buildScreenSetupZip, updatesXml } from './extension.js';
import { agentVersion, buildAgentPackage, buildLinuxSetup } from './linux.js';
import { convertDeck, transcodeVideo, detectTools, OFFICE_EXTENSIONS } from './convert.js';
import { ServerKeys, CHUNK_SIZE, chunkCount, encryptChunk, newFileKey } from './crypto.js';
import { candidateUrls, startMdns } from './network.js';
import { cleanOffline, cleanScreenOffline, qrDataUrl, DEFAULT_OFFLINE } from './offline.js';
import {
  initAuth, checkPassword, setPassword, issueSession, clearSession,
  isAdmin, previewScreenFromRequest, randomToken, randomCode,
} from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const MAX_CHANNELS_PER_IMPORT = 5000;
const COMMANDS = ['reload', 'identify', 'next', 'screenshot'];
const id = () => crypto.randomUUID();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

function cleanSettings(input = {}) {
  const out = {};
  if (['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped'].includes(input.orientation)) out.orientation = input.orientation;
  if (['contain', 'cover'].includes(input.fit)) out.fit = input.fit;
  if (['fade', 'none'].includes(input.transition)) out.transition = input.transition;
  if (/^#[0-9a-f]{3,8}$/i.test(input.background || '')) out.background = input.background;
  if (['auto', 'low', 'standard'].includes(input.power)) out.power = input.power;
  return out;
}

function cleanSchedule(rules = []) {
  if (!Array.isArray(rules)) throw new HttpError(400, 'schedule must be an array');
  const time = (t) => (/^\d{1,2}:\d{2}$/.test(t || '') ? t : undefined);
  const date = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);
  return rules.map((r) => ({
    id: r.id || id(),
    playlistId: r.playlistId || null,
    days: Array.isArray(r.days) ? r.days.map(Number).filter((d) => d >= 0 && d <= 6) : [],
    start: time(r.start) || '00:00',
    end: time(r.end) || '00:00',
    startDate: date(r.startDate),
    endDate: date(r.endDate),
    priority: Number(r.priority) || 0,
    enabled: r.enabled !== false,
  })).filter((r) => r.playlistId);
}

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
function cleanOverlay(o, store) {
  if (!o || typeof o !== 'object') return null;
  const color = (c, fallback) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : fallback);
  const out = {};
  const text = typeof o.ticker?.text === 'string' ? o.ticker.text.trim().slice(0, 2000) : '';
  if (text) {
    out.ticker = {
      text,
      position: o.ticker.position === 'top' ? 'top' : 'bottom',
      speed: ['slow', 'normal', 'fast'].includes(o.ticker.speed) ? o.ticker.speed : 'normal',
      size: ['small', 'medium', 'large'].includes(o.ticker.size) ? o.ticker.size : 'medium',
      color: color(o.ticker.color, '#ffffff'),
      background: color(o.ticker.background, '#000000cc'),
    };
  }
  const logo = o.logo?.mediaId && store.media.find((m) => m.id === o.logo.mediaId && m.type === 'image');
  if (logo) {
    out.logo = {
      mediaId: logo.id,
      corner: CORNERS.includes(o.logo.corner) ? o.logo.corner : 'top-right',
      size: Math.min(40, Math.max(3, Number(o.logo.size) || 12)), // % of the screen width
    };
  }
  return out.ticker || out.logo ? out : null;
}

function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Screens and groups share these fields.
function cleanGroupIds(store, ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids)].filter((gid) => store.groups.some((g) => g.id === gid));
}

// Short preview-link code (/p/K7Q2MX), unique across screens.
function uniqueShortCode(store) {
  let code;
  do code = randomCode(6);
  while (store.screens.some((s) => s.shortCode === code));
  return code;
}

// Brings data written by older versions up to date.
function migrate(store) {
  const s = store.settings;
  s.serverId ||= crypto.randomBytes(9).toString('base64url');
  s.serverName ||= 'Signage';
  if (s.allowPlaintext === undefined) s.allowPlaintext = true;
  s.offline = { ...DEFAULT_OFFLINE, ...s.offline };
  s.relaySecret ||= crypto.randomBytes(32).toString('base64url');
  // Schedule rules used to live on each screen and group; they are now
  // schedule entries that can target any mix of screens and groups.
  store.data.schedules ||= [];
  const entryFromRule = (rule, targets) => ({
    ...rule, name: store.playlists.find((p) => p.id === rule.playlistId)?.name || 'Scheduled content',
    targets, createdAt: new Date().toISOString(),
  });
  for (const screen of store.screens) {
    for (const rule of screen.schedule || []) store.schedules.push(entryFromRule(rule, { screenIds: [screen.id], groupIds: [] }));
    screen.schedule = [];
  }
  for (const group of store.groups || []) {
    for (const rule of group.schedule || []) store.schedules.push(entryFromRule(rule, { screenIds: [], groupIds: [group.id] }));
    group.schedule = [];
  }
  for (const screen of store.screens) {
    // v1 screens had one token baked into their add-on; it keeps working as the
    // (unencrypted) preview token so nothing breaks during the upgrade.
    if (!screen.previewToken) screen.previewToken = screen.token || randomToken();
    if (screen.enrollToken === undefined) screen.enrollToken = randomToken();
    if (screen.shortCode === undefined) screen.shortCode = null;
    if (screen.device === undefined) screen.device = null;
    screen.groupIds ||= [];
    screen.offline ||= { mode: 'default' };
    delete screen.token;
    delete screen.tokenRevision;
  }
  store.save();
}

export async function createApp({
  dataDir = path.join(ROOT, 'data'), adminPassword, publicUrl, tls = null, mdns = true, log = console.log,
} = {}) {
  publicUrl = publicUrl?.replace(/\/+$/, '') || null;
  const mediaDir = path.join(dataDir, 'media');
  const screenshotsDir = path.join(dataDir, 'screenshots');
  fs.mkdirSync(mediaDir, { recursive: true });
  const store = new Store(path.join(dataDir, 'db.json'));
  initAuth(store, { dataDir, adminPassword, log });
  migrate(store);
  const keys = new ServerKeys(path.join(dataDir, 'keys'));
  const converters = await detectTools();

  // Every file a player may download gets its own random AES key, created on first use.
  const fileIndex = new Map(Object.entries(store.fileKeys).map(([rel, e]) => [e.id, rel]));
  const files = {
    entry(rel) {
      let e = store.fileKeys[rel];
      if (!e) {
        const full = path.join(mediaDir, rel);
        if (!fs.existsSync(full)) return null;
        const size = fs.statSync(full).size;
        e = { ...newFileKey(), size, chunks: chunkCount(size) };
        store.fileKeys[rel] = e;
        fileIndex.set(e.id, rel);
        store.save();
      }
      return e;
    },
    byId(fid) {
      const rel = fileIndex.get(fid);
      return rel ? { rel, entry: store.fileKeys[rel] } : null;
    },
    forget(rel) {
      const e = store.fileKeys[rel];
      if (e) { fileIndex.delete(e.id); delete store.fileKeys[rel]; }
    },
  };

  let server;
  const port = () => server?.address()?.port || Number(process.env.PORT) || 8080;
  const candidates = () => candidateUrls({ publicUrl, port: port(), secure: Boolean(tls) });
  const updateBase = () => publicUrl || candidates()[0];
  const addonOpts = (extra = {}) => ({ keys, settings: store.settings, candidates: candidates(), updateBase: updateBase(), ...extra });

  // Version of the player the server hands out to preview links; open preview
  // pages reload themselves when it changes, so updates reach them unattended.
  const playerVersion = /PLAYER_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'player', 'player.js'), 'utf8'))?.[1] || null;
  const hub = new Hub(store, { keys, files, screenshotsDir, candidates, addonVersion: ADDON_VERSION, playerVersion, log });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '1mb' }));

  const screenView = (s) => {
    const rule = activeRule(s, new Date(), store);
    return {
      ...pick(s, ['id', 'name', 'location', 'notes', 'timezone', 'serverUrl', 'defaultPlaylistId', 'schedule', 'groupIds', 'lastSeen', 'createdAt', 'screenshotAt']),
      offline: s.offline || { mode: 'default' },
      settings: { ...DEFAULT_SETTINGS, ...s.settings },
      paired: Boolean(s.device),
      device: s.device ? { pairedAt: s.device.pairedAt, userAgent: s.device.userAgent } : null,
      activePlaylistId: resolvePlaylistId(s, new Date(), store),
      upcoming: upcomingChanges(s),
      activeRuleId: rule?.id || null,
      activeGroup: rule?.group || null,
      playNow: (() => {
        const o = activeOverride(s);
        if (!o) return null;
        const pl = store.playlists.find((p) => p.id === o.playlistId);
        return { playlistId: o.playlistId, name: pl?.name || 'Play now', from: o.from, until: o.until || null };
      })(),
      status: hub.status(s.id),
    };
  };
  const previewLinks = (screen) => ({
    url: `/player/player.html#token=${encodeURIComponent(screen.previewToken)}`,
    shortUrl: screen.shortCode ? `/p/${screen.shortCode}` : null,
  });
  // The next few scheduled playlist changes, for the console.
  const upcomingChanges = (screen, count = 3) => {
    const now = Date.now();
    const { segments } = scheduleTimeline(screen, store, now);
    const changes = segments.filter((seg, i) => i === 0 || seg.playlistId !== segments[i - 1].playlistId);
    return changes.filter((seg) => seg.from > now).slice(0, count).map((seg) => ({
      at: new Date(seg.from).toISOString(),
      playlistId: seg.playlistId,
      playlistName: store.playlists.find((p) => p.id === seg.playlistId)?.name || null,
    }));
  };
  const findOr404 = (list, itemId, what) => {
    const item = list.find((x) => x.id === itemId);
    if (!item) throw new HttpError(404, `${what} not found`);
    return item;
  };
  const changed = () => { store.save(); hub.refresh(); };

  // Players and screen PCs call these from other origins (the add-on, scripts).
  app.use(['/api/hello', '/api/player', '/files', '/addon', '/agent', '/live'], (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, X-Signage-Session',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Expose-Headers': 'X-Signage-Signature',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Live channels through this server, for streams screens can't open directly.
  const relay = createRelay(store.settings.relaySecret, { log });
  app.get('/live/:channelId/:sig', (req, res) => relay.handle(req, res, store.media.find((m) => m.id === req.params.channelId && m.type === 'stream')));
  // Stream player libraries, shipped next to the player.
  for (const [name, file] of Object.entries(PLAYER_VENDOR)) {
    app.get(`/player/${name}`, (req, res) => res.set('Cache-Control', 'no-cache').type('js').sendFile(file));
  }

  // ---- Admin session ----
  app.post('/api/login', (req, res) => {
    if (!checkPassword(store, req.body?.password)) throw new HttpError(401, 'Wrong password');
    issueSession(store, res, req.secure);
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

  // ---- Player endpoints ----
  // Discovery probe: add-ons try every known address and keep the one whose
  // serverId matches (the signed WebSocket handshake then proves it).
  app.get('/api/hello', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ app: 'signage', serverId: store.settings.serverId, name: store.settings.serverName });
  });

  // Short preview links: /p/K7Q2MX → the screen's full preview link.
  // Misses are limited per address so codes can't be guessed by trying them all.
  const misses = new Map();
  app.get('/p/:code', (req, res) => {
    const now = Date.now();
    const m = misses.get(req.ip);
    if (m && m.until > now && m.count >= 20) throw new HttpError(429, 'Too many wrong codes – try again in 10 minutes');
    const code = String(req.params.code).toUpperCase();
    const screen = store.settings.allowPlaintext ? store.screens.find((s) => s.shortCode && s.shortCode === code) : null;
    if (!screen) {
      misses.set(req.ip, m && m.until > now ? { ...m, count: m.count + 1 } : { count: 1, until: now + 10 * 60_000 });
      return res.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><p style="font:18px system-ui;margin:40px">This signage link is not valid (any more). Ask for a new one.</p>');
    }
    res.set('Cache-Control', 'no-store').redirect(`/player/player.html#token=${encodeURIComponent(screen.previewToken)}`);
  });

  // Unencrypted players (previews) only.
  app.get('/api/player/manifest', (req, res) => {
    const screen = previewScreenFromRequest(store, req);
    if (!screen) throw new HttpError(401, 'Unknown screen token');
    res.set('Cache-Control', 'no-store').json({ ...forPlayer(buildManifest(store, screen), 'plain'), serverTime: Date.now() });
  });

  // Encrypted devices fetch files as AES-GCM chunks, authorised by the session
  // issued over their signed WebSocket. Only the paired device can unwrap the key.
  app.get('/api/player/chunk/:fid/:index', async (req, res) => {
    if (!hub.sessionConn(req.get('X-Signage-Session'))) throw new HttpError(401, 'No session');
    const found = files.byId(req.params.fid);
    if (!found) throw new HttpError(404, 'Unknown file');
    const { entry, rel } = found;
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= entry.chunks) throw new HttpError(400, 'Bad chunk');
    const len = Math.min(CHUNK_SIZE, entry.size - index * CHUNK_SIZE);
    const buf = Buffer.alloc(len);
    const fh = await fsp.open(path.join(mediaDir, rel));
    try { await fh.read(buf, 0, len, index * CHUNK_SIZE); } finally { await fh.close(); }
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }).send(encryptChunk(entry, index, buf, entry.chunks));
  });

  // Plain media files: the admin console, and unencrypted previews when allowed.
  app.get('/files/*file', (req, res) => {
    if (!isAdmin(store, req) && !previewScreenFromRequest(store, req)) throw new HttpError(401, 'Unauthorized');
    const rel = [].concat(req.params.file).join('/');
    const full = path.resolve(mediaDir, rel);
    if (!full.startsWith(mediaDir + path.sep)) throw new HttpError(400, 'Bad path');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  // ---- Add-on downloads (public: they contain public keys and addresses only) ----
  const sendZip = (res, name, buf) => {
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'X-Signage-Signature': keys.sign(buf) });
    res.send(buf);
  };
  app.get('/addon/version.json', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ serverId: store.settings.serverId, version: ADDON_VERSION, extensionId: addonId(keys) });
  });
  app.get('/addon/signage-chrome.zip', async (req, res) => sendZip(res, 'signage-chrome-edge.zip', await buildAddonZip(addonOpts({ browser: 'chrome' }))));
  app.get('/addon/signage-firefox.zip', async (req, res) => sendZip(res, 'signage-firefox.zip', await buildAddonZip(addonOpts({ browser: 'firefox' }))));
  app.get('/addon/screen-setup.zip', async (req, res) => sendZip(res, 'signage-screen-setup.zip', await buildScreenSetupZip(addonOpts())));
  app.get('/addon/signage.crx', async (req, res) => {
    res.set('Content-Type', 'application/x-chrome-extension').send(await buildAddonCrx(addonOpts()));
  });
  // Linux player (Raspberry Pi etc.): the generic setup file, and the signed
  // package the agent updates itself from.
  const sendSetup = (res, name, config) => {
    res.set({ 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    res.send(buildLinuxSetup(config));
  };
  app.get('/addon/signage-linux-setup.sh', (req, res) => sendSetup(res, 'signage-linux-setup.sh', addonConfig(addonOpts())));
  app.get('/agent/version.json', (req, res) => res.set('Cache-Control', 'no-store').json({ serverId: store.settings.serverId, version: agentVersion() }));
  app.get('/agent/signage-agent.tar.gz', (req, res) => {
    const pkg = buildAgentPackage();
    res.set({ 'Content-Type': 'application/gzip', 'X-Signage-Signature': keys.sign(pkg), 'Cache-Control': 'no-store' }).send(pkg);
  });
  app.get('/addon/updates.xml', (req, res) => res.type('application/xml').send(updatesXml({ keys, updateBase: updateBase() })));
  app.get('/addon', (req, res) => res.redirect('/addon/'));
  app.get('/addon/', (req, res) => res.type('html').send(addonPage(store.settings, keys)));

  // ---- Everything else under /api requires the admin ----
  app.use('/api', (req, res, next) => (isAdmin(store, req) ? next() : next(new HttpError(401, 'Login required'))));

  app.get('/api/info', (req, res) => res.json({
    defaultTimezone: DEFAULT_TIMEZONE,
    publicUrl,
    converters,
    defaults: DEFAULT_SETTINGS,
    timezones: Intl.supportedValuesOf?.('timeZone') || [],
    serverId: store.settings.serverId,
    serverName: store.settings.serverName,
    allowPlaintext: store.settings.allowPlaintext,
    offline: { ...store.settings.offline, qrPreview: qrDataUrl(store.settings.offline.qr) },
    fingerprint: keys.fingerprint,
    addonVersion: ADDON_VERSION,
    agentVersion: agentVersion(),
    signageOsUrl: process.env.SIGNAGE_OS_URL || 'https://github.com/captainpawpaw/Signage/releases/latest',
    extensionId: addonId(keys),
    candidates: candidates(),
    updateUrl: `${updateBase()}/addon/updates.xml`,
    tls: Boolean(tls),
  }));

  app.put('/api/settings', (req, res) => {
    const b = req.body || {};
    if (typeof b.serverName === 'string' && b.serverName.trim()) store.settings.serverName = b.serverName.trim().slice(0, 60);
    if (typeof b.allowPlaintext === 'boolean') {
      store.settings.allowPlaintext = b.allowPlaintext;
      if (!b.allowPlaintext) hub.dropPreviews();
    }
    if (b.offline !== undefined) store.settings.offline = cleanOffline(b.offline);
    changed();
    res.json({
      serverName: store.settings.serverName, allowPlaintext: store.settings.allowPlaintext,
      offline: { ...store.settings.offline, qrPreview: qrDataUrl(store.settings.offline.qr) },
    });
  });

  // Lets the console preview a QR code before saving it.
  app.post('/api/qr-preview', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 500) : '';
    res.json({ dataUrl: text ? qrDataUrl(text) : null });
  });

  app.post('/api/password', (req, res) => {
    const { current, next } = req.body || {};
    if (!checkPassword(store, current)) throw new HttpError(400, 'Current password is wrong');
    if (typeof next !== 'string' || next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    setPassword(store, next);
    res.json({ ok: true });
  });

  // Screens
  app.get('/api/screens', (req, res) => res.json(store.screens.map(screenView)));

  app.post('/api/screens', (req, res) => {
    const b = req.body || {};
    if (!b.name?.trim()) throw new HttpError(400, 'Name is required');
    const screen = {
      id: id(), name: b.name.trim(), location: b.location || '', notes: b.notes || '',
      previewToken: randomToken(), enrollToken: randomToken(), shortCode: null, device: null,
      groupIds: cleanGroupIds(store, b.groupIds),
      timezone: validTimezone(b.timezone) ? b.timezone : DEFAULT_TIMEZONE,
      serverUrl: b.serverUrl || '', defaultPlaylistId: b.defaultPlaylistId || null,
      settings: cleanSettings(b.settings), schedule: cleanSchedule(b.schedule), offline: cleanScreenOffline(b.offline),
      createdAt: new Date().toISOString(), lastSeen: null,
    };
    store.screens.push(screen);
    store.save();
    res.status(201).json(screenView(screen));
  });

  app.get('/api/screens/:id', (req, res) => res.json(screenView(findOr404(store.screens, req.params.id, 'Screen'))));

  app.put('/api/screens/:id', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    const b = req.body || {};
    if (b.name !== undefined) {
      if (!String(b.name).trim()) throw new HttpError(400, 'Name is required');
      screen.name = String(b.name).trim();
    }
    for (const k of ['location', 'notes', 'serverUrl']) if (b[k] !== undefined) screen[k] = String(b[k]);
    if (b.timezone !== undefined) {
      if (!validTimezone(b.timezone)) throw new HttpError(400, 'Unknown time zone');
      screen.timezone = b.timezone;
    }
    if (b.defaultPlaylistId !== undefined) screen.defaultPlaylistId = b.defaultPlaylistId || null;
    if (b.settings !== undefined) screen.settings = cleanSettings(b.settings);
    if (b.schedule !== undefined) screen.schedule = cleanSchedule(b.schedule);
    if (b.groupIds !== undefined) screen.groupIds = cleanGroupIds(store, b.groupIds);
    if (b.offline !== undefined) screen.offline = cleanScreenOffline(b.offline);
    changed();
    res.json(screenView(screen));
  });

  app.delete('/api/screens/:id', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    store.data.screens = store.screens.filter((s) => s !== screen);
    store.save();
    hub.disconnect(screen.id);
    fs.rmSync(path.join(screenshotsDir, `${screen.id}.jpg`), { force: true });
    for (const e of store.schedules) e.targets.screenIds = e.targets.screenIds.filter((x) => x !== screen.id);
    dropUnusedPlayNow();
    store.save();
    res.json({ ok: true });
  });

  // Unpairs the device and replaces every access token: the installed add-on,
  // pre-configured downloads and preview links all stop working.
  app.post('/api/screens/:id/regenerate-token', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    Object.assign(screen, {
      previewToken: randomToken(), enrollToken: randomToken(), device: null,
      shortCode: screen.shortCode ? uniqueShortCode(store) : null,
    });
    store.save();
    hub.disconnect(screen.id);
    res.json(screenView(screen));
  });

  app.post('/api/screens/:id/command', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    if (!COMMANDS.includes(req.body?.command)) throw new HttpError(400, `command must be one of ${COMMANDS.join(', ')}`);
    res.json({ delivered: hub.command(screen.id, req.body.command) });
  });

  app.get('/api/screens/:id/manifest', (req, res) => {
    res.json(buildManifest(store, findOr404(store.screens, req.params.id, 'Screen')));
  });

  // Preview link that runs the same player in any browser tab, no add-on needed.
  app.get('/api/screens/:id/preview-url', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    if (!store.settings.allowPlaintext) throw new HttpError(409, 'Unencrypted previews are switched off in Settings');
    res.json(previewLinks(screen));
  });

  // Short links are optional: the admin creates (or removes) one per screen.
  app.post('/api/screens/:id/short-link', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    if (!store.settings.allowPlaintext) throw new HttpError(409, 'Unencrypted previews are switched off in Settings');
    screen.shortCode = uniqueShortCode(store);
    store.save();
    res.json(previewLinks(screen));
  });

  app.delete('/api/screens/:id/short-link', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    screen.shortCode = null;
    store.save();
    res.json(previewLinks(screen));
  });

  app.get('/api/screens/:id/screenshot.jpg', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    res.set('Cache-Control', 'private, max-age=3600'); // URLs carry the screenshot time
    res.sendFile(path.join(screenshotsDir, `${screen.id}.jpg`), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  // Pre-configured add-on: pairs itself with this screen on first start using
  // a one-time token. Each download issues a new token.
  app.get('/api/screens/:id/extension.zip', async (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    const browser = ['firefox', 'linux'].includes(req.query.browser) ? req.query.browser : 'chrome';
    screen.enrollToken = randomToken();
    store.save();
    const slug = screen.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'screen';
    if (browser === 'linux') return sendSetup(res, `signage-linux-setup-${slug}.sh`, addonConfig(addonOpts({ screen })));
    const zip = await buildAddonZip(addonOpts({ browser, screen }));
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="signage-${slug}-${browser}.zip"`);
    res.send(zip);
  });

  // Pairing: screens running the universal add-on show a code.
  app.get('/api/pairings', (req, res) => res.json(hub.pending()));

  app.post('/api/pairings/:code', (req, res) => {
    const b = req.body || {};
    let screen;
    if (b.screenId) screen = findOr404(store.screens, b.screenId, 'Screen');
    else {
      if (!b.name?.trim()) throw new HttpError(400, 'Choose a screen or give the new one a name');
      screen = {
        id: id(), name: b.name.trim(), location: b.location || '', notes: '',
        previewToken: randomToken(), enrollToken: randomToken(), shortCode: null, device: null, groupIds: cleanGroupIds(store, b.groupIds),
        timezone: DEFAULT_TIMEZONE, serverUrl: '', defaultPlaylistId: b.defaultPlaylistId || null,
        settings: {}, schedule: [], offline: { mode: 'default' }, createdAt: new Date().toISOString(), lastSeen: null,
      };
    }
    const isNew = !store.screens.includes(screen);
    if (isNew) store.screens.push(screen);
    if (!hub.claim(req.params.code, screen)) {
      if (isNew) store.data.screens = store.screens.filter((s) => s !== screen);
      throw new HttpError(404, 'No screen is showing that code (it may have disconnected)');
    }
    store.save();
    res.json(screenView(screen));
  });

  // Groups
  app.get('/api/groups', (req, res) => res.json(store.groups));

  app.post('/api/groups', (req, res) => {
    const b = req.body || {};
    if (!b.name?.trim()) throw new HttpError(400, 'Name is required');
    const group = { id: id(), name: b.name.trim(), defaultPlaylistId: b.defaultPlaylistId || null, schedule: cleanSchedule(b.schedule) };
    store.groups.push(group);
    if (Array.isArray(b.screenIds)) setMembers(group, b.screenIds);
    changed();
    res.status(201).json(group);
  });

  function setMembers(group, screenIds) {
    for (const s of store.screens) {
      const want = screenIds.includes(s.id);
      const has = s.groupIds.includes(group.id);
      if (want && !has) s.groupIds.push(group.id);
      if (!want && has) s.groupIds = s.groupIds.filter((g) => g !== group.id);
    }
  }

  app.put('/api/groups/:id', (req, res) => {
    const group = findOr404(store.groups, req.params.id, 'Group');
    const b = req.body || {};
    if (b.name !== undefined) {
      if (!String(b.name).trim()) throw new HttpError(400, 'Name is required');
      group.name = String(b.name).trim();
    }
    if (b.defaultPlaylistId !== undefined) group.defaultPlaylistId = b.defaultPlaylistId || null;
    if (b.schedule !== undefined) group.schedule = cleanSchedule(b.schedule);
    if (Array.isArray(b.screenIds)) setMembers(group, b.screenIds);
    changed();
    res.json(group);
  });

  app.delete('/api/groups/:id', (req, res) => {
    const group = findOr404(store.groups, req.params.id, 'Group');
    store.data.groups = store.groups.filter((g) => g !== group);
    for (const s of store.screens) s.groupIds = s.groupIds.filter((g) => g !== group.id);
    for (const e of store.schedules) e.targets.groupIds = e.targets.groupIds.filter((x) => x !== group.id);
    changed();
    res.json({ ok: true });
  });

  app.post('/api/groups/:id/command', (req, res) => {
    const group = findOr404(store.groups, req.params.id, 'Group');
    if (!COMMANDS.includes(req.body?.command)) throw new HttpError(400, `command must be one of ${COMMANDS.join(', ')}`);
    let delivered = 0;
    for (const s of store.screens) if (s.groupIds.includes(group.id)) delivered += hub.command(s.id, req.body.command);
    res.json({ delivered });
  });

  // Media
  const upload = multer({
    storage: multer.diskStorage({
      destination: mediaDir,
      filename: (req, file, cb) => cb(null, `${id()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES },
  });

  function mediaType(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('image/')) return 'image';
    if (file.mimetype.startsWith('video/')) return 'video';
    if (ext === '.pdf' || file.mimetype === 'application/pdf') return 'deck';
    if (OFFICE_EXTENSIONS.includes(ext)) return 'deck';
    return null;
  }

  app.get('/api/media', (req, res) => res.json(store.media));

  app.post('/api/media', upload.array('files', 50), (req, res) => {
    const created = [];
    const rejected = [];
    for (const file of req.files || []) {
      const type = mediaType(file);
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      if (!type) {
        fs.rmSync(file.path, { force: true });
        rejected.push({ name, reason: 'Unsupported file type' });
        continue;
      }
      const isOffice = OFFICE_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase());
      if (type === 'deck' && !(isOffice ? converters.office : converters.pdf)) {
        fs.rmSync(file.path, { force: true });
        rejected.push({ name, reason: isOffice ? 'LibreOffice + poppler not installed on server' : 'poppler (pdftoppm) not installed on server' });
        continue;
      }
      const transcode = type === 'video' && converters.video;
      const media = {
        id: id(), name, type, mime: file.mimetype, size: file.size, file: file.filename,
        status: type === 'deck' || transcode ? 'processing' : 'ready', createdAt: new Date().toISOString(),
      };
      store.media.push(media);
      created.push(media);
      if (type === 'deck') {
        convertDeck(file.path, mediaDir, media.id)
          .then((pages) => { media.pages = pages; media.status = 'ready'; })
          .catch((err) => { media.status = 'error'; media.error = err.message; log(`[signage] deck conversion failed: ${err.message}`); })
          .finally(changed);
      }
      if (transcode) {
        transcodeVideo(file.path, mediaDir, media.id)
          .then((out) => {
            Object.assign(media, { file: out.file, poster: out.poster, codecs: out.codecs, duration: out.duration, size: out.size, mime: 'video/mp4', stream: true, status: 'ready' });
            if (out.file !== file.filename) fs.rmSync(file.path, { force: true });
          })
          .catch((err) => {
            media.status = 'error';
            media.error = 'This video could not be converted';
            log(`[signage] video conversion failed for ${name}: ${err.message}`);
          })
          .finally(changed);
      }
    }
    store.save();
    res.status(201).json({ created, rejected });
  });

  app.patch('/api/media/:id', (req, res) => {
    const media = findOr404(store.media, req.params.id, 'Media');
    if (typeof req.body?.name === 'string' && req.body.name.trim()) media.name = req.body.name.trim();
    store.save();
    res.json(media);
  });

  app.delete('/api/media/:id', (req, res) => {
    const media = findOr404(store.media, req.params.id, 'Media');
    store.data.media = store.media.filter((m) => m !== media);
    for (const pl of store.playlists) pl.items = pl.items.filter((it) => it.mediaId !== media.id);
    for (const rel of [media.file, media.poster, ...(media.pages || [])].filter(Boolean)) {
      files.forget(rel);
      fs.rmSync(path.join(mediaDir, rel), { force: true });
    }
    if (media.type === 'deck') fs.rmSync(path.join(mediaDir, `deck-${media.id}`), { recursive: true, force: true });
    changed();
    res.json({ ok: true });
  });

  // Live TV channels: stored as media of type "stream", so playlists, the
  // schedule and Play now treat them like any other media.
  const channelFields = (b, existing = {}) => {
    const url = b.url !== undefined ? cleanStreamUrl(b.url) : existing.url;
    if (!url) throw new HttpError(400, 'Enter a stream address starting with http:// or https://');
    const name = String(b.name ?? existing.name ?? '').trim() || url.split('/').pop() || 'Channel';
    return {
      name: name.slice(0, 120), url,
      logo: b.logo !== undefined ? cleanStreamUrl(b.logo) || '' : existing.logo || '',
      group: String(b.group ?? existing.group ?? '').trim().slice(0, 80),
      relay: (b.relay ?? existing.relay) === 'always' ? 'always' : 'auto',
      format: streamFormat(url),
    };
  };
  const newChannel = (fields) => ({ id: id(), type: 'stream', status: 'ready', size: 0, ...fields, createdAt: new Date().toISOString() });

  app.post('/api/channels', (req, res) => {
    const channel = newChannel(channelFields(req.body || {}));
    store.media.push(channel);
    store.save();
    res.status(201).json(channel);
  });

  app.put('/api/channels/:id', (req, res) => {
    const channel = findOr404(store.media.filter((m) => m.type === 'stream'), req.params.id, 'Channel');
    Object.assign(channel, channelFields(req.body || {}, channel));
    changed();
    res.json(channel);
  });

  // Adds the channels of an IPTV list (.m3u), from a link or pasted text.
  app.post('/api/channels/import', async (req, res) => {
    const b = req.body || {};
    let text = typeof b.text === 'string' ? b.text : '';
    if (!text && b.url) {
      const url = cleanStreamUrl(b.url);
      if (!url) throw new HttpError(400, 'Enter a link starting with http:// or https://');
      let r;
      try { r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) }); } catch (err) { throw new HttpError(502, `Could not download the list: ${err.message}`); }
      if (!r.ok) throw new HttpError(502, `Could not download the list (HTTP ${r.status})`);
      text = await r.text();
    }
    const found = parseM3u(text);
    if (!found.length) throw new HttpError(400, 'No channels found. An IPTV list starts with #EXTM3U and has one stream link per channel.');
    if (b.preview) {
      // Lets the console show the list's groups before importing.
      const counts = new Map();
      for (const ch of found) counts.set(ch.group, (counts.get(ch.group) || 0) + 1);
      return res.json({ total: found.length, groups: [...counts].map(([name, count]) => ({ name, count })) });
    }
    const groups = Array.isArray(b.groups) && b.groups.length ? new Set(b.groups) : null;
    const known = new Set(store.media.filter((m) => m.type === 'stream').map((m) => m.url));
    const created = [];
    for (const ch of found) {
      if (groups && !groups.has(ch.group)) continue;
      if (known.has(ch.url)) continue;
      if (created.length >= MAX_CHANNELS_PER_IMPORT) break;
      known.add(ch.url);
      created.push(newChannel(channelFields({ ...ch, group: b.group || ch.group })));
    }
    store.media.push(...created);
    store.save();
    res.status(201).json({ created: created.length, skipped: found.length - created.length });
  });

  // For the console's preview of a channel the browser can't open directly.
  app.get('/api/channels/:id/relay', (req, res) => {
    const channel = findOr404(store.media.filter((m) => m.type === 'stream'), req.params.id, 'Channel');
    res.json({ relay: relay.relayUrl(channel.id, channel.url) });
  });

  app.post('/api/channels/delete', (req, res) => {
    const ids = new Set(Array.isArray(req.body?.ids) ? req.body.ids : []);
    const gone = store.media.filter((m) => m.type === 'stream' && ids.has(m.id));
    const goneIds = new Set(gone.map((m) => m.id));
    store.data.media = store.media.filter((m) => !goneIds.has(m.id));
    for (const pl of store.playlists) pl.items = pl.items.filter((it) => !goneIds.has(it.mediaId));
    changed();
    res.json({ deleted: gone.length });
  });

  // Playlists
  function cleanItems(items = []) {
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be an array');
    return items
      .filter((it) => store.media.some((m) => m.id === it.mediaId))
      .map((it) => ({ id: it.id || id(), mediaId: it.mediaId, duration: Math.max(0, Number(it.duration) || 0), muted: it.muted !== false }));
  }

  app.get('/api/playlists', (req, res) => res.json(store.playlists));

  app.post('/api/playlists', (req, res) => {
    const b = req.body || {};
    if (!b.name?.trim()) throw new HttpError(400, 'Name is required');
    const playlist = { id: id(), name: b.name.trim(), defaultDuration: Math.max(1, Number(b.defaultDuration) || 10), items: cleanItems(b.items), overlay: cleanOverlay(b.overlay, store) };
    store.playlists.push(playlist);
    changed();
    res.status(201).json(playlist);
  });

  app.put('/api/playlists/:id', (req, res) => {
    const playlist = findOr404(store.playlists, req.params.id, 'Playlist');
    const b = req.body || {};
    if (b.name !== undefined) {
      if (!String(b.name).trim()) throw new HttpError(400, 'Name is required');
      playlist.name = String(b.name).trim();
    }
    if (b.defaultDuration !== undefined) playlist.defaultDuration = Math.max(1, Number(b.defaultDuration) || 10);
    if (b.items !== undefined) playlist.items = cleanItems(b.items);
    if (b.overlay !== undefined) playlist.overlay = cleanOverlay(b.overlay, store);
    changed();
    res.json(playlist);
  });

  app.delete('/api/playlists/:id', (req, res) => {
    const playlist = findOr404(store.playlists, req.params.id, 'Playlist');
    store.data.playlists = store.playlists.filter((p) => p !== playlist);
    for (const s of [...store.screens, ...store.groups]) {
      if (s.defaultPlaylistId === playlist.id) s.defaultPlaylistId = null;
      s.schedule = (s.schedule || []).filter((r) => r.playlistId !== playlist.id);
    }
    store.data.schedules = store.schedules.filter((e) => e.playlistId !== playlist.id);
    for (const s of store.screens) if (s.override?.playlistId === playlist.id) s.override = null;
    changed();
    res.json({ ok: true });
  });

  // ---- Schedule: content aimed at any mix of screens and groups ----
  // Content is either an existing playlist or media picked directly; the latter
  // is kept as a hidden playlist owned by the entry.
  function scheduleView(e) {
    const pl = store.playlists.find((p) => p.id === e.playlistId);
    return {
      ...e,
      content: pl?.hidden
        ? { type: 'media', items: pl.items, seconds: pl.defaultDuration, name: pl.name }
        : { type: 'playlist', playlistId: e.playlistId, name: pl?.name || null },
    };
  }

  function cleanEntry(b, existing = null) {
    const targets = {
      screenIds: [...new Set(Array.isArray(b.targets?.screenIds) ? b.targets.screenIds : [])].filter((sid) => store.screens.some((x) => x.id === sid)),
      groupIds: [...new Set(Array.isArray(b.targets?.groupIds) ? b.targets.groupIds : [])].filter((gid) => store.groups.some((g) => g.id === gid)),
    };
    if (!targets.screenIds.length && !targets.groupIds.length) throw new HttpError(400, 'Choose at least one screen or group');
    const entryId = existing?.id || id();
    const owned = existing && store.playlists.find((p) => p.id === existing.playlistId && p.hidden);
    let playlistId;
    if (b.content?.type === 'media') {
      const items = cleanItems(b.content.items);
      if (!items.length) throw new HttpError(400, 'Pick at least one media item');
      const pl = owned || { id: id(), hidden: true, scheduleId: entryId, items: [] };
      Object.assign(pl, { name: String(b.name || '').trim() || 'Scheduled media', defaultDuration: Math.max(1, Number(b.content.seconds) || 10), items });
      if (!owned) store.playlists.push(pl);
      playlistId = pl.id;
    } else {
      const pl = store.playlists.find((p) => p.id === b.content?.playlistId && !p.hidden);
      if (!pl) throw new HttpError(400, 'Choose a playlist');
      if (owned) store.data.playlists = store.playlists.filter((p) => p !== owned);
      playlistId = pl.id;
    }
    const [timing] = cleanSchedule([{ ...b, playlistId, id: entryId }]);
    const name = String(b.name || '').trim() || store.playlists.find((p) => p.id === playlistId)?.name || 'Scheduled content';
    return { ...timing, name: name.slice(0, 80), targets, createdAt: existing?.createdAt || new Date().toISOString() };
  }

  app.get('/api/schedules', (req, res) => res.json(store.schedules.map(scheduleView)));

  app.post('/api/schedules', (req, res) => {
    const entry = cleanEntry(req.body || {});
    store.schedules.push(entry);
    changed();
    res.status(201).json(scheduleView(entry));
  });

  app.put('/api/schedules/:id', (req, res) => {
    const entry = findOr404(store.schedules, req.params.id, 'Schedule');
    Object.assign(entry, cleanEntry({ ...scheduleView(entry), ...req.body }, entry));
    changed();
    res.json(scheduleView(entry));
  });

  app.delete('/api/schedules/:id', (req, res) => {
    const entry = findOr404(store.schedules, req.params.id, 'Schedule');
    store.data.schedules = store.schedules.filter((e) => e !== entry);
    store.data.playlists = store.playlists.filter((p) => !(p.hidden && p.id === entry.playlistId));
    changed();
    res.json({ ok: true });
  });

  // Week view: what a screen (or a typical member of a group) will show, per day.
  app.get('/api/schedule/week', (req, res) => {
    let subject;
    if (req.query.screenId) subject = findOr404(store.screens, req.query.screenId, 'Screen');
    else if (req.query.groupId) {
      const group = findOr404(store.groups, req.query.groupId, 'Group');
      subject = { id: `group:${group.id}`, timezone: DEFAULT_TIMEZONE, groupIds: [group.id], defaultPlaylistId: null, schedule: [] };
    } else throw new HttpError(400, 'screenId or groupId required');
    const now = Date.now();
    const dayStarts = localMidnights(subject.timezone || DEFAULT_TIMEZONE, now, 7);
    const { segments } = scheduleTimeline(subject, store, dayStarts[0] - 86400_000, 9);
    const end = dayStarts[dayStarts.length - 1];
    const names = new Map(store.playlists.map((p) => [p.id, p.name]));
    const entries = new Map(store.schedules.map((e) => [e.id, e.name]));
    const blocks = [];
    segments.forEach((seg, i) => {
      const from = Math.max(seg.from, dayStarts[0]);
      const to = Math.min(segments[i + 1]?.from ?? end, end);
      if (to <= from) return;
      blocks.push({
        from, to, playlistId: seg.playlistId, playlistName: names.get(seg.playlistId) || null,
        scheduleId: seg.ruleId, scheduleName: seg.ruleId === OVERRIDE_RULE_ID ? 'Play now' : seg.ruleId ? entries.get(seg.ruleId) || 'Rule' : null,
      });
    });
    res.json({ timezone: subject.timezone || DEFAULT_TIMEZONE, now, dayStarts, blocks, defaultPlaylistId: defaultPlaylistId(subject, store) });
  });

  // ---- Play now: put content on screens straight away, ahead of the schedule ----
  const playNowTargets = (t = {}) => {
    const ids = new Set(Array.isArray(t.screenIds) ? t.screenIds : []);
    const groupIds = new Set(Array.isArray(t.groupIds) ? t.groupIds : []);
    const list = store.screens.filter((x) => ids.has(x.id) || x.groupIds.some((g) => groupIds.has(g)));
    if (!list.length) throw new HttpError(400, 'Choose at least one screen or group');
    return list;
  };
  // Content picked directly gets a hidden playlist; dropped once no screen uses it.
  const dropUnusedPlayNow = () => {
    const used = new Set(store.screens.map((x) => x.override?.playlistId).filter(Boolean));
    store.data.playlists = store.playlists.filter((p) => !p.playNow || used.has(p.id));
  };

  app.post('/api/play-now', (req, res) => {
    const b = req.body || {};
    const screens = playNowTargets(b.targets);
    let playlistId;
    if (b.content?.type === 'media') {
      const items = cleanItems(b.content.items);
      if (!items.length) throw new HttpError(400, 'Pick something to play');
      const first = store.media.find((m) => m.id === items[0].mediaId);
      const pl = {
        id: id(), hidden: true, playNow: true, items,
        name: String(b.name || '').trim().slice(0, 80) || (items.length === 1 ? first.name : `${first.name} + ${items.length - 1} more`),
        defaultDuration: Math.max(1, Number(b.content.seconds) || 10),
      };
      store.playlists.push(pl);
      playlistId = pl.id;
    } else {
      const pl = store.playlists.find((p) => p.id === b.content?.playlistId && !p.hidden);
      if (!pl) throw new HttpError(400, 'Choose a playlist or a channel');
      playlistId = pl.id;
    }
    const minutes = Number(b.minutes) || 0;
    const from = Date.now();
    const until = b.until ? Number(new Date(b.until)) : minutes > 0 ? from + minutes * 60_000 : null;
    if (until !== null && !(until > from)) throw new HttpError(400, 'The end time must be in the future');
    for (const screen of screens) screen.override = { playlistId, from, until };
    dropUnusedPlayNow();
    changed();
    res.json({ screens: screens.map(screenView) });
  });

  app.post('/api/play-now/stop', (req, res) => {
    const screens = playNowTargets(req.body?.targets);
    for (const screen of screens) screen.override = null;
    dropUnusedPlayNow();
    changed();
    res.json({ screens: screens.map(screenView) });
  });

  // ---- Static UIs ----
  // The browser-preview player has no baked config; it reads the token from the URL.
  app.get('/player/config.js', (req, res) => res.type('js').send('// Browser preview: config comes from the URL hash.\n'));
  // no-cache: browsers must check for a newer player on every load.
  app.use('/player', express.static(path.join(ROOT, 'player'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.use('/admin', express.static(path.join(ROOT, 'admin')));
  app.get('/', (req, res) => res.redirect('/admin/'));

  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) log(`[signage] ${req.method} ${req.url}: ${err.stack || err}`);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  server = tls ? https.createServer(tls, app) : http.createServer(app);
  hub.attach(server);
  const stopMdns = mdns ? startMdns({ log }) : () => {};

  return {
    app, server, store, hub, keys,
    close: () => new Promise((resolve) => { stopMdns(); hub.close(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

// Landing page for screen PCs: http://<server>/addon/
function addonPage(settings, keys) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signage add-on</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1b1f27;background:#f4f5f7}
a.btn{display:block;background:#2f6fed;color:#fff;padding:12px 16px;border-radius:10px;text-decoration:none;margin:10px 0;font-weight:600}
a.btn small{display:block;font-weight:400;opacity:.85}code{background:#e3e6eb;padding:1px 5px;border-radius:4px}
.fp{font-family:ui-monospace,monospace;font-size:13px;color:#667085}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#e7e9ee}code{background:#2a2f38}}
</style></head><body>
<h1>Install the Signage player</h1>
<p>Server: <strong>${esc(settings.serverName)}</strong></p>
<a class="btn" href="screen-setup.zip">Windows screen PC installer<small>Add-on + kiosk start-up + automatic updates. Unzip, run setup-screen.bat.</small></a>
<a class="btn" href="signage-chrome.zip">Add-on for Chrome / Edge<small>Unzip, open chrome://extensions, turn on Developer mode, Load unpacked.</small></a>
<a class="btn" href="signage-linux-setup.sh">Raspberry Pi / Linux player<small>Copy to the device and run: sudo bash signage-linux-setup.sh</small></a>
<a class="btn" href="signage-firefox.zip">Add-on for Firefox (testing)<small>about:debugging → This Firefox → Load Temporary Add-on → manifest.json.</small></a>
<p>The player finds this server by itself and shows a pairing code. Enter it in the console under <strong>Screens → Pair a screen</strong>.</p>
<p class="fp">Server key fingerprint: ${esc(keys.fingerprint)}</p>
</body></html>`;
}
