import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { parseM3u, streamFormat } from '../server/live.js';
import { scheduleTimeline, playlistAt } from '../server/schedule.js';
import { forPlayer } from '../server/manifest.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let ctx, base, cookie, upstream, upstreamBase;
const upstreamHits = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-live-'));

async function call(method, url, body) {
  const opts = { method, headers: { cookie } };
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(base + url, opts);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

before(async () => {
  // A stand-in IPTV source: a live HLS playlist with relative segments and a key,
  // a master playlist on another path, and a channel list.
  upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url);
    if (req.url === '/live/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n');
    }
    if (req.url === '/live/low/index.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="../keys/k1"\n#EXTINF:2,\nseg1.ts\n#EXTINF:2,\nhttp://cdn.invalid/seg2.ts\n');
    }
    if (req.url === '/live/low/seg1.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(Buffer.alloc(188, 0x47)); }
    if (req.url === '/channels.m3u') {
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
      return res.end([
        '#EXTM3U',
        `#EXTINF:-1 tvg-id="news" tvg-logo="${upstreamBase}/logo.png" group-title="News",News 24`,
        `${upstreamBase}/live/master.m3u8`,
        '#EXTINF:-1 group-title="Sport",Sport One',
        'http://iptv.example:8080/user/pass/1234',
        '#EXTINF:-1 group-title="Sport",Sport Two',
        'http://iptv.example:8080/user/pass/1235.ts',
      ].join('\n'));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  ctx = await createApp({ dataDir, adminPassword: 'test-password', mdns: false, log: () => {} });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  await ctx.close();
  upstream.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('M3U lists and stream formats', () => {
  const list = parseM3u('#EXTM3U\r\n#EXTINF:-1 tvg-name="X" tvg-logo="https://l/x.png" group-title="Kids, Family",Cartoons, 24/7\r\nhttps://s/x.m3u8\r\n#EXTINF:0,Radio\r\n#EXTGRP:Music\r\nhttps://s/radio.mp3\r\nnot a url\r\n');
  assert.deepEqual(list, [
    { name: 'Cartoons, 24/7', logo: 'https://l/x.png', group: 'Kids, Family', url: 'https://s/x.m3u8' },
    { name: 'Radio', logo: '', group: 'Music', url: 'https://s/radio.mp3' },
  ]);
  assert.equal(streamFormat('https://a/b/index.m3u8?token=1'), 'hls');
  assert.equal(streamFormat('http://iptv:8080/user/pass/1234'), 'ts');
  assert.equal(streamFormat('http://iptv:8080/live/user/pass/1234.ts'), 'ts');
  assert.equal(streamFormat('https://a/clip.mp4'), 'file');
});

test('channels: add, import a list by link with groups, no duplicates, delete', async () => {
  assert.equal((await call('POST', '/api/channels', { url: 'ftp://nope' })).status, 400);
  const added = (await call('POST', '/api/channels', { name: 'Lobby cam', url: 'https://cam.example/live.m3u8', relay: 'always' })).body;
  assert.equal(added.type, 'stream');
  assert.equal(added.format, 'hls');
  assert.equal(added.relay, 'always');

  const preview = (await call('POST', '/api/channels/import', { url: `${upstreamBase}/channels.m3u`, preview: true })).body;
  assert.equal(preview.total, 3);
  assert.deepEqual(preview.groups, [{ name: 'News', count: 1 }, { name: 'Sport', count: 2 }]);
  const media = () => call('GET', '/api/media').then((r) => r.body.filter((m) => m.type === 'stream'));
  assert.equal((await media()).length, 1, 'a preview imports nothing');

  const news = (await call('POST', '/api/channels/import', { url: `${upstreamBase}/channels.m3u`, groups: ['News'] })).body;
  assert.deepEqual(news, { created: 1, skipped: 2 });
  const again = (await call('POST', '/api/channels/import', { url: `${upstreamBase}/channels.m3u` })).body;
  assert.deepEqual(again, { created: 2, skipped: 1 }, 'channels already added are skipped');
  const all = await media();
  assert.equal(all.length, 4);
  const sport = all.find((m) => m.name === 'Sport One');
  assert.equal(sport.format, 'ts');
  assert.equal(sport.group, 'Sport');
  assert.equal(all.find((m) => m.name === 'News 24').logo, `${upstreamBase}/logo.png`);

  const edited = (await call('PUT', `/api/channels/${sport.id}`, { name: 'Sport 1 HD' })).body;
  assert.equal(edited.name, 'Sport 1 HD');
  assert.equal(edited.url, sport.url);

  const pl = (await call('POST', '/api/playlists', { name: 'Sports bar', items: [{ mediaId: sport.id }] })).body;
  const gone = all.filter((m) => m.group === 'Sport').map((m) => m.id);
  assert.deepEqual((await call('POST', '/api/channels/delete', { ids: gone })).body, { deleted: 2 });
  assert.equal((await media()).length, 2);
  assert.deepEqual((await call('GET', '/api/playlists')).body.find((p) => p.id === pl.id).items, [], 'deleted channels leave playlists');
  assert.equal((await call('POST', '/api/channels/import', { text: 'hello' })).status, 400);
});

test('screens get channels as live items, with a relay that only serves what it handed out', async () => {
  const news = (await call('GET', '/api/media')).body.find((m) => m.name === 'News 24');
  const logoFd = new FormData();
  logoFd.append('files', new Blob([PNG], { type: 'image/png' }), 'logo.png');
  const logo = (await call('POST', '/api/media', logoFd)).body.created[0];

  const tv = (await call('POST', '/api/playlists', {
    name: 'Reception TV', items: [{ mediaId: news.id, muted: false }],
    overlay: { ticker: { text: 'Welcome\nFree Wi-Fi: Guest', speed: 'fast', color: 'red' }, logo: { mediaId: logo.id, corner: 'nowhere', size: 99 } },
  })).body;
  assert.deepEqual(tv.overlay, {
    ticker: { text: 'Welcome\nFree Wi-Fi: Guest', position: 'bottom', speed: 'fast', size: 'medium', color: '#ffffff', background: '#000000cc' },
    logo: { mediaId: logo.id, corner: 'top-right', size: 40 },
  });
  const screen = (await call('POST', '/api/screens', { name: 'Reception', defaultPlaylistId: tv.id })).body;
  const manifest = (await call('GET', `/api/screens/${screen.id}/manifest`)).body;
  const [item] = manifest.playlists[tv.id].items;
  assert.equal(item.type, 'live');
  assert.equal(item.url, news.url);
  assert.equal(item.format, 'hls');
  assert.equal(item.duration, 0, 'the only item plays non-stop');
  assert.equal(item.muted, false);
  assert.match(item.relay, /^\/live\/[\w-]+\/[\w-]{32}\?u=/);
  assert.equal(manifest.playlists[tv.id].overlay.logo.image.file, logo.file);

  // Devices get the live item unchanged and the logo as an encrypted file.
  const shaped = forPlayer(manifest, 'device', { fileEntry: () => ({ id: 'f1', size: 1, chunks: 1, salt: 's' }), wrap: () => ({ k: 'k', kiv: 'i' }) });
  assert.deepEqual(shaped.playlists[tv.id].items[0], item);
  assert.equal(shaped.playlists[tv.id].overlay.logo.image.enc.f, 'f1');

  // Next to other items a channel takes turns (5 minutes unless set).
  await call('PUT', `/api/playlists/${tv.id}`, { items: [{ mediaId: news.id }, { mediaId: logo.id }] });
  const turns = (await call('GET', `/api/screens/${screen.id}/manifest`)).body.playlists[tv.id].items;
  assert.equal(turns[0].duration, 300_000);
  assert.equal(turns[0].muted, true);

  // The relay: master playlist → rewritten variant → rewritten segments and key.
  const master = await fetch(base + item.relay);
  assert.equal(master.status, 200);
  assert.equal(master.headers.get('access-control-allow-origin'), '*');
  const variantPath = (await master.text()).split('\n').find((l) => l.startsWith('/live/'));
  assert.ok(variantPath, 'variant playlist is relayed');
  const variant = await (await fetch(base + variantPath)).text();
  const lines = variant.split('\n');
  assert.match(lines.find((l) => l.startsWith('#EXT-X-KEY')), /URI="\/live\/.+u=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Flive%2Fkeys%2Fk1"/);
  const segPath = lines.find((l) => l.startsWith('/live/') && l.includes('seg1'));
  assert.ok(lines.some((l) => l.includes('cdn.invalid%2Fseg2.ts')), 'absolute links are relayed too');
  const seg = await fetch(base + segPath);
  assert.equal(seg.status, 200);
  assert.equal(Buffer.from(await seg.arrayBuffer())[0], 0x47);
  const hits = upstreamHits.filter((u) => u === '/live/low/seg1.ts').length;
  await fetch(base + segPath);
  assert.equal(upstreamHits.filter((u) => u === '/live/low/seg1.ts').length, hits, 'screens on one channel share the download');

  // Anything not handed out by the server is refused.
  const forged = item.relay.replace(/u=.*/, `u=${encodeURIComponent('http://169.254.169.254/')}`);
  assert.equal((await fetch(base + forged)).status, 403);
  assert.equal((await fetch(`${base}/live/${news.id}/x?u=${encodeURIComponent(news.url)}`)).status, 403);
});

test('play now: a channel on a group of screens until a set time, then back to the schedule', async () => {
  const media = (await call('GET', '/api/media')).body;
  const news = media.find((m) => m.name === 'News 24');
  const usual = (await call('POST', '/api/playlists', { name: 'Usual', items: [{ mediaId: media.find((m) => m.type === 'image').id }] })).body;
  const group = (await call('POST', '/api/groups', { name: 'Bar', defaultPlaylistId: usual.id })).body;
  const a = (await call('POST', '/api/screens', { name: 'Bar A', groupIds: [group.id] })).body;
  const b = (await call('POST', '/api/screens', { name: 'Bar B', groupIds: [group.id] })).body;
  assert.equal(a.activePlaylistId, usual.id);

  assert.equal((await call('POST', '/api/play-now', { targets: {}, content: { type: 'playlist', playlistId: usual.id } })).status, 400);
  assert.equal((await call('POST', '/api/play-now', { targets: { groupIds: [group.id] }, content: { type: 'media', items: [] } })).status, 400);
  const started = Date.now();
  const res = (await call('POST', '/api/play-now', { targets: { groupIds: [group.id] }, content: { type: 'media', items: [{ mediaId: news.id, muted: false }] }, minutes: 30 })).body;
  assert.equal(res.screens.length, 2);
  const [pa] = res.screens;
  assert.equal(pa.playNow.name, 'News 24');
  assert.ok(Math.abs(pa.playNow.until - (started + 30 * 60_000)) < 5000);
  assert.equal(pa.activeRuleId, 'play-now');
  const pnId = pa.activePlaylistId;
  assert.notEqual(pnId, usual.id);

  // Players get the switch back in their timetable, so it also happens offline.
  const manifest = (await call('GET', `/api/screens/${b.id}/manifest`)).body;
  assert.equal(manifest.playlist.id, pnId);
  assert.equal(manifest.playlists[pnId].items[0].type, 'live');
  const back = manifest.timeline.find((seg) => seg.from > started && seg.playlistId === usual.id);
  assert.ok(back && Math.abs(back.from - (started + 30 * 60_000)) < 5000, 'returns to the schedule after 30 minutes');

  const week = (await call('GET', `/api/schedule/week?screenId=${a.id}`)).body;
  assert.ok(week.blocks.some((blk) => blk.scheduleName === 'Play now'));

  // Stopping one screen keeps the other on; the hidden playlist goes once unused.
  await call('POST', '/api/play-now/stop', { targets: { screenIds: [a.id] } });
  const screens = (await call('GET', '/api/screens')).body;
  assert.equal(screens.find((x) => x.id === a.id).activePlaylistId, usual.id);
  assert.equal(screens.find((x) => x.id === a.id).playNow, null);
  assert.equal(screens.find((x) => x.id === b.id).activePlaylistId, pnId);
  await call('POST', '/api/play-now', { targets: { screenIds: [b.id] }, content: { type: 'playlist', playlistId: usual.id } });
  const after = (await call('GET', '/api/playlists')).body;
  assert.ok(!after.some((p) => p.id === pnId), 'unused Play now playlists are removed');
  assert.equal((await call('GET', `/api/screens/${b.id}`)).body.playNow.until, null, 'without a time it runs until stopped');
});

test('play now in the timetable: covers the window, resumes what was scheduled', () => {
  const day = 86400_000;
  const now = Date.UTC(2026, 9, 21, 10, 0);
  const screen = { timezone: 'UTC', defaultPlaylistId: 'base', override: { playlistId: 'tv', from: now, until: now + 3600_000 } };
  const ctx = { groups: [], schedules: [{ id: 'lunch', playlistId: 'lunch', start: '10:30', end: '12:00', days: [], enabled: true, targets: { screenIds: [], groupIds: [] } }] };
  screen.id = 's';
  ctx.schedules[0].targets.screenIds = ['s'];
  const tl = scheduleTimeline(screen, ctx, now);
  assert.equal(playlistAt(tl, now - 60_000), 'base');
  assert.equal(playlistAt(tl, now), 'tv');
  assert.equal(playlistAt(tl, now + 45 * 60_000), 'tv', 'beats the lunch rule');
  assert.equal(playlistAt(tl, now + 61 * 60_000), 'lunch', 'resumes the rule that is on by then');
  assert.equal(playlistAt(tl, now + 2.5 * 3600_000), 'base');
  assert.equal(playlistAt(tl, now + day + 45 * 60_000), 'lunch', 'tomorrow is untouched');
  const expired = scheduleTimeline({ ...screen, override: { playlistId: 'tv', from: now - 7200_000, until: now - 3600_000 } }, ctx, now + day);
  assert.ok(!expired.segments.some((seg) => seg.playlistId === 'tv'));
});
