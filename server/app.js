import express from 'express';
import multer from 'multer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Hub } from './realtime.js';
import { buildManifest, DEFAULT_SETTINGS } from './manifest.js';
import { activeRule, DEFAULT_TIMEZONE } from './schedule.js';
import { buildExtensionZip } from './extension.js';
import { convertDeck, converterSupport, OFFICE_EXTENSIONS } from './convert.js';
import {
  initAuth, checkPassword, setPassword, issueSession, clearSession,
  isAdmin, screenFromRequest, randomToken,
} from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const COMMANDS = ['reload', 'identify', 'next'];
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

function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export async function createApp({ dataDir = path.join(ROOT, 'data'), adminPassword, publicUrl, log = console.log } = {}) {
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const store = new Store(path.join(dataDir, 'db.json'));
  initAuth(store, { dataDir, adminPassword, log });
  const hub = new Hub(store, { log });
  const converters = await converterSupport();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '1mb' }));

  const screenView = (s) => ({
    ...pick(s, ['id', 'name', 'location', 'notes', 'timezone', 'serverUrl', 'defaultPlaylistId', 'schedule', 'lastSeen', 'createdAt']),
    settings: { ...DEFAULT_SETTINGS, ...s.settings },
    activePlaylistId: buildManifest(store, s).playlist?.id || null,
    activeRuleId: activeRule(s)?.id || null,
    status: hub.status(s.id),
  });
  const findOr404 = (list, itemId, what) => {
    const item = list.find((x) => x.id === itemId);
    if (!item) throw new HttpError(404, `${what} not found`);
    return item;
  };
  const changed = () => { store.save(); hub.refresh(); };

  // ---- Admin session ----
  app.post('/api/login', (req, res) => {
    if (!checkPassword(store, req.body?.password)) throw new HttpError(401, 'Wrong password');
    issueSession(store, res, req.secure);
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

  // ---- Player endpoints (authenticated with the screen token) ----
  app.get('/api/player/manifest', (req, res) => {
    const screen = screenFromRequest(store, req);
    if (!screen) throw new HttpError(401, 'Unknown screen token');
    res.set('Cache-Control', 'no-store').json(buildManifest(store, screen));
  });

  // Media files: readable by the admin UI or any registered screen.
  app.get('/files/*file', (req, res) => {
    if (!isAdmin(store, req) && !screenFromRequest(store, req)) throw new HttpError(401, 'Unauthorized');
    const rel = [].concat(req.params.file).join('/');
    const full = path.resolve(mediaDir, rel);
    if (!full.startsWith(mediaDir + path.sep)) throw new HttpError(400, 'Bad path');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  // ---- Everything else under /api requires the admin ----
  app.use('/api', (req, res, next) => (isAdmin(store, req) ? next() : next(new HttpError(401, 'Login required'))));

  app.get('/api/info', (req, res) => res.json({
    defaultTimezone: DEFAULT_TIMEZONE,
    publicUrl: publicUrl || null,
    converters,
    defaults: DEFAULT_SETTINGS,
    timezones: Intl.supportedValuesOf?.('timeZone') || [],
  }));

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
      token: randomToken(), tokenRevision: 0,
      timezone: validTimezone(b.timezone) ? b.timezone : DEFAULT_TIMEZONE,
      serverUrl: b.serverUrl || '', defaultPlaylistId: b.defaultPlaylistId || null,
      settings: cleanSettings(b.settings), schedule: cleanSchedule(b.schedule),
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
    changed();
    res.json(screenView(screen));
  });

  app.delete('/api/screens/:id', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    store.data.screens = store.screens.filter((s) => s !== screen);
    store.save();
    hub.disconnect(screen.id);
    res.json({ ok: true });
  });

  app.post('/api/screens/:id/regenerate-token', (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    screen.token = randomToken();
    screen.tokenRevision = (screen.tokenRevision || 0) + 1;
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
    res.json({ url: `/player/player.html#token=${encodeURIComponent(screen.token)}` });
  });

  app.get('/api/screens/:id/extension.zip', async (req, res) => {
    const screen = findOr404(store.screens, req.params.id, 'Screen');
    const serverUrl = String(req.query.serverUrl || screen.serverUrl || publicUrl || `${req.protocol}://${req.get('host')}`);
    let parsed;
    try { parsed = new URL(serverUrl); } catch { throw new HttpError(400, 'Invalid server URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'Server URL must be http(s)');
    const zip = await buildExtensionZip(screen, serverUrl);
    const slug = screen.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'screen';
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="signage-${slug}.zip"`);
    res.send(zip);
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
      const media = {
        id: id(), name, type, mime: file.mimetype, size: file.size, file: file.filename,
        status: type === 'deck' ? 'processing' : 'ready', createdAt: new Date().toISOString(),
      };
      store.media.push(media);
      created.push(media);
      if (type === 'deck') {
        convertDeck(file.path, mediaDir, media.id)
          .then((pages) => { media.pages = pages; media.status = 'ready'; })
          .catch((err) => { media.status = 'error'; media.error = err.message; log(`[signage] deck conversion failed: ${err.message}`); })
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
    fs.rmSync(path.join(mediaDir, media.file), { force: true });
    if (media.type === 'deck') fs.rmSync(path.join(mediaDir, `deck-${media.id}`), { recursive: true, force: true });
    changed();
    res.json({ ok: true });
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
    const playlist = { id: id(), name: b.name.trim(), defaultDuration: Math.max(1, Number(b.defaultDuration) || 10), items: cleanItems(b.items) };
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
    changed();
    res.json(playlist);
  });

  app.delete('/api/playlists/:id', (req, res) => {
    const playlist = findOr404(store.playlists, req.params.id, 'Playlist');
    store.data.playlists = store.playlists.filter((p) => p !== playlist);
    for (const s of store.screens) {
      if (s.defaultPlaylistId === playlist.id) s.defaultPlaylistId = null;
      s.schedule = (s.schedule || []).filter((r) => r.playlistId !== playlist.id);
    }
    changed();
    res.json({ ok: true });
  });

  // ---- Static UIs ----
  // The browser-preview player has no baked config; it reads the token from the URL.
  app.get('/player/config.js', (req, res) => res.type('js').send('// Browser preview: config comes from the URL hash.\n'));
  app.use('/player', express.static(path.join(ROOT, 'player')));
  app.use('/admin', express.static(path.join(ROOT, 'admin')));
  app.get('/', (req, res) => res.redirect('/admin/'));

  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) log(`[signage] ${req.method} ${req.url}: ${err.stack || err}`);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  const server = http.createServer(app);
  hub.attach(server);

  return {
    app, server, store, hub,
    close: () => new Promise((resolve) => { hub.close(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
