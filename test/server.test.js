import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import JSZip from 'jszip';
import { createApp } from '../server/app.js';

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let ctx, base, cookie;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));

async function call(method, url, body, headers = {}) {
  const opts = { method, headers: { cookie, ...headers } };
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(base + url, opts);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

// Collects every message from a socket so tests can await specific ones.
function player(token) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred = () => true) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timed out waiting for message')), 3000);
    });
  };
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  const opened = new Promise((r) => ws.on('open', r)).then(() => ws.send(JSON.stringify({ type: 'hello', token })));
  return { ws, next, closed, opened };
}

before(async () => {
  ctx = await createApp({ dataDir, adminPassword: 'test-password', log: () => {} });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${ctx.server.address().port}`;
});

after(async () => {
  await ctx.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('admin API requires login', async () => {
  assert.equal((await call('GET', '/api/screens')).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/screens')).status, 200);
});

test('end to end: upload, playlist, screen, live push, add-on', async () => {
  // Upload an image
  const fd = new FormData();
  fd.append('files', new Blob([PNG], { type: 'image/png' }), 'hello.png');
  fd.append('files', new Blob(['nope'], { type: 'text/plain' }), 'notes.txt');
  const up = await call('POST', '/api/media', fd);
  assert.equal(up.status, 201);
  assert.equal(up.body.created.length, 1);
  assert.equal(up.body.rejected.length, 1);
  const image = up.body.created[0];

  // Playlist + screen
  const pl = (await call('POST', '/api/playlists', { name: 'Lobby', items: [{ mediaId: image.id, duration: 5 }] })).body;
  const screen = (await call('POST', '/api/screens', { name: 'Reception', defaultPlaylistId: pl.id, timezone: 'UTC' })).body;
  assert.equal(screen.activePlaylistId, pl.id);
  const untimed = (await call('POST', '/api/screens', { name: 'No TZ given' })).body;
  assert.ok(untimed.timezone, 'falls back to the server time zone');
  assert.equal((await call('PUT', `/api/screens/${untimed.id}`, { timezone: 'Mars/Olympus' })).status, 400);
  await call('DELETE', `/api/screens/${untimed.id}`);
  const token = ctx.store.screens.find((s) => s.id === screen.id).token;
  assert.equal(screen.token, undefined, 'token must not be exposed by the API');

  // Player connects and receives its manifest
  const p = player(token);
  await p.opened;
  const first = (await p.next((m) => m.type === 'manifest')).manifest;
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].duration, 5000);
  assert.equal(first.playlist.name, 'Lobby');

  // Media is readable with the screen token, not anonymously
  assert.equal((await fetch(base + first.items[0].url)).status, 401);
  const file = await fetch(base + first.items[0].url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);

  // Editing the playlist pushes a new manifest immediately
  await call('PUT', `/api/playlists/${pl.id}`, { items: [{ mediaId: image.id, duration: 5 }, { mediaId: image.id, duration: 7 }] });
  const second = (await p.next((m) => m.type === 'manifest')).manifest;
  assert.equal(second.items.length, 2);
  assert.notEqual(second.version, first.version);

  // Status reports and remote commands
  p.ws.send(JSON.stringify({ type: 'status', version: second.version, index: 1, itemCount: 2 }));
  await new Promise((r) => setTimeout(r, 50));
  const listed = (await call('GET', `/api/screens/${screen.id}`)).body;
  assert.equal(listed.status.online, true);
  assert.equal(listed.status.index, 1);
  assert.equal((await call('POST', `/api/screens/${screen.id}/command`, { command: 'identify' })).body.delivered, 1);
  assert.equal((await p.next((m) => m.type === 'command')).command, 'identify');

  // HTTP fallback
  const polled = await call('GET', '/api/player/manifest', null, { authorization: `Bearer ${token}` });
  assert.equal(polled.body.version, second.version);

  // Per-screen add-on
  const zipRes = await call('GET', `/api/screens/${screen.id}/extension.zip?serverUrl=${encodeURIComponent('http://10.0.0.5:8080/')}`);
  assert.equal(zipRes.status, 200);
  const zip = await JSZip.loadAsync(zipRes.body);
  assert.deepEqual(Object.keys(zip.files).sort(), ['background.js', 'config.js', 'manifest.json', 'player.css', 'player.html', 'player.js']);
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['http://10.0.0.5:8080/*']);
  const config = await zip.file('config.js').async('string');
  assert.match(config, new RegExp(token));
  assert.match(config, /"serverUrl": "http:\/\/10\.0\.0\.5:8080"/);

  // Regenerating the token kicks the old player and rejects its token
  await call('POST', `/api/screens/${screen.id}/regenerate-token`);
  assert.equal(await p.closed, 4001);
  const stale = player(token);
  await stale.opened;
  assert.equal((await stale.next()).code, 'unauthorized');
  assert.equal(await stale.closed, 4001);
});

test('PDF decks are converted into slides', async (t) => {
  const { converters } = (await call('GET', '/api/info')).body;
  if (!converters.pdf) return t.skip('pdftoppm not installed');
  // Minimal two-page PDF
  const pdf = makePdf(2);
  const fd = new FormData();
  fd.append('files', new Blob([pdf], { type: 'application/pdf' }), 'deck.pdf');
  const deck = (await call('POST', '/api/media', fd)).body.created[0];
  assert.equal(deck.status, 'processing');
  for (let i = 0; i < 50; i++) {
    const m = (await call('GET', '/api/media')).body.find((x) => x.id === deck.id);
    if (m.status !== 'processing') {
      assert.equal(m.status, 'ready', m.error);
      assert.equal(m.pages.length, 2);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('deck conversion did not finish');
});

function makePdf(pages) {
  const objs = [];
  const kids = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  for (let i = 0; i < pages; i++) {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    const stream = `0 0 1 rg 0 0 200 100 re f 1 1 1 rg ${20 + i * 40} 30 40 40 re f`;
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
