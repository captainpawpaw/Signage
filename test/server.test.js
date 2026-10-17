import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createApp } from '../server/app.js';
import { extensionId } from '../server/crypto.js';
import { socket, device, addonConfig, newDeviceKeys } from './helpers.js';

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

let ctx, base, cookie, cfg;
const shared = {};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));

async function call(method, url, body, headers = {}) {
  const opts = { method, headers: { cookie, ...headers } };
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(base + url, opts);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const upload = async (name, type, data) => {
  const fd = new FormData();
  fd.append('files', new Blob([data], { type }), name);
  return (await call('POST', '/api/media', fd)).body;
};

async function waitReady(mediaId) {
  for (let i = 0; i < 300; i++) {
    const m = (await call('GET', '/api/media')).body.find((x) => x.id === mediaId);
    if (m.status !== 'processing') return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('media still processing');
}

before(async () => {
  ctx = await createApp({ dataDir, adminPassword: 'test-password', mdns: false, log: () => {} });
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

test('content setup and unencrypted preview player', async () => {
  const up = await (async () => {
    const fd = new FormData();
    fd.append('files', new Blob([PNG], { type: 'image/png' }), 'hello.png');
    fd.append('files', new Blob(['nope'], { type: 'text/plain' }), 'notes.txt');
    return (await call('POST', '/api/media', fd)).body;
  })();
  assert.equal(up.created.length, 1);
  assert.equal(up.rejected.length, 1);
  shared.image = up.created[0];

  shared.pl = (await call('POST', '/api/playlists', { name: 'Lobby', items: [{ mediaId: shared.image.id, duration: 5 }] })).body;
  const screen = (await call('POST', '/api/screens', { name: 'Reception', defaultPlaylistId: shared.pl.id, timezone: 'UTC' })).body;
  shared.screen = screen;
  assert.equal(screen.activePlaylistId, shared.pl.id);
  assert.equal(screen.paired, false);
  for (const secret of ['previewToken', 'enrollToken', 'token']) assert.equal(screen[secret], undefined, `${secret} must not be exposed`);

  const untimed = (await call('POST', '/api/screens', { name: 'No TZ given' })).body;
  assert.ok(untimed.timezone, 'falls back to the server time zone');
  assert.equal((await call('PUT', `/api/screens/${untimed.id}`, { timezone: 'Mars/Olympus' })).status, 400);
  await call('DELETE', `/api/screens/${untimed.id}`);

  const { url } = (await call('GET', `/api/screens/${screen.id}/preview-url`)).body;
  const token = decodeURIComponent(url.split('#token=')[1]);
  shared.previewToken = token;
  const p = socket(base);
  await p.opened;
  p.send({ type: 'hello', mode: 'preview', token });
  const first = (await p.next((m) => m.type === 'manifest')).manifest;
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].duration, 5000);
  assert.match(first.items[0].url, /^\/files\//);

  assert.equal((await fetch(base + first.items[0].url)).status, 401);
  const file = await fetch(`${base}${first.items[0].url}?pt=${encodeURIComponent(token)}`);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);

  await call('PUT', `/api/playlists/${shared.pl.id}`, { items: [{ mediaId: shared.image.id, duration: 5 }, { mediaId: shared.image.id, duration: 7 }] });
  const second = (await p.next((m) => m.type === 'manifest')).manifest;
  assert.equal(second.items.length, 2);
  assert.notEqual(second.version, first.version);

  p.send({ type: 'status', version: second.version, index: 1, itemCount: 2 });
  await new Promise((r) => setTimeout(r, 50));
  const listed = (await call('GET', `/api/screens/${screen.id}`)).body;
  assert.equal(listed.status.online, true);
  assert.equal(listed.status.encrypted, false);
  assert.equal(listed.status.index, 1);
  assert.equal((await call('POST', `/api/screens/${screen.id}/command`, { command: 'identify' })).body.delivered, 1);
  assert.equal((await p.next((m) => m.type === 'command')).command, 'identify');

  // Short links are opt-in; once created they redirect to the full preview link.
  assert.equal((await call('GET', `/api/screens/${screen.id}/preview-url`)).body.shortUrl, null);
  const { shortUrl } = (await call('POST', `/api/screens/${screen.id}/short-link`)).body;
  assert.match(shortUrl, /^\/p\/[A-Z2-9]{6}$/);
  const short = await fetch(base + shortUrl.toLowerCase(), { redirect: 'manual' });
  assert.equal(short.status, 302);
  assert.equal(short.headers.get('location'), url);
  assert.equal((await call('DELETE', `/api/screens/${screen.id}/short-link`)).body.shortUrl, null);
  assert.equal((await fetch(base + shortUrl, { redirect: 'manual' })).status, 404, 'removed short link stops working');
  shared.shortUrl = (await call('POST', `/api/screens/${screen.id}/short-link`)).body.shortUrl;

  const polled = await call('GET', '/api/player/manifest', null, { authorization: `Bearer ${token}` });
  assert.equal(polled.body.version, second.version);
  p.ws.close();
});

test('universal add-on: discovery info, pairing, signed + encrypted delivery', async () => {
  const hello = await (await fetch(`${base}/api/hello`)).json();
  const zip = await call('GET', '/addon/signage-chrome.zip');
  assert.equal(zip.status, 200);
  cfg = await addonConfig(zip.body);
  assert.equal(cfg.serverId, hello.serverId);
  assert.equal(cfg.enrollToken, undefined);
  assert.ok(cfg.candidates.length >= 2, 'add-on carries several ways to reach the server');

  // The download is signed so the screen-PC updater can verify it.
  assert.ok(crypto.verify('sha256', zip.body, { key: ctx.keys.signKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(zip.headers.get('x-signage-signature'), 'base64')));

  const keys = await newDeviceKeys();
  const d = await device(base, cfg, keys);
  const pairing = await d.next((m) => m.type === 'pairing');
  assert.match(pairing.code, /^[A-Z2-9]{6}$/);
  const pending = (await call('GET', '/api/pairings')).body;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].code, pairing.code);

  assert.equal((await call('POST', '/api/pairings/ZZZZZZ', { screenId: shared.screen.id })).status, 404);
  const paired = (await call('POST', `/api/pairings/${pairing.code.toLowerCase()}`, { screenId: shared.screen.id })).body;
  assert.equal(paired.paired, true);

  const welcome = await d.next((m) => m.type === 'welcome');
  assert.equal(welcome.screen.id, shared.screen.id);
  const { manifest } = await d.next((m) => m.type === 'manifest');
  assert.equal(manifest.items.length, 2);
  const item = manifest.items[0];
  assert.equal(item.url, undefined, 'devices never get plain URLs');
  assert.ok(item.enc.f && item.enc.k && item.enc.kiv);
  assert.deepEqual(await d.decryptFile(item.enc), PNG);
  assert.equal(d.state.rejected.length, 0);

  // Chunks need a live session.
  assert.equal((await fetch(`${base}/api/player/chunk/${item.enc.f}/0`)).status, 401);
  assert.equal((await fetch(`${base}/api/player/chunk/${item.enc.f}/0`, { headers: { 'X-Signage-Session': 'nope' } })).status, 401);

  // Encrypted screenshot round trip.
  await d.screenshot(shared.screen.id, JPEG);
  await new Promise((r) => setTimeout(r, 100));
  const shot = await call('GET', `/api/screens/${shared.screen.id}/screenshot.jpg`);
  assert.equal(shot.status, 200);
  assert.deepEqual(shot.body, JPEG);

  // The same device reconnecting is recognised by its key, no pairing.
  const again = await device(base, cfg, keys);
  assert.equal((await again.next((m) => m.type === 'welcome')).screen.id, shared.screen.id);
  again.ws.close();

  const status = (await call('GET', `/api/screens/${shared.screen.id}`)).body.status;
  assert.equal(status.online, true);
  shared.device = { d, keys };
});

test('device authentication cannot be faked', async () => {
  // Valid-looking hello, but the signature is not made with the claimed key.
  const keys = await newDeviceKeys();
  const s = socket(base);
  await s.opened;
  s.send({ type: 'hello', mode: 'device', signPub: shared.device.keys.signPub, ecdhPub: keys.ecdhPub, cn: 'x' });
  const challenge = await s.next((m) => m.type === 'challenge');
  const sig = await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.sign.privateKey, new TextEncoder().encode(`signage-auth-v1|${cfg.serverId}|${challenge.nonce}|x`));
  s.send({ type: 'auth', sig: Buffer.from(sig).toString('base64') });
  assert.equal(await s.closed, 4001);

  // A message whose signature doesn't match its content fails verification.
  const forged = JSON.stringify({ type: 'command', command: 'reload', cn: 'x', seq: 999 });
  const serverKey = await crypto.webcrypto.subtle.importKey('spki', Buffer.from(cfg.signKey, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, serverKey, Buffer.from(ctx.keys.sign('something else'), 'base64'), new TextEncoder().encode(forged));
  assert.equal(ok, false);
});

test('pre-configured add-on enrols once', async () => {
  const s2 = (await call('POST', '/api/screens', { name: 'Canteen', defaultPlaylistId: shared.pl.id })).body;
  const zip = await call('GET', `/api/screens/${s2.id}/extension.zip`);
  const c2 = await addonConfig(zip.body);
  assert.ok(c2.enrollToken);
  const manifestJson = JSON.parse(await (await JSZip.loadAsync(zip.body)).file('manifest.json').async('string'));
  assert.equal(extensionId(Buffer.from(manifestJson.key, 'base64')), (await call('GET', '/api/info')).body.extensionId);

  const d = await device(base, c2, await newDeviceKeys(), { enrollToken: c2.enrollToken });
  assert.equal((await d.next((m) => m.type === 'welcome')).screen.id, s2.id);
  // The token is single-use: another device presenting it has to pair.
  const thief = await device(base, c2, await newDeviceKeys(), { enrollToken: c2.enrollToken });
  assert.ok((await thief.next((m) => m.type === 'pairing')).code);
  thief.ws.close();
  d.ws.close();
  shared.canteen = s2;
});

test('groups: shared default playlist and schedule', async () => {
  const other = (await call('POST', '/api/playlists', { name: 'Menu', items: [{ mediaId: shared.image.id }] })).body;
  await call('PUT', `/api/screens/${shared.canteen.id}`, { defaultPlaylistId: null });
  const group = (await call('POST', '/api/groups', { name: 'Ground floor', defaultPlaylistId: other.id, screenIds: [shared.canteen.id] })).body;
  let s2 = (await call('GET', `/api/screens/${shared.canteen.id}`)).body;
  assert.deepEqual(s2.groupIds, [group.id]);
  assert.equal(s2.activePlaylistId, other.id);

  // An always-on group rule overrides the screen's own default.
  await call('PUT', `/api/screens/${shared.canteen.id}`, { defaultPlaylistId: shared.pl.id });
  await call('PUT', `/api/groups/${group.id}`, { schedule: [{ playlistId: other.id, start: '00:00', end: '00:00' }] });
  s2 = (await call('GET', `/api/screens/${shared.canteen.id}`)).body;
  assert.equal(s2.activePlaylistId, other.id);
  assert.deepEqual(s2.activeGroup, { id: group.id, name: 'Ground floor' });

  await call('DELETE', `/api/groups/${group.id}`);
  s2 = (await call('GET', `/api/screens/${shared.canteen.id}`)).body;
  assert.deepEqual(s2.groupIds, []);
  assert.equal(s2.activePlaylistId, shared.pl.id);
});

test('switching off unencrypted players', async () => {
  await call('PUT', '/api/settings', { allowPlaintext: false });
  const p = socket(base);
  await p.opened;
  p.send({ type: 'hello', mode: 'preview', token: shared.previewToken });
  assert.equal((await p.next()).code, 'encryption-required');
  assert.equal((await fetch(`${base}/files/${shared.image.file}?pt=${encodeURIComponent(shared.previewToken)}`)).status, 401);
  assert.equal((await call('GET', `/api/screens/${shared.screen.id}/preview-url`)).status, 409);
  await call('PUT', '/api/settings', { allowPlaintext: true });
});

test('resetting a screen unpairs its device', async () => {
  const { d, keys } = shared.device;
  await call('POST', `/api/screens/${shared.screen.id}/regenerate-token`);
  assert.equal(await d.closed, 4001);
  assert.equal((await fetch(base + shared.shortUrl, { redirect: 'manual' })).status, 404, 'old short link is revoked');
  const back = await device(base, cfg, keys);
  assert.ok((await back.next((m) => m.type === 'pairing')).code, 'must be paired again');
  back.ws.close();
});

test('offline notice: default, settings with QR, per-screen override', async () => {
  const manifestOf = async (id) => (await call('GET', `/api/screens/${id}/manifest`)).body;
  assert.deepEqual((await manifestOf(shared.canteen.id)).offline, { position: 'corner', message: '', qr: null });

  const saved = (await call('PUT', '/api/settings', { offline: { message: 'Back soon', qr: 'https://example.com/news', position: 'fullscreen' } })).body;
  assert.match(saved.offline.qrPreview, /^data:image\/svg\+xml;base64,/);
  let m = await manifestOf(shared.canteen.id);
  assert.equal(m.offline.message, 'Back soon');
  assert.equal(m.offline.position, 'fullscreen');
  assert.equal(m.offline.qr, saved.offline.qrPreview);
  const svg = Buffer.from(m.offline.qr.split(',')[1], 'base64').toString();
  assert.match(svg, /^<svg [^>]*><rect [^>]*\/><path d="[Mhvz0-9 -]+" fill="#000"\/><\/svg>$/, 'plain SVG, nothing executable');

  await call('PUT', `/api/screens/${shared.canteen.id}`, { offline: { mode: 'custom', message: 'Canteen only', position: 'corner' } });
  m = await manifestOf(shared.canteen.id);
  assert.deepEqual(m.offline, { position: 'corner', message: 'Canteen only', qr: null });
  await call('PUT', `/api/screens/${shared.canteen.id}`, { offline: { mode: 'off' } });
  assert.equal((await manifestOf(shared.canteen.id)).offline.position, 'none');

  // Rejects junk and long input.
  const junk = (await call('PUT', '/api/settings', { offline: { message: 'x'.repeat(1000), position: 'sideways' } })).body.offline;
  assert.equal(junk.message.length, 300);
  assert.equal(junk.position, 'corner');
  await call('PUT', '/api/settings', { offline: { message: '', qr: '', position: 'corner' } });
});

test('short links resist guessing', async () => {
  let last;
  for (let i = 0; i < 22; i++) last = (await fetch(`${base}/p/ZZZZZ${i % 10}`, { redirect: 'manual' })).status;
  assert.equal(last, 429);
});

test('CRX package and update manifest', async () => {
  const info = (await call('GET', '/api/info')).body;
  const crx = (await call('GET', '/addon/signage.crx')).body;
  assert.equal(crx.subarray(0, 4).toString(), 'Cr24');
  assert.equal(crx.readUInt32LE(4), 3);
  const headerLen = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLen);
  const zip = crx.subarray(12 + headerLen);
  // Minimal protobuf walk: field 2 = sha256_with_rsa proof, field 10000 = signed data.
  const read = (buf) => {
    const out = {};
    let i = 0;
    const varint = () => { let n = 0, m = 1, b; do { b = buf[i++]; n += (b & 127) * m; m *= 128; } while (b & 128); return n; };
    while (i < buf.length) { const key = varint(); const len = varint(); out[key >> 3] = buf.subarray(i, i + len); i += len; }
    return out;
  };
  const top = read(header);
  const proof = read(top[2]);
  const signed = top[10000];
  const len = Buffer.alloc(4); len.writeUInt32LE(signed.length);
  const pub = crypto.createPublicKey({ key: proof[1], format: 'der', type: 'spki' });
  assert.ok(crypto.verify('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00'), len, signed, zip]), pub, proof[2]));
  assert.equal(extensionId(proof[1]), info.extensionId);
  const manifest = JSON.parse(await (await JSZip.loadAsync(zip)).file('manifest.json').async('string'));
  assert.equal(manifest.version, info.addonVersion);
  assert.match(manifest.update_url, /\/addon\/updates\.xml$/);
  const xml = (await call('GET', '/addon/updates.xml')).body.toString();
  assert.match(xml, new RegExp(`appid='${info.extensionId}'`));
  assert.match(xml, new RegExp(`version='${info.addonVersion}'`));

  const ff = await JSZip.loadAsync((await call('GET', '/addon/signage-firefox.zip')).body);
  const ffManifest = JSON.parse(await ff.file('manifest.json').async('string'));
  assert.deepEqual(ffManifest.background.scripts, ['config.js', 'background.js']);
  assert.ok(ffManifest.browser_specific_settings.gecko.id);

  const setup = await JSZip.loadAsync((await call('GET', '/addon/screen-setup.zip')).body);
  for (const f of ['setup-screen.bat', 'setup-screen.ps1', 'update-addon.ps1', 'server.json', 'addon/manifest.json', 'addon/player.js']) assert.ok(setup.file(f), f);
});

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();

test('videos are converted to streamable MP4', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const src = path.join(dataDir, 'in.mov');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', src]);
  const { created } = await upload('clip.mov', 'video/quicktime', fs.readFileSync(src));
  assert.equal(created[0].status, 'processing');
  const m = await waitReady(created[0].id);
  assert.equal(m.status, 'ready', m.error);
  assert.equal(m.stream, true);
  assert.match(m.codecs, /^avc1\.6400(29|33), mp4a\.40\.2$/);
  assert.ok(m.poster);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(dataDir, 'media', m.file)]).toString();
  assert.match(probe, /h264/);
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
