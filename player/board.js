// Draws a board: background (picture or colour) with text, photo and list
// fields at their places. Shared by the player, the console's designer and the
// phone editor, so what they show is what the screens show.
//
//   SignageBoard.render(container, board, srcOf) -> { el, layout(), destroy() }
//     board:  { aspect: [w, h], background: { color, image }, fields: [...] }
//     srcOf:  picture item -> URL (players: from their cache; editors: from the server)
// Sizes are in % of the board's height, so a board looks the same on any screen.
(() => {
  'use strict';

  const FONTS = {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "DejaVu Sans", sans-serif',
    serif: 'Georgia, "Times New Roman", "DejaVu Serif", serif',
    mono: 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
    condensed: '"Arial Narrow", "Roboto Condensed", "DejaVu Sans Condensed", sans-serif',
  };
  const JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' };
  const ALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

  function el(tag, style, props) {
    const node = document.createElement(tag);
    Object.assign(node.style, style || {});
    if (props) Object.assign(node, props);
    return node;
  }

  function textField(f) {
    const box = el('div', {
      display: 'flex', alignItems: ALIGN[f.style.valign] || 'center', justifyContent: JUSTIFY[f.style.align] || 'flex-start',
      textAlign: f.style.align, overflow: 'hidden',
    });
    const span = el('span', { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: '1.15', maxWidth: '100%' });
    span.textContent = String(f.value ?? '');
    box.append(span);
    return box;
  }

  function imageField(f, srcOf) {
    const box = el('div', { overflow: 'hidden' });
    const src = f.value && srcOf(f.value);
    if (src) box.append(el('img', { width: '100%', height: '100%', objectFit: f.style.fit || 'cover', display: 'block' }, { src, alt: '' }));
    return box;
  }

  function listField(f) {
    const box = el('div', { overflow: 'hidden', display: 'flex', alignItems: ALIGN[f.style.valign] || 'flex-start' });
    const table = el('table', { width: '100%', borderCollapse: 'collapse', lineHeight: '1.25' });
    const cols = f.style.columns || 2;
    const cell = (tag, text, i, extra = {}) => {
      const align = cols === 1 ? f.style.align : i === 0 ? 'left' : i === cols - 1 ? 'right' : 'center';
      const td = el(tag, { textAlign: align, padding: '0.12em 0.3em', fontWeight: 'inherit', verticalAlign: 'top', ...extra });
      td.textContent = text ?? '';
      return td;
    };
    if (f.style.header) {
      const tr = el('tr');
      f.style.header.split('|').slice(0, cols).forEach((t, i) => tr.append(cell('th', t.trim(), i, { opacity: '0.75', fontSize: '0.8em', borderBottom: '0.06em solid currentColor' })));
      table.append(tr);
    }
    for (const row of Array.isArray(f.value) ? f.value : []) {
      const tr = el('tr');
      for (let i = 0; i < cols; i++) tr.append(cell('td', row[i], i));
      table.append(tr);
    }
    box.append(table);
    return box;
  }

  function render(container, board, srcOf) {
    const [aw, ah] = board.aspect || [16, 9];
    const root = el('div', {
      position: 'absolute', overflow: 'hidden', background: board.background?.color || '#111827',
      left: '0', top: '0',
    }, { className: 'signage-board' });
    const bg = board.background?.image && srcOf(board.background.image);
    if (bg) root.append(el('img', { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover' }, { src: bg, alt: '' }));
    const fitters = [];
    for (const f of board.fields || []) {
      const node = f.kind === 'image' ? imageField(f, srcOf) : f.kind === 'list' ? listField(f) : textField(f);
      Object.assign(node.style, {
        position: 'absolute', left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`,
        boxSizing: 'border-box', color: f.style.color, fontFamily: FONTS[f.style.font] || FONTS.sans,
        fontWeight: f.style.bold ? '700' : '400', fontSize: `${f.style.size}em`,
        fontStretch: f.style.font === 'condensed' ? 'condensed' : 'normal',
        textShadow: f.style.shadow ? '0 0.04em 0.18em rgba(0,0,0,0.75)' : 'none',
      });
      node.dataset.fieldId = f.id;
      root.append(node);
      if (f.kind !== 'image') fitters.push({ node, size: f.style.size });
    }
    container.append(root);

    // Fills the container at the board's shape; text that doesn't fit shrinks.
    function layout() {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (!cw || !ch) return;
      const scale = Math.min(cw / aw, ch / ah);
      const w = aw * scale;
      const h = ah * scale;
      Object.assign(root.style, { width: `${w}px`, height: `${h}px`, left: `${(cw - w) / 2}px`, top: `${(ch - h) / 2}px`, fontSize: `${h / 100}px` });
      for (const { node, size } of fitters) {
        let s = size;
        node.style.fontSize = `${s}em`;
        const inner = node.firstElementChild;
        for (let i = 0; i < 30 && s > size * 0.2; i++) {
          if (inner.scrollWidth <= node.clientWidth + 1 && inner.scrollHeight <= node.clientHeight + 1) break;
          s *= 0.92;
          node.style.fontSize = `${s}em`;
        }
      }
    }
    layout();
    const observer = self.ResizeObserver ? new ResizeObserver(layout) : null;
    observer?.observe(container);
    // Pictures change the layout once they load (sizes are fixed, but fonts may arrive late).
    document.fonts?.ready?.then(layout);
    return { el: root, layout, destroy: () => { observer?.disconnect(); root.remove(); } };
  }

  // Draws the board into a canvas (screenshots): background, photos and text.
  function draw(ctx, root, x, y, w, h) {
    const box = root.getBoundingClientRect();
    const sx = w / box.width;
    const sy = h / box.height;
    for (const node of root.children) {
      const r = node.getBoundingClientRect();
      const rx = x + (r.left - box.left) * sx;
      const ry = y + (r.top - box.top) * sy;
      if (node.tagName === 'IMG') { try { ctx.drawImage(node, rx, ry, r.width * sx, r.height * sy); } catch {} continue; }
      const img = node.querySelector('img');
      if (img) { try { ctx.drawImage(img, rx, ry, r.width * sx, r.height * sy); } catch {} continue; }
      const cs = getComputedStyle(node);
      ctx.fillStyle = cs.color;
      ctx.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * sy}px ${cs.fontFamily}`;
      ctx.textBaseline = 'top';
      // Each rendered line of text, at its place.
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(t);
        const rects = [...range.getClientRects()];
        const text = t.textContent;
        if (rects.length <= 1) {
          const rr = rects[0];
          if (rr) ctx.fillText(text.trim(), x + (rr.left - box.left) * sx, y + (rr.top - box.top) * sy);
          continue;
        }
        // Wrapped: place words by measuring each one.
        let i = 0;
        for (const word of text.split(/(\s+)/)) {
          if (!word.trim()) { i += word.length; continue; }
          range.setStart(t, i);
          range.setEnd(t, i + word.length);
          const wr = range.getClientRects()[0];
          if (wr) ctx.fillText(word, x + (wr.left - box.left) * sx, y + (wr.top - box.top) * sy);
          i += word.length;
        }
      }
    }
  }

  self.SignageBoard = { render, draw };
})();
