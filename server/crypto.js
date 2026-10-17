// Cryptography for screens, modelled on PGP: content is encrypted once with a
// random per-file key (AES-256-GCM), that key is wrapped separately for every
// paired screen using ECDH (P-256) + HKDF, and everything the server tells a
// screen is signed (ECDSA P-256) so players reject anything that didn't come
// from this server. Players use the same primitives via WebCrypto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CHUNK_SIZE = 1024 * 1024;
export const WRAP_INFO = 'signage-wrap-v1';
export const AUTH_PREFIX = 'signage-auth-v1';

const ec = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const spki = (key) => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });

function loadOrCreate(file, generate) {
  if (fs.existsSync(file)) return crypto.createPrivateKey(fs.readFileSync(file));
  const { privateKey } = generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return privateKey;
}

export class ServerKeys {
  constructor(dir) {
    this.signKey = loadOrCreate(path.join(dir, 'server-sign.pem'), ec);
    this.ecdhKey = loadOrCreate(path.join(dir, 'server-ecdh.pem'), ec);
    this.addonKey = loadOrCreate(path.join(dir, 'addon-key.pem'), rsa);
    this.signPub = spki(this.signKey);
    this.ecdhPub = spki(this.ecdhKey);
    this.addonPub = spki(this.addonKey);
    // Short human-checkable fingerprint of the signing key, PGP style.
    this.fingerprint = crypto.createHash('sha256').update(this.signPub).digest('hex')
      .slice(0, 40).toUpperCase().match(/.{4}/g).join(' ');
  }

  sign(data) {
    return crypto.sign('sha256', Buffer.from(data), { key: this.signKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  }

  // Symmetric key shared with one device: HKDF(ECDH(server, device)).
  deviceKey(deviceEcdhPub, serverId) {
    const publicKey = importSpki(deviceEcdhPub);
    const secret = crypto.diffieHellman({ privateKey: this.ecdhKey, publicKey });
    return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(serverId), Buffer.from(WRAP_INFO), 32));
  }
}

export function importSpki(b64) {
  const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Expected a P-256 key');
  return key;
}

export function isValidDeviceKey(b64) {
  try { importSpki(b64); return true; } catch { return false; }
}

export function verifyDeviceSignature(signPub, message, signature) {
  try {
    return crypto.verify('sha256', Buffer.from(message), { key: importSpki(signPub), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

// AES-256-GCM helpers. Ciphertext is always ct || 16-byte tag (WebCrypto layout).
export function seal(key, plaintext, aad, iv = crypto.randomBytes(12)) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv, data };
}

export function open(key, iv, data, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

export function newFileKey() {
  return { id: crypto.randomBytes(12).toString('base64url'), key: crypto.randomBytes(32).toString('base64'), salt: crypto.randomBytes(4).toString('base64') };
}

export const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK_SIZE));

// Chunks use a deterministic nonce (file salt + chunk index). That is safe here
// because file contents never change under a given key, and it lets the server
// encrypt on the fly instead of storing a second copy of every file.
export function chunkIv(salt, index) {
  const iv = Buffer.alloc(12);
  Buffer.from(salt, 'base64').copy(iv, 0, 0, 4);
  iv.writeBigUInt64BE(BigInt(index), 4);
  return iv;
}

export const chunkAad = (fileId, index, count) => `${fileId}:${index}:${count}`;

export function encryptChunk(entry, index, plaintext, count) {
  return seal(Buffer.from(entry.key, 'base64'), plaintext, chunkAad(entry.id, index, count), chunkIv(entry.salt, index)).data;
}

// ---------- Chrome CRX3 packaging (self-hosted, auto-updating add-on) ----------
function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}
const pbBytes = (field, buf) => Buffer.concat([varint(field * 8 + 2), varint(buf.length), buf]);

export function extensionId(publicKeyDer) {
  return [...crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16).toString('hex')]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function buildCrx3(zip, privateKey) {
  const publicKey = spki(privateKey);
  const crxId = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const signedData = pbBytes(1, crxId);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedData.length);
  const signature = crypto.sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00'), len, signedData, zip]), privateKey);
  const header = Buffer.concat([pbBytes(2, Buffer.concat([pbBytes(1, publicKey), pbBytes(2, signature)])), pbBytes(10000, signedData)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0);
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}
