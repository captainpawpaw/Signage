// What a screen shows while it can't reach the server. Configured once in
// Settings, optionally overridden per screen, and delivered inside the
// manifest so screens still have it when the server is unreachable.
import QRCode from 'qrcode';

export const OFFLINE_POSITIONS = ['corner', 'fullscreen', 'none'];
export const DEFAULT_OFFLINE = { message: '', qr: '', position: 'corner' };

const MAX_MESSAGE = 300;
const MAX_QR = 500;

export function cleanOffline(input = {}) {
  return {
    message: typeof input.message === 'string' ? input.message.trim().slice(0, MAX_MESSAGE) : '',
    qr: typeof input.qr === 'string' ? input.qr.trim().slice(0, MAX_QR) : '',
    position: OFFLINE_POSITIONS.includes(input.position) ? input.position : 'corner',
  };
}

// Per screen: { mode: 'default' | 'custom' | 'off', ...custom fields }
export function cleanScreenOffline(input = {}) {
  const mode = ['default', 'custom', 'off'].includes(input.mode) ? input.mode : 'default';
  return mode === 'custom' ? { mode, ...cleanOffline(input) } : { mode };
}

const qrCache = new Map();

// QR code as an SVG data URL. Shown with <img>, so it can never run script.
export function qrDataUrl(text) {
  if (!text) return null;
  if (!qrCache.has(text)) {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const n = modules.size;
    const quiet = 2;
    let path = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (modules.get(y, x)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    const size = n + quiet * 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
    if (qrCache.size > 200) qrCache.clear();
    qrCache.set(text, `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  }
  return qrCache.get(text);
}

// The notice a screen should use, ready for the player.
export function offlineNotice(settings, screen) {
  const override = screen.offline || { mode: 'default' };
  if (override.mode === 'off') return { position: 'none', message: '', qr: null };
  const base = override.mode === 'custom' ? override : { ...DEFAULT_OFFLINE, ...settings.offline };
  return { position: base.position || 'corner', message: base.message || '', qr: qrDataUrl(base.qr) };
}
