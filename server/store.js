// Tiny JSON-file datastore. Good enough for dozens of screens and a few
// thousand media items; swap for SQLite/Postgres when that stops being true.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ settings: {}, screens: [], groups: [], media: [], playlists: [], fileKeys: {} });

export class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = fs.existsSync(file)
      ? { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }
      : EMPTY();
  }

  get settings() { return this.data.settings; }
  get screens() { return this.data.screens; }
  get media() { return this.data.media; }
  get playlists() { return this.data.playlists; }
  get groups() { return this.data.groups; }
  get fileKeys() { return this.data.fileKeys; }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
