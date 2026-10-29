import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

let ctx, base, cookie;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-shape-'));

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

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

test('screens are 16:9 unless given a custom ratio or exact pixels, in either orientation', async () => {
  const plain = (await call('POST', '/api/screens', { name: 'Lobby' })).body;
  assert.equal(plain.settings.shape, undefined, 'standard 16:9 needs no shape');
  assert.equal(plain.settings.orientation, 'landscape');

  const bar = (await call('POST', '/api/screens', { name: 'Bar', settings: { orientation: 'portrait', shape: { kind: 'ratio', w: 32, h: 9 } } })).body;
  assert.deepEqual(bar.settings.shape, { kind: 'ratio', w: 32, h: 9 });
  assert.equal(bar.settings.orientation, 'portrait');
  const manifest = (await call('GET', `/api/screens/${bar.id}/manifest`)).body;
  assert.deepEqual(manifest.settings.shape, { kind: 'ratio', w: 32, h: 9 }, 'players get the shape');

  const led = (await call('PUT', `/api/screens/${plain.id}`, { settings: { orientation: 'landscape', shape: { kind: 'pixels', w: 1920, h: 360 } } })).body;
  assert.deepEqual(led.settings.shape, { kind: 'pixels', w: 1920, h: 360, anchor: 'top-left' });
  const wide = (await call('PUT', `/api/screens/${plain.id}`, { settings: { shape: { kind: 'ratio', w: 2.39, h: 1 } } })).body;
  assert.deepEqual(wide.settings.shape, { kind: 'ratio', w: 2.39, h: 1 });
  const back = (await call('PUT', `/api/screens/${plain.id}`, { settings: { shape: { kind: 'ratio', w: 1920, h: 1080 } } })).body;
  assert.equal(back.settings.shape, undefined, 'a 16:9 ratio is the standard shape');

  assert.equal((await call('PUT', `/api/screens/${plain.id}`, { settings: { shape: { kind: 'ratio', w: 0, h: 9 } } })).status, 400);
  assert.equal((await call('PUT', `/api/screens/${plain.id}`, { settings: { shape: { kind: 'pixels', w: 1920.5, h: 360 } } })).status, 400);
  assert.equal((await call('PUT', `/api/screens/${plain.id}`, { settings: { shape: { kind: 'pixels', w: 99999, h: 360 } } })).status, 400);
});
