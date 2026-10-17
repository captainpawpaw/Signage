// Test helpers: a socket wrapper, and a device client that speaks the
// encrypted protocol with WebCrypto exactly like the browser player does.
import WebSocket from 'ws';
import JSZip from 'jszip';

const { subtle } = globalThis.crypto;
const utf8 = new TextEncoder();
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// Collects every message from a socket so tests can await specific ones.
export function socket(base, { transform = async (m) => m } = {}) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const queue = [];
  const waiters = [];
  let chain = Promise.resolve();
  ws.on('message', (raw) => {
    chain = chain.then(async () => {
      const msg = await transform(JSON.parse(raw));
      if (!msg) return;
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
    });
  });
  const next = (pred = () => true, ms = 4000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timed out waiting for message')), ms);
    });
  };
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  const opened = new Promise((r) => ws.on('open', r));
  const send = (obj) => ws.send(JSON.stringify(obj));
  return { ws, next, closed, opened, send, queue };
}

export async function addonConfig(zipBuffer) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const js = await zip.file('config.js').async('string');
  return JSON.parse(js.slice(js.indexOf('=') + 1).trim().replace(/;$/, ''));
}

export async function newDeviceKeys() {
  const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return {
    sign, ecdh,
    signPub: b64(await subtle.exportKey('spki', sign.publicKey)),
    ecdhPub: b64(await subtle.exportKey('spki', ecdh.publicKey)),
  };
}

// Connects like the add-on: hello → signed challenge → verified signed messages.
export async function device(base, cfg, keys, { enrollToken, cn = b64(crypto.getRandomValues(new Uint8Array(16))) } = {}) {
  const serverSign = await subtle.importKey('spki', unb64(cfg.signKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const serverEcdh = await subtle.importKey('spki', unb64(cfg.ecdhKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await subtle.deriveBits({ name: 'ECDH', public: serverEcdh }, keys.ecdh.privateKey, 256);
  const hkdf = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const wrapKey = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(cfg.serverId), info: utf8.encode('signage-wrap-v1') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

  let seq = 0;
  const state = { rejected: [] };
  const s = socket(base, {
    transform: async (msg) => {
      if (msg.type === 'challenge') {
        const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.sign.privateKey, utf8.encode(`signage-auth-v1|${cfg.serverId}|${msg.nonce}|${cn}`));
        s.send({ type: 'auth', sig: b64(sig) });
        return null;
      }
      if (msg.type !== 'signed') return msg;
      const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, serverSign, unb64(msg.s), utf8.encode(msg.p));
      const inner = JSON.parse(msg.p);
      if (!ok || inner.cn !== cn || inner.seq <= seq) { state.rejected.push(inner); return null; }
      seq = inner.seq;
      if (inner.type === 'welcome') state.session = inner.session;
      return inner;
    },
  });
  await s.opened;
  s.send({ type: 'hello', mode: 'device', signPub: keys.signPub, ecdhPub: keys.ecdhPub, cn, enrollToken, playerVersion: 'test' });

  async function decryptFile(enc) {
    const raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(enc.kiv), additionalData: utf8.encode(enc.f) }, wrapKey, unb64(enc.k));
    const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const parts = [];
    for (let i = 0; i < enc.n; i++) {
      const res = await fetch(`${base}/api/player/chunk/${enc.f}/${i}`, { headers: { 'X-Signage-Session': state.session } });
      if (!res.ok) throw new Error(`chunk HTTP ${res.status}`);
      const iv = new Uint8Array(12);
      iv.set(unb64(enc.salt).subarray(0, 4));
      new DataView(iv.buffer).setBigUint64(4, BigInt(i));
      parts.push(Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(`${enc.f}:${i}:${enc.n}`) }, key, await res.arrayBuffer())));
    }
    return Buffer.concat(parts);
  }

  async function screenshot(screenId, jpeg) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(`screenshot:${screenId}`) }, wrapKey, jpeg);
    s.send({ type: 'screenshot', iv: b64(iv), data: b64(data) });
  }

  return { ...s, state, decryptFile, screenshot };
}
