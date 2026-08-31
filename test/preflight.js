/**
 * Pre-flight a deck BEFORE running the plugin in Figma.
 *
 * Reads a `get_metadata` XML dump from the Figma MCP and checks the assumptions
 * code.js relies on: slide count, naming, uniform size, layer counts, clipped
 * nodes, full-bleed backdrops, and — most importantly — that selectSlides()
 * picks the right frames in the right order.
 *
 * This caught a real bug on the Kotak deck before it ever ran: a stray 196x116
 * "spacer" frame at the section's top level would have become slide 42 AND
 * knocked all 41 real slides onto positional ordering, scrambling the deck.
 *
 * Usage:
 *   1. Call get_metadata on the deck's section, save the JSON result
 *   2. node test/preflight.js <that-file.json>
 */
const fs = require('fs');
const path = require('path');
const X = require(path.join(__dirname, '..', 'code.js'));

const file = process.argv[2];
if (!file) {
  console.error('usage: node test/preflight.js <get_metadata-result.json>');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const xml = (Array.isArray(raw) ? raw : [raw]).map(r => r.text || '').join('\n');

const TAG = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z]+="(?:[^"\\]|\\.)*")*)\s*(\/?)>/g;
const ATTR = /([a-zA-Z]+)="((?:[^"\\]|\\.)*)"/g;

function attrs(s) {
  const o = {}; let m; ATTR.lastIndex = 0;
  while ((m = ATTR.exec(s))) o[m[1]] = m[2];
  return o;
}

const stack = [], slides = [];
let m;
while ((m = TAG.exec(xml))) {
  const [, close, tag, attrStr, selfClose] = m;
  if (close) { stack.pop(); continue; }
  const a = attrs(attrStr);
  const node = { tag, id: a.id, name: a.name, x: +a.x, y: +a.y, w: +a.width, h: +a.height, children: [] };
  if (stack.length === 1 && tag === 'frame') slides.push(node);
  if (stack.length >= 1 && stack[stack.length - 1]) stack[stack.length - 1].children.push(node);
  if (!selfClose) stack.push(node);
}

const out = [], warn = [];
out.push('top-level frames: ' + slides.length);

const sizes = {};
slides.forEach(s => { const k = s.w + 'x' + s.h; sizes[k] = (sizes[k] || 0) + 1; });
out.push('sizes: ' + Object.entries(sizes).map(([k, v]) => k + ' ×' + v).join(', '));

const counts = slides.map(s => s.children.length);
const total = counts.reduce((a, b) => a + b, 0);
out.push('direct children (layers, before empties are dropped): ' + total);
out.push('  per slide: min ' + Math.min(...counts) + '  max ' + Math.max(...counts) +
         '  mean ' + (total / slides.length).toFixed(1));

let clipped = 0;
slides.forEach(s => s.children.forEach(c => {
  if (c.x < -0.01 || c.y < -0.01 || c.x + c.w > s.w + 0.01 || c.y + c.h > s.h + 0.01) {
    clipped++;
    out.push('  clipped: "' + s.name + '" / "' + c.name + '" at ' + c.x + ',' + c.y);
  }
}));
out.push('layers hanging outside their slide (exportAsync crops these): ' + clipped);

let full = 0;
slides.forEach(s => {
  const f = s.children.filter(c => X.isFullBleed({ w: c.w, h: c.h }, s.w, s.h));
  if (f.length) full++;
  if (f.length > 1) warn.push('"' + s.name + '" has ' + f.length + ' full-bleed layers');
});
out.push('slides with a full-bleed backdrop: ' + full);

let reordered = 0;
slides.forEach(s => {
  const layers = s.children.map((c, i) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, order: i }));
  if (X.revealOrder(layers, s.w, s.h).map(l => l.id).join() !== layers.map(l => l.id).join()) reordered++;
});
out.push('slides where the proposed reveal order differs from Figma order: ' + reordered + '/' + slides.length);

/* The real check: does selectSlides pick the right frames, in the right order? */
const sel = X.selectSlides(slides.map(s => ({
  name: s.name, absoluteBoundingBox: { x: s.x, y: s.y, width: s.w, height: s.h },
})));
out.push('');
out.push('=== selectSlides() ===');
out.push('kept ' + sel.slides.length + ', skipped ' + sel.skipped.length +
         ', ordered by ' + sel.ordered + ', deck size ' + sel.modal);
sel.skipped.forEach(s => out.push('  skipped "' + s.name + '" (' + s.size + ') — ' + s.why));

if (sel.ordered === 'name') {
  const order = sel.slides.map(f => X.slideNumber(f.name));
  const ok = order.every((n, i) => i === 0 || n > order[i - 1]);
  out.push('slide order strictly ascending: ' + ok);
  if (!ok) warn.push('SLIDE ORDER IS WRONG: ' + order.join(','));
} else {
  warn.push('ordered POSITIONALLY — no slide numbers. Verify the order by eye.');
}

console.log(out.join('\n'));
if (warn.length) console.log('\nWARNINGS\n' + warn.map(w => '  ' + w).join('\n'));
