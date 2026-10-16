// Turns uploaded slide decks into an ordered set of page images, so players
// only ever have to render plain images. PDF goes straight through pdftoppm
// (poppler-utils); PowerPoint/Keynote/ODP go via LibreOffice to PDF first.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const DECK_WIDTH = Number(process.env.DECK_WIDTH) || 1920;

export const OFFICE_EXTENSIONS = ['.ppt', '.pptx', '.pps', '.ppsx', '.odp', '.key'];

async function hasCommand(cmd) {
  try { await run('which', [cmd]); return true; } catch { return false; }
}

export async function converterSupport() {
  const [pdf, office] = await Promise.all([hasCommand('pdftoppm'), hasCommand('soffice')]);
  return { pdf, office: pdf && office };
}

async function officeToPdf(input, workDir) {
  const profile = path.join(workDir, 'lo-profile');
  await run('soffice', [
    `-env:UserInstallation=file://${profile}`,
    '--headless', '--convert-to', 'pdf', '--outdir', workDir, input,
  ], { timeout: 5 * 60_000 });
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
    await run('pdftoppm', ['-png', '-scale-to-x', String(DECK_WIDTH), '-scale-to-y', '-1', pdf, path.join(outDir, 'page')], { timeout: 5 * 60_000 });
    const pages = (await fs.readdir(outDir)).filter((f) => f.endsWith('.png')).sort();
    if (!pages.length) throw new Error('No pages rendered');
    return pages.map((p) => `deck-${deckId}/${p}`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
