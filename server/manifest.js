import crypto from 'node:crypto';
import { resolvePlaylistId } from './schedule.js';
import { offlineNotice } from './offline.js';

export const DEFAULT_SETTINGS = {
  orientation: 'landscape', // landscape | portrait | landscape-flipped | portrait-flipped
  fit: 'contain',           // contain | cover
  background: '#000000',
  transition: 'fade',       // fade | none
  power: 'auto',            // auto (detect TV sticks) | low | standard
};

// The manifest is everything a player needs to render: resolved playlist,
// flattened items (decks expand to one item per page) and display settings.
// Items reference files by their path inside the media folder; forPlayer()
// turns that into plain URLs (previews) or encrypted file references (devices).
// `version` is a content hash, so players and the hub can cheaply detect change.
export function buildManifest(store, screen, now = new Date()) {
  const playlistId = resolvePlaylistId(screen, now, store.groups);
  const playlist = store.playlists.find((p) => p.id === playlistId) || null;
  const defaultSeconds = playlist?.defaultDuration || 10;
  const items = [];

  for (const entry of playlist?.items || []) {
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
    }
  }

  const body = {
    screen: { id: screen.id, name: screen.name },
    playlist: playlist ? { id: playlist.id, name: playlist.name } : null,
    settings: { ...DEFAULT_SETTINGS, ...screen.settings },
    offline: offlineNotice(store.settings, screen),
    items,
  };
  const version = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { version, ...body };
}

// Shapes a manifest for one connection.
//   plain:  items get a /files/ URL (token added by the player)
//   device: items get { f, n, size, salt, k, kiv }: file id, chunk count and the
//           file key wrapped for that one device.
export function forPlayer(manifest, mode, { fileEntry, wrap } = {}) {
  const items = manifest.items.map(({ file, ...item }) => {
    if (mode === 'plain') return { ...item, url: `/files/${file}` };
    const entry = fileEntry(file);
    if (!entry) return null;
    return { ...item, enc: { f: entry.id, size: entry.size, n: entry.chunks, salt: entry.salt, ...wrap(entry) } };
  }).filter(Boolean);
  return { ...manifest, items };
}
