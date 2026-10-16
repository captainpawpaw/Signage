// Builds the per-screen browser add-on: the shared player plus a config.js
// baked with this screen's server URL and secret token.
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYER_FILES = ['player.html', 'player.js', 'player.css'];
const EXTENSION_FILES = ['background.js'];

export function extensionConfig(screen, serverUrl) {
  return { serverUrl: serverUrl.replace(/\/+$/, ''), token: screen.token, screenId: screen.id, screenName: screen.name };
}

export async function buildExtensionZip(screen, serverUrl) {
  const config = extensionConfig(screen, serverUrl);
  const origin = new URL(config.serverUrl).origin;
  const manifest = {
    manifest_version: 3,
    name: `Signage – ${screen.name}`.slice(0, 75),
    short_name: 'Signage',
    version: `1.0.${screen.tokenRevision || 0}`,
    description: `Digital signage player for screen "${screen.name}" (${screen.id}).`,
    background: { service_worker: 'background.js' },
    permissions: ['tabs', 'alarms', 'storage', 'power'],
    host_permissions: [`${origin}/*`],
    action: { default_title: `Signage: ${screen.name}` },
  };

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('config.js', `// Generated for screen "${screen.name}". Keep private: contains the screen's access token.\nself.SIGNAGE_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
  for (const f of PLAYER_FILES) zip.file(f, await fs.readFile(path.join(ROOT, 'player', f)));
  for (const f of EXTENSION_FILES) zip.file(f, await fs.readFile(path.join(ROOT, 'extension', f)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
