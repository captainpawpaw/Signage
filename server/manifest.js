import crypto from 'node:crypto';
import { scheduleTimeline, playlistAt } from './schedule.js';
import { offlineNotice } from './offline.js';
import { relayPath, streamFormat } from './live.js';

export const DEFAULT_SETTINGS = {
  orientation: 'landscape', // landscape | portrait | landscape-flipped | portrait-flipped
  fit: 'contain',           // contain | cover
  background: '#000000',
  transition: 'fade',       // fade | none
  power: 'auto',            // auto (detect TV sticks) | low | standard
};

// The manifest is everything a player needs to render: the playlist that is on
// now, every playlist the schedule will switch to over the next days (with the
// timetable), and display settings. Items reference files by their path inside
// the media folder; forPlayer() turns that into plain URLs (previews) or
// encrypted file references (devices). `version` is a content hash, so players
// and the hub can cheaply detect change.
// A live channel set to 0 seconds plays continuously when it is the only item;
// next to other items it gets this long before the playlist moves on.
const LIVE_TURN_MS = 5 * 60_000;

function playlistItems(store, playlist) {
  const defaultSeconds = playlist.defaultDuration || 10;
  const items = [];
  const shared = (playlist.items || []).length > 1;
  for (const entry of playlist.items || []) {
    const media = store.media.find((m) => m.id === entry.mediaId);
    if (!media || media.status !== 'ready') continue;
    const seconds = Number(entry.duration) || 0;
    if (media.type === 'image') {
      items.push({ id: entry.id, type: 'image', file: media.file, mime: media.mime, duration: (seconds || defaultSeconds) * 1000 });
    } else if (media.type === 'deck') {
      media.pages.forEach((page, i) => {
        items.push({ id: `${entry.id}:${i}`, type: 'image', file: page, mime: 'image/png', duration: (seconds || defaultSeconds) * 1000 });
      });
    } else if (media.type === 'video') {
      // duration 0 = play to the end of the clip.
      items.push({
        id: entry.id, type: 'video', file: media.file, mime: media.stream ? 'video/mp4' : media.mime, size: media.size,
        duration: seconds * 1000, muted: entry.muted !== false,
        ...(media.stream ? { stream: true, codecs: media.codecs } : {}),
      });
    } else if (media.type === 'stream') {
      // Played from the source; the relay is the fallback (or the only way, if set).
      items.push({
        id: entry.id, type: 'live', name: media.name, url: media.url, format: streamFormat(media.url),
        relay: relayPath(store.settings.relaySecret, media.id, media.url), relayOnly: media.relay === 'always',
        duration: seconds ? seconds * 1000 : shared ? LIVE_TURN_MS : 0, muted: entry.muted !== false,
      });
    }
  }
  return items;
}

// Ticker and logo shown on top of a playlist.
function playlistOverlay(store, playlist) {
  const o = playlist.overlay;
  if (!o) return null;
  const out = {};
  if (o.ticker?.text) out.ticker = o.ticker;
  const logo = o.logo && store.media.find((m) => m.id === o.logo.mediaId && m.type === 'image' && m.status === 'ready');
  if (logo) out.logo = { corner: o.logo.corner, size: o.logo.size, image: { id: `logo:${logo.id}`, type: 'image', file: logo.file, mime: logo.mime } };
  return out.ticker || out.logo ? out : null;
}

export function buildManifest(store, screen, now = new Date()) {
  const timeline = scheduleTimeline(screen, store, now.getTime());
  const currentId = playlistAt(timeline, now.getTime());
  const playlists = {};
  for (const id of new Set([currentId, ...timeline.segments.map((s) => s.playlistId)])) {
    const playlist = id && store.playlists.find((p) => p.id === id);
    if (playlist) {
      const overlay = playlistOverlay(store, playlist);
      playlists[id] = { id, name: playlist.name, items: playlistItems(store, playlist), ...(overlay ? { overlay } : {}) };
    }
  }
  const current = playlists[currentId] || null;

  const body = {
    screen: { id: screen.id, name: screen.name },
    playlist: current ? { id: current.id, name: current.name } : null,
    settings: { ...DEFAULT_SETTINGS, ...screen.settings },
    offline: offlineNotice(store.settings, screen),
    // Players switch by themselves at these times, even while offline.
    timeline: timeline.segments
      .map((seg) => ({ from: seg.from, playlistId: playlists[seg.playlistId] ? seg.playlistId : null }))
      .filter((seg, i, all) => i === 0 || seg.playlistId !== all[i - 1].playlistId),
    timelineEnd: timeline.end,
    playlists,
    items: current?.items || [], // the playlist on now (also for players before 2.2)
  };
  const version = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { version, ...body };
}

// Shapes a manifest for one connection.
//   plain:  items get a /files/ URL (token added by the player)
//   device: items get { f, n, size, salt, k, kiv }: file id, chunk count and the
//           file key wrapped for that one device.
export function forPlayer(manifest, mode, { fileEntry, wrap } = {}) {
  const one = (item) => {
    if (item.type === 'live') return item; // not a file: streamed from its source
    const { file, ...rest } = item;
    if (mode === 'plain') return { ...rest, url: `/files/${file}` };
    const entry = fileEntry(file);
    if (!entry) return null;
    return { ...rest, enc: { f: entry.id, size: entry.size, n: entry.chunks, salt: entry.salt, ...wrap(entry) } };
  };
  const shape = (items) => items.map(one).filter(Boolean);
  const overlay = (o) => {
    if (!o?.logo) return o;
    const image = one(o.logo.image);
    return image ? { ...o, logo: { ...o.logo, image } } : (o.ticker ? { ticker: o.ticker } : undefined);
  };
  const playlists = Object.fromEntries(Object.entries(manifest.playlists || {}).map(([id, p]) => [id, { ...p, items: shape(p.items), overlay: overlay(p.overlay) }]));
  return { ...manifest, playlists, items: shape(manifest.items) };
}
