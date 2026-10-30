// Builds the Linux player (Raspberry Pi and other Linux devices):
//   - the agent package: agent + shared player + its few pure-JS dependencies,
//     as a .tar.gz the agent can also install as a signed self-update;
//   - the setup file: one shell script with the server's config and the
//     package embedded, so it works on a device with no other files.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PLAYER_VENDOR } from './live.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYER_FILES = ['player.html', 'player.js', 'player.css', 'board.js'];
const AGENT_DEPENDENCIES = ['ws', 'multicast-dns'];

export const agentVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'agent', 'package.json'), 'utf8')).version;

// Minimal POSIX ustar writer: enough for regular files with plain names.
function tarHeader(name, size, mode) {
  const h = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const put = (str, offset, len) => h.write(str, offset, len, 'utf8');
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

function tarGz(entries) {
  const parts = [];
  for (const { name, data, mode = 0o644 } of entries) {
    parts.push(tarHeader(name, data.length, mode), data);
    if (data.length % 512) parts.push(Buffer.alloc(512 - (data.length % 512)));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function filesUnder(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, `${base}/${entry.name}`));
    else if (entry.isFile()) out.push({ name: `${base}/${entry.name}`, data: fs.readFileSync(full) });
  }
  return out;
}

function dependencyTree(names, seen = new Set()) {
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
    dependencyTree(Object.keys(pkg.dependencies || {}), seen);
  }
  return [...seen];
}

export function buildAgentPackage() {
  const entries = [
    { name: 'agent/agent.js', data: fs.readFileSync(path.join(ROOT, 'agent', 'agent.js')) },
    { name: 'agent/package.json', data: fs.readFileSync(path.join(ROOT, 'agent', 'package.json')) },
    ...PLAYER_FILES.map((f) => ({ name: `player/${f}`, data: fs.readFileSync(path.join(ROOT, 'player', f)) })),
    ...Object.entries(PLAYER_VENDOR).map(([f, src]) => ({ name: `player/${f}`, data: fs.readFileSync(src) })),
  ];
  for (const dep of dependencyTree(AGENT_DEPENDENCIES)) entries.push(...filesUnder(path.join(ROOT, 'node_modules', dep), `node_modules/${dep}`));
  return tarGz(entries);
}

export function buildLinuxSetup(config) {
  const template = fs.readFileSync(path.join(ROOT, 'linux', 'signage-linux-setup.sh'), 'utf8').replace(/\r\n/g, '\n');
  const payload = buildAgentPackage().toString('base64').replace(/.{1,76}/g, '$&\n');
  return template
    .replace('__SERVER_NAME__', () => String(config.serverName).replace(/[^\w .-]/g, ''))
    .replace('__CONFIG_JSON__', () => JSON.stringify(config, null, 2))
    + payload;
}
