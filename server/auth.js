import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'signage_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Sets up the admin credential and session secret on first run.
// ADMIN_PASSWORD (env) always wins; otherwise a password is generated once and
// written to <dataDir>/admin-password.txt.
export function initAuth(store, { dataDir, adminPassword, log = console.log }) {
  const s = store.settings;
  if (!s.sessionSecret) s.sessionSecret = randomToken(32);
  if (adminPassword) {
    s.admin = { salt: randomToken(12) };
    s.admin.hash = hashPassword(adminPassword, s.admin.salt);
  } else if (!s.admin) {
    const generated = randomToken(9);
    s.admin = { salt: randomToken(12) };
    s.admin.hash = hashPassword(generated, s.admin.salt);
    const file = path.join(dataDir, 'admin-password.txt');
    fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
    log(`[signage] Generated admin password: ${generated} (saved to ${file})`);
  }
  store.save();
}

export function setPassword(store, password) {
  store.settings.admin = { salt: randomToken(12) };
  store.settings.admin.hash = hashPassword(password, store.settings.admin.salt);
  store.save();
}

export function checkPassword(store, password) {
  const { salt, hash } = store.settings.admin || {};
  if (!salt || typeof password !== 'string') return false;
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(store, payload) {
  return crypto.createHmac('sha256', store.settings.sessionSecret).update(payload).digest('base64url');
}

export function issueSession(store, res, secure) {
  const expires = Date.now() + SESSION_TTL_MS;
  const value = `${expires}.${sign(store, String(expires))}`;
  res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_TTL_MS, path: '/' });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAdmin(store, req) {
  const value = parseCookies(req.headers.cookie)[COOKIE];
  if (!value) return false;
  const [expires, sig] = value.split('.');
  if (!sig || Number(expires) < Date.now()) return false;
  const expected = sign(store, expires);
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// Unencrypted players (browser previews, v1 add-ons) authenticate with the
// screen's preview token, as a bearer header or ?pt= on plain <img>/<video> URLs.
// They are only accepted while "allow unencrypted players" is on.
export function previewScreenFromRequest(store, req) {
  if (!store.settings.allowPlaintext) return null;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query?.pt || req.query?.token;
  return token ? screenByPreviewToken(store, token) : null;
}

export function screenByPreviewToken(store, token) {
  return findByToken(store.screens, 'previewToken', token);
}

export function findByToken(list, field, token) {
  if (typeof token !== 'string' || !token) return null;
  const b = Buffer.from(token);
  return list.find((s) => {
    if (typeof s[field] !== 'string') return false;
    const a = Buffer.from(s[field]);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }) || null;
}
