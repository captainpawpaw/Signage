import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { forPlayer } from '../server/manifest.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let ctx, base, cookie;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-boards-'));

async function call(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (!url.startsWith('/edit/')) opts.headers.cookie = cookie;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(base + url, opts);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const photo = () => { const fd = new FormData(); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'winner.png'); return fd; };

before(async () => {
  ctx = await createApp({ dataDir, adminPassword: 'test-password', mdns: false, log: () => {} });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  await ctx.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('boards: design, content from an editor link (PIN), ceremony steps, live on screens', async () => {
  const fd = new FormData();
  fd.append('files', new Blob([PNG], { type: 'image/png' }), 'template.png');
  const bg = (await call('POST', '/api/media', fd)).body.created[0];

  const created = (await call('POST', '/api/boards', {
    name: 'Awards 2026', background: { mediaId: bg.id, color: 'nope' }, aspect: [1920, 1080],
    fields: [
      { id: 'cat', kind: 'text', name: 'Category', x: 0.1, y: 0.1, w: 0.8, h: 0.1, style: { size: 99, color: '#ffcc00', align: 'center', bold: true } },
      { id: 'who', kind: 'text', name: 'Winner', x: 0.1, y: 0.3, w: 0.5, h: 0.2 },
      { id: 'pic', kind: 'image', name: 'Photo', x: 0.65, y: 0.3, w: 0.25, h: 0.4, style: { fit: 'contain' } },
      { id: 'prices', kind: 'list', name: 'Prices', x: 0.1, y: 0.6, w: 0.5, h: 0.3, style: { columns: 7, header: 'Drink | Price' } },
      { kind: 'sparkles' },
    ],
  })).body;
  assert.equal(created.type, 'board');
  assert.equal(created.fields.length, 5);
  assert.equal(created.fields[0].style.size, 50, 'sizes are clamped');
  assert.equal(created.fields[3].style.columns, 3);
  assert.equal(created.fields[4].kind, 'text', 'unknown kinds become text');
  assert.equal(created.background.color, '#111827');
  assert.ok(created.editToken, 'the console sees the editor token');
  await call('PUT', `/api/boards/${created.id}`, { fields: created.fields.slice(0, 4) });

  // The editor link: phone page and API, no admin login needed.
  const link = (await call('POST', `/api/boards/${created.id}/editor-link`, {})).body;
  assert.match(link.url, /^\/b\/[\w-]+$/);
  const token = link.url.slice(3);
  const page = await fetch(base + link.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /board-edit\.js/);
  const viaLink = (await call('GET', `/edit/${token}`)).body;
  assert.equal(viaLink.name, 'Awards 2026');
  assert.equal(viaLink.editToken, undefined, 'editors never see the token itself');
  assert.equal((await call('GET', '/edit/not-a-token')).status, 404);

  // Content: text, a photo taken on the phone, a price list (extra cells dropped).
  const { mediaId } = (await call('POST', `/edit/${token}/upload`, photo())).body;
  assert.ok(mediaId);
  const saved = (await call('PUT', `/edit/${token}/values`, { values: {
    cat: 'Welcome', who: 'and good evening', pic: mediaId, prices: [['Beer', '4.50', 'x', 'y'], ['Wine', '5.00']], ghost: 'dropped',
  } })).body;
  assert.deepEqual(saved.values.prices, [['Beer', '4.50', 'x'], ['Wine', '5.00']]);
  assert.equal(saved.values.ghost, undefined);
  assert.equal((await call('GET', `/edit/${token}/media/${mediaId}`)).status, 200, 'the editor previews its photos');
  assert.equal((await call('GET', `/edit/${token}/media/${bg.id}`)).status, 200, 'and the background');
  const media = (await call('GET', '/api/media')).body;
  assert.equal(media.find((m) => m.id === mediaId).ownerBoardId, created.id, 'phone photos belong to the board');

  // On a screen: a board item with the content, photos as image items.
  const pl = (await call('POST', '/api/playlists', { name: 'Gala', items: [{ mediaId: created.id }] })).body;
  const screen = (await call('POST', '/api/screens', { name: 'Stage', defaultPlaylistId: pl.id })).body;
  const manifest = () => call('GET', `/api/screens/${screen.id}/manifest`).then((r) => r.body);
  let [item] = (await manifest()).playlists[pl.id].items;
  assert.equal(item.type, 'board');
  assert.equal(item.duration, 0, 'alone it stays up');
  assert.deepEqual(item.board.aspect, [1920, 1080]);
  assert.equal(item.board.background.image.file, bg.file);
  const byId = (it, fid) => it.board.fields.find((f) => f.id === fid);
  assert.equal(byId(item, 'cat').value, 'Welcome');
  assert.equal(byId(item, 'pic').value.type, 'image');
  const enc = forPlayer(await manifest(), 'device', { fileEntry: (file) => ({ id: `f-${file}`, size: 1, chunks: 1, salt: 's' }), wrap: () => ({ k: 'k', kiv: 'i' }) });
  const encItem = enc.playlists[pl.id].items[0];
  assert.equal(encItem.board.background.image.enc.f, `f-${bg.file}`, 'devices get board pictures encrypted');
  assert.equal(byId(encItem, 'pic').value.enc.f.startsWith('f-'), true);
  assert.equal(byId(encItem, 'pic').value.file, undefined);

  // Ceremony: prepared steps, then Next / Previous / back to the main board.
  const winner = (await call('POST', `/edit/${token}/upload`, photo())).body.mediaId;
  await call('PUT', `/edit/${token}/steps`, { steps: [
    { title: 'Best newcomer', values: { cat: 'Best newcomer', who: 'Alex Kim', pic: winner } },
    { title: 'Lifetime award', values: { cat: 'Lifetime award', who: 'Sam Lee' } },
  ] });
  assert.equal((await call('POST', `/edit/${token}/step`, { step: 'next' })).body.step, 0);
  [item] = (await manifest()).playlists[pl.id].items;
  assert.equal(byId(item, 'who').value, 'Alex Kim');
  assert.equal(byId(item, 'pic').value.file, (await call('GET', '/api/media')).body.find((m) => m.id === winner).file);
  assert.equal((await call('POST', `/edit/${token}/step`, { step: 'next' })).body.step, 1);
  [item] = (await manifest()).playlists[pl.id].items;
  assert.equal(byId(item, 'who').value, 'Sam Lee');
  assert.equal(byId(item, 'pic').value.file, (await call('GET', '/api/media')).body.find((m) => m.id === mediaId).file, 'empty in a step: the main content shows');
  assert.equal((await call('POST', `/edit/${token}/step`, { step: 'next' })).body.step, 1, 'stays on the last step');
  assert.equal((await call('POST', `/edit/${token}/step`, { step: -1 })).body.step, -1);
  assert.equal((await call('POST', `/edit/${token}/step`, { step: 9 })).status, 400);

  // A PIN, then a new link: the old one stops working.
  assert.equal((await call('POST', `/api/boards/${created.id}/editor-link`, { pin: '12a' })).status, 400);
  await call('POST', `/api/boards/${created.id}/editor-link`, { pin: '2468' });
  assert.equal((await call('GET', `/edit/${token}`)).status, 403);
  assert.equal((await call('GET', `/edit/${token}`, undefined, { 'X-Board-Pin': '1111' })).status, 403);
  assert.equal((await call('GET', `/edit/${token}`, undefined, { 'X-Board-Pin': '2468' })).status, 200);
  assert.equal((await call('GET', `/edit/${token}/media/${mediaId}?pin=2468`)).status, 200);
  const fresh = (await call('POST', `/api/boards/${created.id}/editor-link`, { reset: true })).body;
  assert.notEqual(fresh.url, link.url);
  assert.equal((await call('GET', `/edit/${token}`, undefined, { 'X-Board-Pin': '2468' })).status, 404);

  // The console edits content the same way.
  const admin = (await call('PUT', `/api/boards/${created.id}/values`, { values: { cat: 'Thank you' } })).body;
  assert.equal(admin.values.cat, 'Thank you');

  // Deleting the board takes its phone photos with it.
  await call('DELETE', `/api/media/${created.id}`);
  const left = (await call('GET', '/api/media')).body;
  assert.ok(!left.some((m) => m.id === created.id || m.ownerBoardId === created.id));
  assert.ok(left.some((m) => m.id === bg.id), 'the template picture stays in the library');
});
