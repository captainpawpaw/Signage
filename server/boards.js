// Boards: a template (background image or colour) with text, photo and list
// fields whose content changes live, from the console or from a phone through
// a private editor link. Price boards, menus, award ceremonies.
//
// A board is media of type "board" (so playlists, the schedule and Play now
// treat it like any other media):
//   { id, type: 'board', name, background: { mediaId?, color }, aspect: [w, h],
//     fields: [{ id, name, kind: 'text'|'image'|'list', x, y, w, h (0..1 of the board),
//                style: { size, color, align, valign, font, bold, shadow, fit, columns } }],
//     values: { fieldId: text | mediaId | rows },   // what shows when no step is on
//     steps: [{ id, title, values }], step: -1 | index, // prepared steps (ceremonies)
//     edit: { token, pinSalt?, pinHash? } }
import crypto from 'node:crypto';

const FIELD_KINDS = ['text', 'image', 'list'];
const FONTS = ['sans', 'serif', 'mono', 'condensed'];
const MAX_FIELDS = 40;
const MAX_STEPS = 200;
const MAX_ROWS = 100;

const clamp = (n, lo, hi, fallback) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : fallback);
const color = (c, fallback) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : fallback);
const text = (s, max) => String(s ?? '').slice(0, max);

export function cleanFields(fields = [], oldFields = []) {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, MAX_FIELDS).map((f, i) => {
    const kind = FIELD_KINDS.includes(f.kind) ? f.kind : 'text';
    const s = f.style || {};
    const columns = Math.round(clamp(s.columns, 1, 3, 2));
    return {
      id: typeof f.id === 'string' && /^[\w-]{1,40}$/.test(f.id) ? f.id : crypto.randomUUID(),
      name: text(f.name, 60).trim() || `${kind === 'text' ? 'Text' : kind === 'image' ? 'Photo' : 'List'} ${i + 1}`,
      kind,
      x: clamp(f.x, 0, 1, 0.1), y: clamp(f.y, 0, 1, 0.1),
      w: clamp(f.w, 0.01, 1, 0.3), h: clamp(f.h, 0.01, 1, 0.15),
      style: {
        size: clamp(s.size, 1, 50, 8),                 // % of the board's height
        color: color(s.color, '#ffffff'),
        align: ['left', 'center', 'right'].includes(s.align) ? s.align : 'left',
        valign: ['top', 'middle', 'bottom'].includes(s.valign) ? s.valign : 'middle',
        font: FONTS.includes(s.font) ? s.font : 'sans',
        bold: Boolean(s.bold),
        shadow: Boolean(s.shadow),
        fit: s.fit === 'contain' ? 'contain' : 'cover', // photos
        ...(kind === 'list' ? { columns, header: text(s.header, 200) } : {}),
      },
    };
  });
}

// Values for the fields that exist; anything else is dropped.
export function cleanValues(values, fields, mediaOk) {
  const out = {};
  if (!values || typeof values !== 'object') return out;
  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined || v === null) continue;
    if (f.kind === 'text') out[f.id] = text(v, 2000);
    else if (f.kind === 'image') { if (typeof v === 'string' && mediaOk(v)) out[f.id] = v; }
    else if (Array.isArray(v)) {
      out[f.id] = v.slice(0, MAX_ROWS).map((row) => (Array.isArray(row) ? row : [row]).slice(0, f.style.columns).map((c) => text(c, 200)));
    }
  }
  return out;
}

export function cleanSteps(steps, fields, mediaOk) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, MAX_STEPS).map((st, i) => ({
    id: typeof st.id === 'string' && /^[\w-]{1,40}$/.test(st.id) ? st.id : crypto.randomUUID(),
    title: text(st.title, 120).trim() || `Step ${i + 1}`,
    values: cleanValues(st.values, fields, mediaOk),
  }));
}

// What is on now: the board's values, overlaid by the current step.
export function currentValues(board) {
  const step = board.steps?.[board.step];
  return { ...board.values, ...(step?.values || {}) };
}

// Every media id a board shows or may show (background, photos in values and steps).
export function boardMediaIds(board) {
  const ids = new Set();
  if (board.background?.mediaId) ids.add(board.background.mediaId);
  const imageFields = board.fields.filter((f) => f.kind === 'image').map((f) => f.id);
  for (const values of [board.values, ...(board.steps || []).map((s) => s.values)]) {
    for (const fid of imageFields) if (values?.[fid]) ids.add(values[fid]);
  }
  return ids;
}

// ---------- editor PIN ----------
export function setPin(board, pin) {
  if (!pin) { delete board.edit.pinSalt; delete board.edit.pinHash; return; }
  board.edit.pinSalt = crypto.randomBytes(16).toString('hex');
  board.edit.pinHash = crypto.scryptSync(String(pin), board.edit.pinSalt, 32).toString('hex');
}

export function pinOk(board, pin) {
  if (!board.edit?.pinHash) return true;
  if (typeof pin !== 'string' || !pin) return false;
  const a = crypto.scryptSync(pin, board.edit.pinSalt, 32);
  return crypto.timingSafeEqual(a, Buffer.from(board.edit.pinHash, 'hex'));
}

// The board as an editor (console or editor link) sees it.
export function editorView(board, { admin = false } = {}) {
  const { edit, ...rest } = board;
  return { ...rest, hasPin: Boolean(edit?.pinHash), ...(admin ? { editToken: edit?.token || null } : {}) };
}
