import crypto from 'node:crypto';
import { resolvePlaylistId } from './schedule.js';

export const DEFAULT_SETTINGS = {
  orientation: 'landscape', // landscape | portrait | landscape-flipped | portrait-flipped
  fit: 'contain',           // contain | cover
  background: '#000000',
  transition: 'fade',       // fade | none
};

// The manifest is everything a player needs to render: resolved playlist,
// flattened items (decks expand to one item per page) and display settings.
// `version` is a content hash, so players and the hub can cheaply detect change.
export function buildManifest(store, screen, now = new Date()) {
  const playlistId = resolvePlaylistId(screen, now);
  const playlist = store.playlists.find((p) => p.id === playlistId) || null;
  const defaultSeconds = playlist?.defaultDuration || 10;
  const items = [];

  for (const entry of playlist?.items || []) {
    const media = store.media.find((m) => m.id === entry.mediaId);
    if (!media || media.status !== 'ready') continue;
    const seconds = Number(entry.duration) || 0;
    if (media.type === 'image') {
      items.push({ id: entry.id, type: 'image', url: `/files/${media.file}`, duration: (seconds || defaultSeconds) * 1000 });
    } else if (media.type === 'deck') {
      media.pages.forEach((page, i) => {
        items.push({ id: `${entry.id}:${i}`, type: 'image', url: `/files/${page}`, duration: (seconds || defaultSeconds) * 1000 });
      });
    } else if (media.type === 'video') {
      // duration 0 = play to the end of the clip.
      items.push({ id: entry.id, type: 'video', url: `/files/${media.file}`, duration: seconds * 1000, muted: entry.muted !== false });
    }
  }

  const body = {
    screen: { id: screen.id, name: screen.name },
    playlist: playlist ? { id: playlist.id, name: playlist.name } : null,
    settings: { ...DEFAULT_SETTINGS, ...screen.settings },
    items,
  };
  const version = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { version, ...body };
}
