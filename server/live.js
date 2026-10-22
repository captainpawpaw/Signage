// Live TV channels (IPTV): stream URLs played straight from the source by the
// screens, plus a relay through this server for streams a browser can't open
// itself (no CORS headers, plain http under an https page). The relay only
// fetches URLs it handed out: every relayed URL carries an HMAC of the channel
// and the upstream address.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Player libraries for live streams, shipped with every player (add-on, Linux,
// previews): HLS (.m3u8) and MPEG-TS over HTTP (common in IPTV channel lists).
export const PLAYER_VENDOR = {
  'hls.min.js': path.join(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js'),
  'mpegts.js': path.join(ROOT, 'node_modules', 'mpegts.js', 'dist', 'mpegts.js'),
};
export const vendorFile = (name) => fs.readFileSync(PLAYER_VENDOR[name]);

// How a player should open a stream. Bare "http://host/user/pass/123" links in
// IPTV lists are MPEG-TS.
export function streamFormat(url) {
  const p = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  if (p.endsWith('.m3u8') || p.endsWith('.m3u')) return 'hls';
  if (/\.(mp4|m4v|webm|ogv|mov|mp3|aac|m4a|ogg|opus)$/.test(p)) return 'file';
  if (p.endsWith('.ts') || !/\.[a-z0-9]{2,4}$/.test(p)) return 'ts';
  return 'file';
}

export function cleanStreamUrl(url) {
  const s = String(url || '').trim();
  let u;
  try { u = new URL(s); } catch { return null; }
  return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
}

// ---------- M3U channel lists ----------
// #EXTM3U
// #EXTINF:-1 tvg-id="bbc1" tvg-logo="http://…/bbc1.png" group-title="UK",BBC One
// http://…/bbc1.m3u8
export function parseM3u(text) {
  const out = [];
  let pending = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',', line.lastIndexOf('"') + 1 || line.indexOf(':'));
      const attrs = Object.fromEntries([...line.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
      pending = {
        name: (comma >= 0 ? line.slice(comma + 1) : '').trim() || attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '',
      };
    } else if (line.startsWith('#EXTGRP:') && pending) {
      pending.group ||= line.slice(8).trim();
    } else if (!line.startsWith('#')) {
      const url = cleanStreamUrl(line);
      if (url) out.push({ name: pending?.name || url.split('/').pop() || 'Channel', logo: cleanStreamUrl(pending?.logo) || '', group: pending?.group || '', url });
      pending = null;
    }
  }
  return out;
}

// ---------- relay ----------
const RELAY_CACHE_MAX = 256 * 1024 * 1024;
const RELAY_SEGMENT_TTL = 60_000;
const RELAY_PLAYLIST_TTL = 1_000;

const relaySig = (secret, channelId, url) => crypto.createHmac('sha256', secret).update(`${channelId}|${url}`).digest('base64url').slice(0, 32);
export const relayPath = (secret, channelId, url) => `/live/${channelId}/${relaySig(secret, channelId, url)}?u=${encodeURIComponent(url)}`;

export function createRelay(secret, { log = () => {} } = {}) {
  const sign = (channelId, url) => relaySig(secret, channelId, url);
  const relayUrl = (channelId, url) => relayPath(secret, channelId, url);

  // Several screens on one channel share what the server fetched.
  const cache = new Map(); // url -> { at, ttl, type, body }
  const inflight = new Map();
  let cacheBytes = 0;
  const remember = (url, entry) => {
    if (entry.body.length > 32 * 1024 * 1024) return;
    const drop = (k) => { cacheBytes -= cache.get(k).body.length; cache.delete(k); };
    if (cache.has(url)) drop(url);
    cache.set(url, entry);
    cacheBytes += entry.body.length;
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at >= v.ttl) drop(k);
    for (const k of cache.keys()) { if (cacheBytes <= RELAY_CACHE_MAX) break; drop(k); } // oldest first
  };

  const isPlaylist = (url, type, head) => /mpegurl/i.test(type || '') || /\.m3u8?(\?|$)/i.test(url) || head.startsWith('#EXTM3U');

  // Every address in an HLS playlist goes back through the relay.
  const rewrite = (channelId, text, base) => text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    const abs = (u) => { try { return new URL(u, base).href; } catch { return u; } };
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${relayUrl(channelId, abs(u))}"`);
    return relayUrl(channelId, abs(t));
  }).join('\n');

  async function fetchSmall(channelId, url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < hit.ttl) return hit;
    if (inflight.has(url)) return inflight.get(url);
    const job = (async () => {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'SignageRelay/1.0' } });
      if (!res.ok) throw Object.assign(new Error(`upstream HTTP ${res.status}`), { status: 502 });
      const body = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || 'application/octet-stream';
      const head = body.subarray(0, 16).toString('latin1');
      const entry = isPlaylist(res.url || url, type, head)
        ? { at: Date.now(), ttl: RELAY_PLAYLIST_TTL, type: 'application/vnd.apple.mpegurl', body: Buffer.from(rewrite(channelId, body.toString('utf8'), res.url || url)) }
        : { at: Date.now(), ttl: RELAY_SEGMENT_TTL, type, body };
      remember(url, entry);
      return entry;
    })().finally(() => inflight.delete(url));
    inflight.set(url, job);
    return job;
  }

  // GET /live/:channelId/:sig?u=<upstream>
  async function handle(req, res, channel) {
    const url = String(req.query.u || '');
    if (!channel || req.params.sig !== sign(channel.id, url)) return res.status(403).end();
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    try {
      // Continuous MPEG-TS streams never end: pass them straight through.
      if (streamFormat(url) === 'ts' && url === channel.url) {
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        const upstream = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': 'SignageRelay/1.0' } });
        if (!upstream.ok || !upstream.body) return res.status(502).end();
        res.set('Content-Type', upstream.headers.get('content-type') || 'video/mp2t');
        Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
        return;
      }
      const entry = await fetchSmall(channel.id, url);
      res.set('Content-Type', entry.type).send(entry.body);
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 502).end();
      log(`[signage] relay ${channel.name}: ${err.message}`);
    }
  }

  return { relayUrl, handle };
}
