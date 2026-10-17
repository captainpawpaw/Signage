// Media processing with external tools, all optional:
//   - slide decks → one PNG per slide (pdftoppm from poppler; LibreOffice for PowerPoint/Keynote/ODP)
//   - videos → H.264/AAC fragmented MP4 (ffmpeg), which every browser plays and
//     which players can stream chunk by chunk, plus a poster frame for the console.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const DECK_WIDTH = Number(process.env.DECK_WIDTH) || 1920;
const VIDEO_MAX_SIZE = Number(process.env.VIDEO_MAX_SIZE) || 1920; // longest side, pixels
// h264 (default) plays everywhere, iPhones included. vp9 gives smaller files
// for Chrome/Edge/Firefox-only screens.
const VIDEO_CODEC = process.env.VIDEO_CODEC === 'vp9' ? 'vp9' : 'h264';

export const OFFICE_EXTENSIONS = ['.ppt', '.pptx', '.pps', '.ppsx', '.odp', '.key'];

const WINDOWS_PATHS = {
  soffice: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'],
};

export const tools = { pdftoppm: null, soffice: null, ffmpeg: null, ffprobe: null };

async function findCommand(name) {
  const env = process.env[`${name.toUpperCase()}_PATH`];
  if (env && existsSync(env)) return env;
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [name]);
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  return (process.platform === 'win32' && WINDOWS_PATHS[name]?.find((p) => existsSync(p))) || null;
}

export async function detectTools() {
  await Promise.all(Object.keys(tools).map(async (name) => { tools[name] = await findCommand(name); }));
  return converterSupport();
}

export function converterSupport() {
  return {
    pdf: Boolean(tools.pdftoppm),
    office: Boolean(tools.pdftoppm && tools.soffice),
    video: Boolean(tools.ffmpeg && tools.ffprobe),
  };
}

async function officeToPdf(input, workDir) {
  const profile = pathToFileURL(path.join(workDir, 'lo-profile')).href;
  await run(tools.soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', workDir, input], { timeout: 5 * 60_000 });
  const pdf = (await fs.readdir(workDir)).find((f) => f.endsWith('.pdf'));
  if (!pdf) throw new Error('LibreOffice produced no PDF');
  return path.join(workDir, pdf);
}

// Returns page paths relative to mediaDir, in order.
export async function convertDeck(input, mediaDir, deckId) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signage-'));
  try {
    const ext = path.extname(input).toLowerCase();
    const pdf = ext === '.pdf' ? input : await officeToPdf(input, workDir);
    const outDir = path.join(mediaDir, `deck-${deckId}`);
    await fs.mkdir(outDir, { recursive: true });
    await run(tools.pdftoppm, ['-png', '-scale-to-x', String(DECK_WIDTH), '-scale-to-y', '-1', pdf, path.join(outDir, 'page')], { timeout: 5 * 60_000 });
    const pages = (await fs.readdir(outDir)).filter((f) => f.endsWith('.png')).sort();
    if (!pages.length) throw new Error('No pages rendered');
    return pages.map((p) => `deck-${deckId}/${p}`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// Re-encodes any video ffmpeg can read (HEVC from iPhones, MOV, AVI…) into a
// fragmented MP4 that plays everywhere and can be fed to MediaSource in pieces.
export async function transcodeVideo(input, mediaDir, id) {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', input]);
  const probe = JSON.parse(stdout);
  const streams = probe.streams || [];
  if (!streams.some((s) => s.codec_type === 'video')) throw new Error('No video stream found');
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  const big = VIDEO_MAX_SIZE > 1920;
  const file = `${id}.mp4`;
  const poster = `${id}.jpg`;
  const out = path.join(mediaDir, file);

  const vp9 = VIDEO_CODEC === 'vp9';
  const videoArgs = vp9
    ? ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level', big ? '5.1' : '4.1', '-pix_fmt', 'yuv420p'];
  const audioArgs = vp9 ? ['-c:a', 'libopus', '-b:a', '128k', '-ac', '2'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];

  await run(tools.ffmpeg, [
    '-y', '-v', 'error', '-i', input,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []),
    ...videoArgs,
    '-vf', `scale=w='min(iw,${VIDEO_MAX_SIZE})':h='min(ih,${VIDEO_MAX_SIZE})':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    '-g', '60', '-keyint_min', '60',
    ...(hasAudio ? audioArgs : []),
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    out,
  ], { timeout: 60 * 60_000, maxBuffer: 16 * 1024 * 1024 });

  const duration = Number(probe.format?.duration) || 0;
  await run(tools.ffmpeg, ['-y', '-v', 'error', '-ss', String(Math.min(1, duration / 2)), '-i', out, '-frames:v', '1', '-vf', 'scale=480:-2', path.join(mediaDir, poster)])
    .catch(() => {});
  const video = vp9 ? (big ? 'vp09.00.51.08' : 'vp09.00.40.08') : (big ? 'avc1.640033' : 'avc1.640029');
  const audio = vp9 ? 'opus' : 'mp4a.40.2';
  return {
    file, poster: existsSync(path.join(mediaDir, poster)) ? poster : null,
    codecs: hasAudio ? `${video}, ${audio}` : video,
    duration, size: (await fs.stat(out)).size,
  };
}
