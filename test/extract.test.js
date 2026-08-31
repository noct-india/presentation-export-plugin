/**
 * Extractor tests — pure logic only, no Figma.
 *
 * Fixtures are taken from REAL Phase 0 spike output against the Kotak deck, so
 * these pin observed behaviour rather than assumed behaviour. Run: node test/extract.test.js
 */

const assert = require('assert');
const X = require('../code.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('FAIL  ' + name + '\n      ' + e.message); }
}

/* ------------------------------------------------------------------ slug --- */

test('slug normalises names for filenames', () => {
  assert.strictEqual(X.slug('35 · Our approach — divider rows'), '35-our-approach-divider-rows');
  assert.strictEqual(X.slug('Decoration · circle'), 'decoration-circle');
  assert.strictEqual(X.slug('   '), 'layer');
  assert.strictEqual(X.slug(undefined), 'layer');
});

test('slug caps length so filenames stay sane', () => {
  // Slide 41 has a body text node whose name is a full paragraph.
  const long = 'A bank ships creative every single day including cards, loans, deposits';
  assert.ok(X.slug(long).length <= 40);
});

/* ------------------------------------------------------------- colours --- */

test('rgbHex pads single digits', () => {
  assert.strictEqual(X.rgbHex({ r: 0, g: 0, b: 0 }), '#000000');
  assert.strictEqual(X.rgbHex({ r: 1, g: 1, b: 1 }), '#ffffff');
  // #fcfcfc — the Kotak slide background
  assert.strictEqual(X.rgbHex({ r: 252 / 255, g: 252 / 255, b: 252 / 255 }), '#fcfcfc');
});

test('solidFillHex takes the LAST visible solid fill and skips hidden ones', () => {
  assert.strictEqual(X.solidFillHex({ fills: [
    { type: 'SOLID', color: { r: 1, g: 0, b: 0 } },
    { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, visible: false },
    { type: 'SOLID', color: { r: 252 / 255, g: 252 / 255, b: 252 / 255 } },
  ]}), '#fcfcfc');
  assert.strictEqual(X.solidFillHex({ fills: [] }), null);
  assert.strictEqual(X.solidFillHex({ fills: 'mixed' }), null);   // figma.mixed
  assert.strictEqual(X.solidFillHex({}), null);
});

/* -------------------------------------------------------------- anchor --- */
/* Phase 0: exportAsync clips to the parent, so render always won.            */

test('pickAnchor picks render for an ink-cropped text node', () => {
  // Real: slide 8 "Template creation" — export 325.5x37.5, box 329x50, render 325.12x37.13
  const a = X.pickAnchor({ w: 329, h: 50 }, { w: 325.12, h: 37.13 }, 325.5, 37.5);
  assert.strictEqual(a.which, 'render');
  assert.ok(a.ok);
});

test('pickAnchor picks render for a shape clipped by its parent', () => {
  // Real: slides 4 and 41 "Decoration · circle" — export 457x288, box 457x457, render 457x288.
  // This is the case that INVERTED the MCP-era assumption: the export is the
  // visible sliver, not the whole circle.
  const a = X.pickAnchor({ w: 457, h: 457 }, { w: 457, h: 288 }, 457, 288);
  assert.strictEqual(a.which, 'render');
  assert.ok(a.ok);
});

test('pickAnchor prefers render when box and render are identical', () => {
  // A tie proves nothing about which rule is right; it must not silently pick box.
  const a = X.pickAnchor({ w: 198, h: 177 }, { w: 198, h: 177 }, 198, 177);
  assert.strictEqual(a.which, 'render');
});

test('pickAnchor falls back to box when only box matches, still ok', () => {
  const a = X.pickAnchor({ w: 100, h: 30 }, { w: 40, h: 10 }, 100, 30);
  assert.strictEqual(a.which, 'box');
  assert.ok(a.ok);
});

test('pickAnchor flags not-ok when neither rect matches, but still returns one', () => {
  // A layer must still ship — a warned, slightly-off layer beats a missing one.
  const a = X.pickAnchor({ w: 100, h: 30 }, { w: 90, h: 25 }, 500, 500);
  assert.strictEqual(a.ok, false);
  assert.ok(a.rect);
  assert.strictEqual(a.which, 'box');        // the closer of the two
});

test('pickAnchor tolerates half-pixel rounding, rejects beyond tolerance', () => {
  // Export rounds up to whole DEVICE px, so at 2x a match can be 0.5 CSS px small.
  assert.ok(X.pickAnchor(null, { w: 63.9, h: 14.46 }, 64, 14.5).ok);
  assert.strictEqual(X.pickAnchor(null, { w: 60, h: 14 }, 64, 14.5).ok, false);
});

test('pickAnchor handles a missing render rect', () => {
  const a = X.pickAnchor({ w: 100, h: 30 }, null, 100, 30);
  assert.strictEqual(a.which, 'box');
  assert.strictEqual(X.pickAnchor(null, null, 10, 10), null);
});

/* --------------------------------------------------------- full bleed --- */

test('isFullBleed triggers at 85% of slide area, not before', () => {
  assert.ok(X.isFullBleed({ w: 1440, h: 810 }, 1440, 810));
  assert.ok(!X.isFullBleed({ w: 1328, h: 607 }, 1440, 810));   // slide 35 "Steps": ~69%
  assert.ok(!X.isFullBleed(null, 1440, 810));
  assert.ok(!X.isFullBleed({ w: 10, h: 10 }, 0, 0));
});

/* ------------------------------------------------------- reveal order --- */

test('revealOrder puts full-bleed backdrops first', () => {
  const layers = [
    { id: 'tag',  x: 100, y: 100, w: 80,   h: 20,  order: 0 },
    { id: 'art',  x: 0,   y: 0,   w: 1440, h: 810, order: 1 },
  ];
  const out = X.revealOrder(layers, 1440, 810).map(l => l.id);
  // Slide 8's real case: art (child 1) must precede step-tag (child 0),
  // reversing Figma's own order.
  assert.deepStrictEqual(out, ['art', 'tag']);
});

test('revealOrder reads top-to-bottom then left-to-right', () => {
  const layers = [
    { id: 'br', x: 900, y: 400, w: 10, h: 10, order: 0 },
    { id: 'tr', x: 900, y: 0,   w: 10, h: 10, order: 1 },
    { id: 'tl', x: 0,   y: 0,   w: 10, h: 10, order: 2 },
    { id: 'bl', x: 0,   y: 400, w: 10, h: 10, order: 3 },
  ];
  assert.deepStrictEqual(
    X.revealOrder(layers, 1440, 810).map(l => l.id),
    ['tl', 'tr', 'bl', 'br']
  );
});

test('revealOrder bands near-level items into one row', () => {
  // 8px apart is the same visual row and must sort by x, not by y.
  const layers = [
    { id: 'right', x: 500, y: 100, w: 10, h: 10, order: 0 },
    { id: 'left',  x: 100, y: 108, w: 10, h: 10, order: 1 },
  ];
  assert.deepStrictEqual(
    X.revealOrder(layers, 1440, 810).map(l => l.id),
    ['left', 'right']
  );
});

test('revealOrder is stable on a genuine tie', () => {
  const layers = [
    { id: 'second', x: 10, y: 10, w: 5, h: 5, order: 1 },
    { id: 'first',  x: 10, y: 10, w: 5, h: 5, order: 0 },
  ];
  assert.deepStrictEqual(
    X.revealOrder(layers, 1440, 810).map(l => l.id),
    ['first', 'second']
  );
});

test('revealOrder does not mutate its input', () => {
  const layers = [
    { id: 'b', x: 100, y: 0, w: 5, h: 5, order: 0 },
    { id: 'a', x: 0,   y: 0, w: 5, h: 5, order: 1 },
  ];
  X.revealOrder(layers, 1440, 810);
  assert.deepStrictEqual(layers.map(l => l.id), ['b', 'a']);
});

/* ------------------------------------------------------ slide numbers --- */

test('slideNumber reads the leading number from a deck name', () => {
  assert.strictEqual(X.slideNumber('35 · Our approach — divider rows'), 35);
  assert.strictEqual(X.slideNumber('04 · The challenge'), 4);
  assert.strictEqual(X.slideNumber('41 · Hundreds of banners. One bank.'), 41);
  assert.strictEqual(X.slideNumber('Cover'), null);
  assert.strictEqual(X.slideNumber(undefined), null);
});

test('slideNumber does not read a number out of the middle of a name', () => {
  assert.strictEqual(X.slideNumber('Slide 12'), null);
});

/* ------------------------------------------------------ internal urls --- */

test('isInternalUrl flags the real leak found on slide 41', () => {
  assert.ok(X.isInternalUrl(
    'https://docs.google.com/presentation/d/1xl_302jc7mJUoiFJT-Qi33iJ_picpXjV-6vJAmdlwrE/edit?slide=id.g3f'
  ));
});

test('isInternalUrl flags the other internal hosts and leaves client links alone', () => {
  assert.ok(X.isInternalUrl('https://www.figma.com/file/abc'));
  assert.ok(X.isInternalUrl('https://drive.google.com/x'));
  assert.ok(X.isInternalUrl('http://localhost:3000/'));
  assert.ok(!X.isInternalUrl('https://kotak.com/811'));
  assert.ok(!X.isInternalUrl('https://www.kotak.com/en/personal-banking.html'));
  assert.ok(!X.isInternalUrl(''));
});

test('isInternalUrl does not match a lookalike client domain', () => {
  // notion.so is internal; mynotion.something is not. The check requires a
  // host boundary, so a substring alone must not trip it.
  assert.ok(!X.isInternalUrl('https://notionery.com/page'));
});

/* ---------------------------------------------------------- reactions --- */

test('urlActions reads the modern actions array', () => {
  assert.deepStrictEqual(
    X.urlActions({ reactions: [{ actions: [{ type: 'URL', url: 'https://a.com' }] }] }),
    ['https://a.com']
  );
});

test('urlActions falls back to the deprecated singular action', () => {
  assert.deepStrictEqual(
    X.urlActions({ reactions: [{ action: { type: 'URL', url: 'https://old.com' } }] }),
    ['https://old.com']
  );
});

test('urlActions recurses into CONDITIONAL blocks', () => {
  assert.deepStrictEqual(X.urlActions({ reactions: [{ actions: [
    { type: 'CONDITIONAL', conditionalBlocks: [
      { actions: [{ type: 'URL', url: 'https://cond.com' }] },
      { actions: [{ type: 'BACK' }] },
    ]},
  ]}]}), ['https://cond.com']);
});

test('urlActions ignores non-URL actions and empty reactions', () => {
  assert.deepStrictEqual(X.urlActions({ reactions: [{ actions: [
    { type: 'NODE' }, { type: 'BACK' }, { type: 'URL' },     // URL with no url
  ]}]}), []);
  assert.deepStrictEqual(X.urlActions({ reactions: [] }), []);
  assert.deepStrictEqual(X.urlActions({}), []);
});

/* -------------------------------------------------------- text links --- */

function textNode(characters, segments) {
  return {
    type: 'TEXT',
    characters,
    getStyledTextSegments: () => segments,
  };
}

test('textLinks reads a whole-node hyperlink and marks it not partial', () => {
  // Real: slide 41 "master template" — 15 chars, range [0,15].
  const out = X.textLinks(textNode('master template', [
    { characters: 'master template', start: 0, end: 15,
      hyperlink: { type: 'URL', value: 'https://docs.google.com/presentation/d/1xl' } },
  ]));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].partial, false);
  assert.strictEqual(out[0].linkType, 'URL');
});

test('textLinks marks a partial range, since Figma gives no per-character rect', () => {
  const out = X.textLinks(textNode('see the terms here', [
    { characters: 'see the ', start: 0, end: 8, hyperlink: null },
    { characters: 'terms', start: 8, end: 13, hyperlink: { type: 'URL', value: 'https://k.com/t' } },
    { characters: ' here', start: 13, end: 18, hyperlink: null },
  ]));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].partial, true);
});

test('textLinks keeps NODE targets distinct from URL targets', () => {
  const out = X.textLinks(textNode('jump', [
    { characters: 'jump', start: 0, end: 4, hyperlink: { type: 'NODE', value: '227:69' } },
  ]));
  assert.strictEqual(out[0].linkType, 'NODE');
  assert.strictEqual(out[0].value, '227:69');
});

test('textLinks survives a node that throws on mixed styling', () => {
  assert.deepStrictEqual(X.textLinks({
    type: 'TEXT', characters: 'x',
    getStyledTextSegments: () => { throw new Error('mixed'); },
  }), []);
  assert.deepStrictEqual(X.textLinks({ type: 'FRAME' }), []);
  assert.deepStrictEqual(X.textLinks(null), []);
});

/* ------------------------------------------------------------- video --- */

test('videoFills finds a video fill and records what pairing needs', () => {
  const out = X.videoFills({ fills: [
    { type: 'IMAGE', imageHash: 'aaa' },
    { type: 'VIDEO', videoHash: 'bbb', scaleMode: 'FILL' },
  ]});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].scaleMode, 'FILL');
  assert.strictEqual(out[0].videoHash, 'bbb');   // dead-end string, kept for pairing only
});

test('videoFills skips hidden video fills and non-fill nodes', () => {
  assert.deepStrictEqual(X.videoFills({ fills: [
    { type: 'VIDEO', videoHash: 'b', visible: false },
  ]}), []);
  assert.deepStrictEqual(X.videoFills({ fills: 'mixed' }), []);
  assert.deepStrictEqual(X.videoFills({}), []);
});

test('an animated GIF is an IMAGE fill, not a video — it must not appear as a video slot', () => {
  // There is no gifHash in the Plugin API; GIFs are plain imageHash image fills
  // whose bytes come back whole from Image.getBytesAsync.
  assert.deepStrictEqual(X.videoFills({ fills: [{ type: 'IMAGE', imageHash: 'gif' }] }), []);
});

/* -------------------------------------------------------------- rects --- */

test('rectOf converts absolute coordinates to slide-relative', () => {
  assert.deepStrictEqual(
    X.rectOf({ x: 1100, y: 250, width: 457, height: 288 }, 1000, 200),
    { x: 100, y: 50, w: 457, h: 288 }
  );
});

test('rectOf keeps a negative offset for a node hanging above its frame', () => {
  // Slide 4's circle sits at y = -169 relative to the slide.
  assert.deepStrictEqual(
    X.rectOf({ x: 1000, y: 31, width: 457, height: 457 }, 1000, 200),
    { x: 0, y: -169, w: 457, h: 457 }
  );
});

test('rectOf passes through null', () => {
  assert.strictEqual(X.rectOf(null, 0, 0), null);
});

/* ------------------------------------------------- slide selection --- */
/* Regression cover for the stray-frame bug the pre-flight found: the real
   Kotak section carries a 196x116 frame named "spacer" beside 41 slides.      */

const F = (name, x, y, w = 1440, h = 810) =>
  ({ name, absoluteBoundingBox: { x, y, width: w, height: h } });

/** The real deck: 41 numbered 1440x810 slides on a grid, plus one stray. */
function kotakSection() {
  const out = [];
  for (let i = 1; i <= 41; i++) {
    const col = (i - 1) % 5, row = Math.floor((i - 1) / 5);
    out.push(F(String(i).padStart(2, '0') + ' · Slide ' + i, col * 1580, row * 950));
  }
  out.push(F('spacer', 7000, 9000, 196, 116));
  return out;
}

test('modalSize finds the deck size and is not fooled by a stray', () => {
  assert.strictEqual(X.modalSize(kotakSection()), '1440x810');
  assert.strictEqual(X.modalSize([]), null);
});

test('selectSlides drops the stray spacer frame and reports it', () => {
  const r = X.selectSlides(kotakSection());
  assert.strictEqual(r.slides.length, 41);
  assert.strictEqual(r.skipped.length, 1);
  assert.strictEqual(r.skipped[0].name, 'spacer');
  assert.strictEqual(r.skipped[0].size, '196x116');
});

test('one stray must NOT knock the whole deck onto positional ordering', () => {
  // The original bug: the name-sort only fired when EVERY frame was numbered,
  // so the unnumbered "spacer" silently disabled it for all 41 real slides.
  const r = X.selectSlides(kotakSection());
  assert.strictEqual(r.ordered, 'name');
  assert.deepStrictEqual(r.slides.map(f => X.slideNumber(f.name)),
    Array.from({ length: 41 }, (_, i) => i + 1));
});

test('positional fallback reads ACROSS a grid, not down it', () => {
  // x-primary sorting on a 5-wide grid yields 1, 6, 11, 16 … and scrambles the deck.
  const grid = [];
  for (let i = 1; i <= 10; i++) {
    const col = (i - 1) % 5, row = Math.floor((i - 1) / 5);
    grid.push(F('Slide ' + i, col * 1580, row * 950));   // unnumbered -> positional
  }
  const r = X.selectSlides(grid);
  assert.strictEqual(r.ordered, 'position');
  assert.deepStrictEqual(r.slides.map(f => f.name),
    ['Slide 1','Slide 2','Slide 3','Slide 4','Slide 5',
     'Slide 6','Slide 7','Slide 8','Slide 9','Slide 10']);
});

test('readingOrder bands rows even when frames sit slightly off-baseline', () => {
  const r = X.readingOrder([
    F('b', 1580, 12), F('a', 0, 0), F('c', 3160, -8),
  ]);
  assert.deepStrictEqual(r.map(f => f.name), ['a', 'b', 'c']);
});

test('selectSlides keeps every frame when they are all the same size', () => {
  const r = X.selectSlides([F('01 · a', 0, 0), F('02 · b', 1580, 0)]);
  assert.strictEqual(r.slides.length, 2);
  assert.strictEqual(r.skipped.length, 0);
});

test('selectSlides survives an empty pool', () => {
  const r = X.selectSlides([]);
  assert.deepStrictEqual(r.slides, []);
  assert.strictEqual(r.ordered, 'position');
});

test('selectSlides ignores a frame with no bounding box', () => {
  const r = X.selectSlides([F('01 · a', 0, 0), { name: 'ghost' }]);
  assert.strictEqual(r.slides.length, 1);
});

/* ------------------------------------------------------------ census --- */
/* "No videos found" must not be confused with "no video present". The census
   reports what videoFills structurally cannot see.                          */

test('census counts node and fill types', () => {
  const acc = X.newCensus();
  X.census({ id: '1', name: 'a', type: 'RECTANGLE', fills: [{ type: 'SOLID' }] }, acc);
  X.census({ id: '2', name: 'b', type: 'TEXT', fills: [{ type: 'SOLID' }] }, acc);
  assert.strictEqual(acc.types.RECTANGLE, 1);
  assert.strictEqual(acc.fills.SOLID, 2);
});

test('census records a VIDEO fill as a media node', () => {
  const acc = X.newCensus();
  X.census({ id: '3', name: 'clip', type: 'RECTANGLE', fills: [{ type: 'VIDEO', videoHash: 'vh' }] }, acc);
  assert.strictEqual(acc.mediaNodes.length, 1);
  assert.strictEqual(acc.mediaNodes[0].fill, 'VIDEO');
  assert.strictEqual(acc.mediaNodes[0].hash, 'vh');
});

test('census records IMAGE fills too — a GIF hides there, not under a gifHash', () => {
  const acc = X.newCensus();
  X.census({ id: '4', name: 'gif', type: 'RECTANGLE', fills: [{ type: 'IMAGE', imageHash: 'ih' }] }, acc);
  assert.strictEqual(acc.mediaNodes[0].fill, 'IMAGE');
});

test('census flags figma.mixed — exactly the blind spot videoFills has', () => {
  const acc = X.newCensus();
  const MIXED = Symbol('figma.mixed');
  X.census({ id: '5', name: 'mixed', type: 'TEXT', fills: MIXED }, acc);
  assert.strictEqual(acc.fills.MIXED, 1);
  assert.strictEqual(acc.mixedNodes.length, 1);
  assert.deepStrictEqual(X.videoFills({ fills: MIXED }), []);   // the point
});

test('census counts HIDDEN media — a hidden video is still a video', () => {
  const acc = X.newCensus();
  const fills = [{ type: 'VIDEO', videoHash: 'x', visible: false }];
  X.census({ id: '7', name: 'v', type: 'RECTANGLE', fills }, acc);
  assert.strictEqual(acc.mediaNodes.length, 1);
  assert.strictEqual(acc.mediaNodes[0].visible, false);
  assert.deepStrictEqual(X.videoFills({ fills }), []);
});

test('census tolerates a node with no fills property', () => {
  const acc = X.newCensus();
  X.census({ id: '6', name: 'grp', type: 'GROUP' }, acc);
  assert.strictEqual(acc.types.GROUP, 1);
  assert.deepStrictEqual(acc.fills, {});
});

/* ------------------------------------------------------ describeChild --- */

const node = (o) => Object.assign({
  id: 'n1', name: 'thing', type: 'FRAME', visible: true,
  absoluteBoundingBox: { x: 100, y: 100, width: 200, height: 50 },
  absoluteRenderBounds: { x: 100, y: 100, width: 200, height: 50 },
}, o);

test('describeChild converts to slide-relative geometry', () => {
  const d = X.describeChild(node({}), 0, 100, 100, 1440, 810);
  assert.deepStrictEqual([d.x, d.y, d.w, d.h], [0, 0, 200, 50]);
  assert.strictEqual(d.order, 0);
  assert.strictEqual(d.slug, 'thing');
});

test('describeChild returns null for hidden nodes and nodes that render nothing', () => {
  assert.strictEqual(X.describeChild(node({ visible: false }), 0, 0, 0, 1440, 810), null);
  assert.strictEqual(X.describeChild(node({
    absoluteBoundingBox: null, absoluteRenderBounds: null,
  }), 0, 0, 0, 1440, 810), null);
  assert.strictEqual(X.describeChild(null, 0, 0, 0, 1440, 810), null);
});

test('describeChild prefers render bounds as the anchor', () => {
  // The slide-4 circle: box 457x457, render 457x288. exportAsync gives 457x288.
  const d = X.describeChild(node({
    absoluteBoundingBox: { x: 45, y: -169, width: 457, height: 457 },
    absoluteRenderBounds: { x: 45, y: 0, width: 457, height: 288 },
  }), 0, 0, 0, 1440, 810);
  assert.deepStrictEqual([d.w, d.h], [457, 288]);
  assert.strictEqual(d.y, 0);
});

test('describeChild counts only VISIBLE children in kids', () => {
  const d = X.describeChild(node({ children: [
    { visible: true }, { visible: false }, {},
  ]}), 0, 0, 0, 1440, 810);
  assert.strictEqual(d.kids, 2);
});

test('describeChild reports kids 0 for a leaf', () => {
  assert.strictEqual(X.describeChild(node({ type: 'TEXT' }), 0, 0, 0, 1440, 810).kids, 0);
});

test('describeChild flags a full-bleed layer', () => {
  const d = X.describeChild(node({
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 810 },
    absoluteRenderBounds: { x: 0, y: 0, width: 1440, height: 810 },
  }), 0, 0, 0, 1440, 810);
  assert.strictEqual(d.full, true);
});

/* -------------------------------------------------------- sniffImage --- */
/* An animated GIF exported through exportAsync freezes on frame 1. These pin
   the detection that stops that happening silently.                          */

const bytesOf = (...parts) => {
  const out = [];
  parts.forEach(p => typeof p === 'string'
    ? out.push(...[...p].map(c => c.charCodeAt(0)))
    : out.push(...p));
  return out;
};
const pad = n => new Array(n).fill(0);

test('sniffImage detects an ANIMATED gif by counting graphic control extensions', () => {
  // Two GCE blocks (0x21 0xF9) == more than one frame.
  const gif = bytesOf('GIF89a', pad(6), [0x21, 0xF9], pad(8), [0x21, 0xF9], pad(8));
  assert.deepStrictEqual(X.sniffImage(gif), { format: 'gif', animated: true });
});

test('sniffImage calls a single-frame gif static', () => {
  const gif = bytesOf('GIF89a', pad(6), [0x21, 0xF9], pad(16));
  assert.deepStrictEqual(X.sniffImage(gif), { format: 'gif', animated: false });
});

test('sniffImage detects APNG via an acTL chunk before IDAT', () => {
  const apng = bytesOf([0x89], 'PNG', [0x0D, 0x0A, 0x1A, 0x0A], pad(4), 'acTL', pad(8), 'IDAT', pad(4));
  assert.deepStrictEqual(X.sniffImage(apng), { format: 'apng', animated: true });
});

test('sniffImage does not mistake a plain PNG for an APNG', () => {
  const png = bytesOf([0x89], 'PNG', [0x0D, 0x0A, 0x1A, 0x0A], pad(4), 'IHDR', pad(8), 'IDAT', pad(20));
  assert.deepStrictEqual(X.sniffImage(png), { format: 'png', animated: false });
});

test('sniffImage ignores an acTL appearing AFTER IDAT — that is not an APNG', () => {
  const png = bytesOf([0x89], 'PNG', [0x0D, 0x0A, 0x1A, 0x0A], pad(4), 'IDAT', pad(8), 'acTL', pad(4));
  assert.strictEqual(X.sniffImage(png).animated, false);
});

test('sniffImage detects an animated WebP by its ANIM chunk', () => {
  const webp = bytesOf('RIFF', pad(4), 'WEBP', 'VP8X', pad(8), 'ANIM', pad(8));
  assert.deepStrictEqual(X.sniffImage(webp), { format: 'webp', animated: true });
});

test('sniffImage calls a still WebP static', () => {
  const webp = bytesOf('RIFF', pad(4), 'WEBP', 'VP8 ', pad(32));
  assert.deepStrictEqual(X.sniffImage(webp), { format: 'webp', animated: false });
});

test('sniffImage recognises JPEG, and never claims it animates', () => {
  assert.deepStrictEqual(X.sniffImage(bytesOf([0xFF, 0xD8, 0xFF, 0xE0], pad(16))),
    { format: 'jpeg', animated: false });
});

test('sniffImage is safe on empty, short and unknown input', () => {
  assert.deepStrictEqual(X.sniffImage([]), { format: 'unknown', animated: false });
  assert.deepStrictEqual(X.sniffImage(null), { format: 'unknown', animated: false });
  assert.deepStrictEqual(X.sniffImage([1, 2, 3]), { format: 'unknown', animated: false });
  assert.deepStrictEqual(X.sniffImage(pad(64)), { format: 'unknown', animated: false });
});

/* ------------------------------------------- links on hidden layers --- */
/* A designer parks a hyperlink on a layer or section that is switched off. The
   sweep used to `continue` on any invisible node, so the link vanished from the
   payload with no warning — it was not in the review table either, so its
   absence was invisible. Links now ship regardless and carry `hidden`. */

/**
 * Stand-in for a Figma node tree.
 *
 * ⚠️ THE CRITICAL DETAIL, and the one an earlier version of this helper got
 * wrong: Figma returns null for `absoluteRenderBounds` AND `absoluteBoundingBox`
 * on any node that is invisible OR has an invisible ancestor. Both describe what
 * is RENDERED. A mock that kept the bounding box alive made hidden links look
 * fully working while the real plugin produced rect-less links that the renderer
 * silently dropped — the bug shipped twice behind a green suite.
 *
 * Layout geometry survives on hidden nodes and is modelled here: x/y relative to
 * the parent, width/height, and absoluteTransform.
 */
function tree(spec, parentDead) {
  const dead = spec.visible === false || !!parentDead;      // hidden, or under something hidden
  const b = spec.box || null;
  const node = {
    id: spec.id, name: spec.name || spec.id, type: spec.type || 'FRAME',
    visible: spec.visible !== false,
    // Both null once anything at or above this node is switched off.
    absoluteBoundingBox: dead ? null : b,
    absoluteRenderBounds: dead ? null : (spec.render === undefined ? b : spec.render),
    // Layout survives regardless — this is what geometricRect() reads.
    x: b ? b.x - (spec.parentX || 0) : 0,
    y: b ? b.y - (spec.parentY || 0) : 0,
    width: b ? b.width : 0,
    height: b ? b.height : 0,
    absoluteTransform: b && !spec.noTransform ? [[1, 0, b.x], [0, 1, b.y]] : null,
    isMask: !!spec.isMask,
    fills: spec.fills || [],
    // Corner rounding, copied through only when the spec sets it — an absent
    // property must stay absent, since that is what cornerRadii() branches on.
    cornerRadius: spec.cornerRadius,
    topLeftRadius: spec.topLeftRadius, topRightRadius: spec.topRightRadius,
    bottomRightRadius: spec.bottomRightRadius, bottomLeftRadius: spec.bottomLeftRadius,
    parent: null,
  };
  if (spec.characters !== undefined) {
    node.characters = spec.characters;
    node.getStyledTextSegments = () => spec.segments || [];
  }
  if (spec.reactions) node.reactions = spec.reactions;
  node.children = (spec.children || []).map(c => {
    const k = tree(c, dead); k.parent = node; return k;
  });
  return node;
}
// Figma's rects carry x/y/width/height — nothing else. rectOf() reads exactly those.
const box = (x, y, width, height) => ({ x, y, width, height });
const linkSeg = (url, chars) => [{ characters: chars, start: 0, end: chars.length,
                                   hyperlink: { type: 'URL', value: url } }];

/* A slide holding a HIDDEN section, whose text child is itself visible and
   carries the link — the shape the designer actually has in the file. */
const slideWithHiddenLink = tree({
  id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'visibleText', type: 'TEXT', box: box(120, 200, 300, 60),
      characters: 'visible link', segments: linkSeg('https://example.com/visible', 'visible link') },
    { id: 'hiddenSection', type: 'SECTION', visible: false, box: box(700, 500, 240, 80),
      render: null, children: [
        { id: 'hiddenText', type: 'TEXT', box: box(700, 500, 240, 80), render: null,
          characters: 'hidden link', segments: linkSeg('https://example.com/hidden', 'hidden link') },
      ] },
  ],
});
const kid = (root, id) => {
  let hit = null;
  (function walk(n) { if (n.id === id) hit = n; (n.children || []).forEach(walk); })(root);
  return hit;
};

test('hiddenWithin sees a switched-off ANCESTOR, not just the node itself', () => {
  const f = slideWithHiddenLink;
  assert.strictEqual(X.hiddenWithin(kid(f, 'visibleText'), f), false);
  // The text node is visible; the section above it is not.
  assert.strictEqual(kid(f, 'hiddenText').visible, true);
  assert.strictEqual(X.hiddenWithin(kid(f, 'hiddenText'), f), true);
});

test('hiddenWithin stops at the slide frame and at the page', () => {
  const f = tree({ id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810),
                   children: [{ id: 'a', type: 'TEXT', box: box(0, 0, 10, 10) }] });
  f.parent = { type: 'PAGE', visible: false };     // must never be consulted
  assert.strictEqual(X.hiddenWithin(kid(f, 'a'), f), false);
  assert.strictEqual(X.hiddenWithin(f, f), false);
});

test('a hyperlink inside an INVISIBLE parent is extracted, tagged and placed', () => {
  const f = slideWithHiddenLink;
  const out = X.linksForNode(kid(f, 'hiddenText'), f, 0, 0);
  assert.strictEqual(out.length, 1, 'the link must survive the hidden ancestor');
  assert.strictEqual(out[0].value, 'https://example.com/hidden');
  assert.strictEqual(out[0].hidden, true, 'and be tagged as coming from a hidden layer');
  // absoluteRenderBounds is null when nothing renders — the bounding box is the
  // hotspot, so it still lands over the right part of the slide.
  assert.deepStrictEqual(out[0].rect, { x: 700, y: 500, w: 240, h: 80 });
});

test('a link on a node that is ITSELF invisible is extracted too', () => {
  const f = tree({ id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 't', type: 'TEXT', visible: false, box: box(40, 60, 100, 20), render: null,
      characters: 'off', segments: linkSeg('https://example.com/off', 'off') },
  ]});
  const out = X.linksForNode(kid(f, 't'), f, 0, 0);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].hidden, true);
  assert.deepStrictEqual(out[0].rect, { x: 40, y: 60, w: 100, h: 20 });
});

test('VISIBLE links are unchanged — same rect, same flags, hidden:false', () => {
  const f = slideWithHiddenLink;
  const out = X.linksForNode(kid(f, 'visibleText'), f, 0, 0);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].hidden, false);
  assert.strictEqual(out[0].value, 'https://example.com/visible');
  assert.strictEqual(out[0].linkType, 'URL');
  assert.strictEqual(out[0].internal, false);
  assert.strictEqual(out[0].nodeId, 'visibleText');
  assert.deepStrictEqual(out[0].rect, { x: 120, y: 200, w: 300, h: 60 });
});

test('a visible node still anchors on RENDER bounds, hidden falls back to box', () => {
  // Render-first is the Phase 0 rule and must not be disturbed by this change.
  const f = tree({ id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'v', type: 'TEXT', box: box(0, 0, 500, 500), render: box(10, 20, 30, 40),
      characters: 'x', segments: linkSeg('https://example.com/v', 'x') },
  ]});
  assert.deepStrictEqual(X.linksForNode(kid(f, 'v'), f, 0, 0)[0].rect,
    { x: 10, y: 20, w: 30, h: 40 });
});

test('an internal link on a hidden layer is still flagged internal', () => {
  // The two tags are independent: hidden says "nothing is drawn there",
  // internal says "this must not reach a client". Both can be true.
  const f = tree({ id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 's', type: 'SECTION', visible: false, box: box(0, 0, 100, 100), render: null, children: [
      { id: 't', type: 'TEXT', box: box(0, 0, 100, 100), render: null, characters: 'doc',
        segments: linkSeg('https://docs.google.com/presentation/d/abc/edit', 'doc') },
    ]},
  ]});
  const out = X.linksForNode(kid(f, 't'), f, 0, 0);
  assert.strictEqual(out[0].hidden, true);
  assert.strictEqual(out[0].internal, true);
});

/* ⚠️ THE ACTUAL BUG. Figma nulls BOTH boxes on a hidden node, so the rect came
   out null, and overlaysFor() drops a rect-less link — the hyperlink reached the
   payload and the review table but never became an <a>, which is precisely what
   "no clickable hotspot appears" looked like. geometricRect() derives the
   position from layout, which survives being hidden. */

test('a hidden node reports NULL boxes — the condition that broke the hotspot', () => {
  const f = slideWithHiddenLink;
  const t = kid(f, 'hiddenText');
  assert.strictEqual(t.absoluteRenderBounds, null, 'render bounds die when a parent is hidden');
  assert.strictEqual(t.absoluteBoundingBox, null, 'and so does the bounding box — both are render');
  assert.strictEqual(X.rectOf(t.absoluteRenderBounds || t.absoluteBoundingBox, 0, 0), null,
    'so the old rect expression could only ever produce null');
});

test('geometricRect recovers the rect from absoluteTransform when both boxes are null', () => {
  const f = slideWithHiddenLink;
  assert.deepStrictEqual(X.geometricRect(kid(f, 'hiddenText'), 0, 0, f),
    { x: 700, y: 500, w: 240, h: 80 });
});

test('geometricRect falls back to summing the parent chain without a transform', () => {
  // Frame at 0,0; group at 100,100; text at +50,+60 inside it -> 150,160 absolute.
  const f = tree({ id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810), noTransform: true,
    children: [
      { id: 'g', type: 'GROUP', visible: false, box: box(100, 100, 400, 300), noTransform: true,
        children: [
          { id: 't', type: 'TEXT', box: box(150, 160, 120, 40), parentX: 100, parentY: 100,
            noTransform: true, characters: 'x', segments: linkSeg('https://example.com/x', 'x') },
        ]},
    ]});
  assert.strictEqual(kid(f, 't').absoluteTransform, null, 'no transform available');
  assert.deepStrictEqual(X.geometricRect(kid(f, 't'), 0, 0, f),
    { x: 150, y: 160, w: 120, h: 40 });
});

test('geometricRect gives up cleanly when there is no geometry at all', () => {
  const f = tree({ id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 't', type: 'TEXT', visible: false, box: null, characters: 'x',
      segments: linkSeg('https://example.com/x', 'x') },
  ]});
  const t = kid(f, 't');
  t.width = undefined; t.height = undefined;
  assert.strictEqual(X.geometricRect(t, 0, 0, f), null);
  // Still no crash, and the link still ships — run() warns that it cannot be placed.
  assert.strictEqual(X.linksForNode(t, f, 0, 0).length, 1);
});

test('a VISIBLE link never reaches geometricRect — render-first is untouched', () => {
  const f = tree({ id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'v', type: 'TEXT', box: box(0, 0, 500, 500), render: box(10, 20, 30, 40),
      characters: 'x', segments: linkSeg('https://example.com/v', 'x') },
  ]});
  const t = kid(f, 'v');
  // Poison the geometric path: if it were consulted, the rect would be wrong.
  t.absoluteTransform = [[1, 0, 999], [0, 1, 999]];
  t.width = 999; t.height = 999;
  assert.deepStrictEqual(X.linksForNode(t, f, 0, 0)[0].rect, { x: 10, y: 20, w: 30, h: 40 });
});

/* ⚠️ END-TO-END THROUGH THE REAL SWEEP.
   The earlier tests called linksForNode() directly, so they proved the leaf
   worked and never proved everyNode() reaches a hidden subtree or that
   planSlide() collects what it finds. planSlide touches no figma.* API, so the
   whole path runs offline — this is the test that would have caught the bug. */

test('planSlide extracts a link from inside a hidden parent, with a usable rect', () => {
  const f = slideWithHiddenLink;
  f.name = '07 · Hidden link slide';
  const out = X.planSlide(f, 0);

  const hidden = out.links.find(l => /hidden/.test(l.value));
  assert.ok(hidden, 'the hidden link must survive the whole sweep');
  assert.strictEqual(hidden.hidden, true);
  assert.deepStrictEqual(hidden.rect, { x: 700, y: 500, w: 240, h: 80 },
    'and carry geometry, or overlaysFor() drops it and no <a> is ever written');

  // The hidden content must still not be PAINTED — no layer for it.
  assert.ok(!out.layers.some(l => l.id === 'hiddenSection'),
    'a hidden section is not exported as a layer');
  assert.ok(!out.rawOrder.includes('hiddenSection'));
});

test('planSlide keeps the visible link on the same slide exactly as before', () => {
  const out = X.planSlide(slideWithHiddenLink, 0);
  const visible = out.links.find(l => /visible/.test(l.value));
  assert.strictEqual(visible.hidden, false);
  assert.deepStrictEqual(visible.rect, { x: 120, y: 200, w: 300, h: 60 });
  assert.strictEqual(out.links.length, 2, 'both links, no duplicates');
});

test('everyNode descends INTO a hidden subtree rather than pruning it', () => {
  const ids = X.everyNode(slideWithHiddenLink).map(n => n.id);
  assert.ok(ids.includes('hiddenSection'), 'the hidden container itself');
  assert.ok(ids.includes('hiddenText'), 'and its children — pruning here loses the link');
});

test('a link nested several levels inside a hidden parent still resolves', () => {
  // Depth is not special-cased anywhere; this pins that.
  const f = tree({ id: 'frame', type: 'FRAME', name: '01 · Deep', box: box(0, 0, 1440, 810),
    children: [
      { id: 'a', type: 'FRAME', visible: false, box: box(0, 0, 800, 600), children: [
        { id: 'b', type: 'GROUP', box: box(0, 0, 800, 600), children: [
          { id: 'c', type: 'FRAME', box: box(0, 0, 800, 600), children: [
            { id: 'd', type: 'TEXT', box: box(310, 420, 180, 24), characters: 'deep',
              segments: linkSeg('https://example.com/deep', 'deep') },
          ]},
        ]},
      ]},
    ]});
  const out = X.planSlide(f, 0);
  assert.strictEqual(out.links.length, 1);
  assert.strictEqual(out.links[0].hidden, true);
  assert.deepStrictEqual(out.links[0].rect, { x: 310, y: 420, w: 180, h: 24 });
});

test('a slide frame not at the canvas origin still gets frame-relative rects', () => {
  // The deck's frames sit anywhere on the page; rects must be slide-local.
  const f = tree({ id: 'frame', type: 'FRAME', name: '02 · Offset', box: box(5000, 3000, 1440, 810),
    children: [
      { id: 'g', type: 'GROUP', visible: false, box: box(5100, 3200, 200, 50), children: [
        { id: 't', type: 'TEXT', box: box(5100, 3200, 200, 50), characters: 'x',
          segments: linkSeg('https://example.com/x', 'x') },
      ]},
    ]});
  const out = X.planSlide(f, 0);
  assert.deepStrictEqual(out.links[0].rect, { x: 100, y: 200, w: 200, h: 50 },
    'absolute 5100,3200 minus the frame origin 5000,3000');
});

/* ⚠️ THE SILENT CATCH.
   `getStyledTextSegments` throws when Figma treats a node as inaccessible, which
   includes invisible ones in some editor states. textLinks() used to swallow that
   and return [] — so the hyperlink was not merely lost, it was lost WITHOUT A
   TRACE, which is why "the link is simply not in the Links section" took several
   passes to explain. Two fixes: report the error, and try the other API. */

test('a throwing segment API is REPORTED, never swallowed', () => {
  const errs = [];
  const node = { id: 't', name: 'CTA', type: 'TEXT', characters: 'x',
    getStyledTextSegments() { throw new Error('node is not accessible'); } };
  X.textLinks(node, (n, msg) => errs.push(msg));
  assert.strictEqual(errs.length, 1, 'the failure must surface');
  assert.match(errs[0], /getStyledTextSegments failed/);
  assert.match(errs[0], /not accessible/, 'and carry the real reason');
});

test('a whole-node hyperlink is found when the segment API throws', () => {
  const node = { id: 't', name: 'CTA', type: 'TEXT', characters: 'master template',
    getStyledTextSegments() { throw new Error('node is not accessible'); },
    hyperlink: { type: 'URL', value: 'https://docs.google.com/presentation/d/abc/edit' } };
  const out = X.textLinks(node, () => {});
  assert.strictEqual(out.length, 1, 'the fallback path must find it');
  assert.strictEqual(out[0].value, 'https://docs.google.com/presentation/d/abc/edit');
  assert.strictEqual(out[0].via, 'hyperlink', 'and record which path found it');
  assert.strictEqual(out[0].partial, false, 'a whole-node link covers the node by definition');
});

test('a whole-node hyperlink is found when the segment API returns nothing', () => {
  const node = { id: 't', name: 'CTA', type: 'TEXT', characters: 'link',
    getStyledTextSegments: () => [],
    hyperlink: { type: 'URL', value: 'https://example.com/whole' } };
  assert.strictEqual(X.textLinks(node, () => {})[0].value, 'https://example.com/whole');
});

test('the segment path WINS when it yields anything — visible links unchanged', () => {
  // The fallback must never duplicate, override or reorder an existing result.
  const node = { id: 't', name: 'CTA', type: 'TEXT', characters: 'click here',
    getStyledTextSegments: () => ([{ characters: 'click', start: 0, end: 5,
      hyperlink: { type: 'URL', value: 'https://example.com/segment' } }]),
    hyperlink: { type: 'URL', value: 'https://example.com/should-not-appear' } };
  const out = X.textLinks(node, () => {});
  assert.strictEqual(out.length, 1, 'exactly one link, not two');
  assert.strictEqual(out[0].value, 'https://example.com/segment');
  assert.strictEqual(out[0].via, undefined, 'and it came from the segment path');
  assert.strictEqual(out[0].partial, true, 'partial-range detection still works');
});

test('a null or mixed hyperlink property yields nothing', () => {
  const base = { id: 't', name: 'CTA', type: 'TEXT', characters: 'x',
                 getStyledTextSegments: () => [] };
  assert.deepStrictEqual(X.textLinks({ ...base, hyperlink: null }, () => {}), []);
  assert.deepStrictEqual(X.textLinks({ ...base, hyperlink: {} }, () => {}), []);
  assert.deepStrictEqual(X.textLinks({ ...base }, () => {}), []);
});

test('an unreadable hyperlink property is reported too, and does not crash', () => {
  const errs = [];
  const node = { id: 't', name: 'CTA', type: 'TEXT', characters: 'x',
    getStyledTextSegments: () => [],
    get hyperlink() { throw new Error('inaccessible'); } };
  assert.deepStrictEqual(X.textLinks(node, (n, m) => errs.push(m)), []);
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /hyperlink property unreadable/);
});

test('unreadable characters do not stop a link being found', () => {
  const node = { id: 't', name: 'CTA', type: 'TEXT',
    get characters() { throw new Error('inaccessible'); },
    getStyledTextSegments: () => [],
    hyperlink: { type: 'URL', value: 'https://example.com/x' } };
  const out = X.textLinks(node, () => {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, '');
});

test('planSlide surfaces detection errors instead of losing them', () => {
  const f = tree({ id: 'frame', type: 'FRAME', name: '01 · Probe', box: box(0, 0, 1440, 810),
    children: [{ id: 'g', type: 'GROUP', visible: false, box: box(10, 10, 100, 20), children: [
      { id: 't', type: 'TEXT', box: box(10, 10, 100, 20), characters: 'x' },
    ]}]});
  const t = kid(f, 't');
  t.getStyledTextSegments = () => { throw new Error('node is not accessible'); };
  t.hyperlink = { type: 'URL', value: 'https://example.com/rescued' };

  const out = X.planSlide(f, 0);
  assert.strictEqual(out.probe.errors.length, 1, 'the throw is recorded');
  assert.match(out.probe.errors[0], /"t".*getStyledTextSegments failed/);
  // …and the link is still recovered, with geometry, off a hidden parent.
  assert.strictEqual(out.links.length, 1);
  assert.strictEqual(out.links[0].value, 'https://example.com/rescued');
  assert.strictEqual(out.links[0].hidden, true);
  assert.deepStrictEqual(out.links[0].rect, { x: 10, y: 10, w: 100, h: 20 });
  assert.strictEqual(out.probe.viaProperty, 1);
  assert.strictEqual(out.probe.viaSegments, 0);
});

test('the probe separates "never reached" from "reached and found nothing"', () => {
  const f = slideWithHiddenLink;
  const p = X.planSlide(f, 0).probe;
  assert.ok(p.nodes >= 4, 'every node counted');
  assert.strictEqual(p.text, 2, 'both text nodes were reached');
  assert.strictEqual(p.hiddenText, 1, 'one of them under a hidden parent');
  assert.strictEqual(p.viaSegments, 2, 'and both links came from the segment path');
});

test('linksForNode finds prototype URL actions on a hidden node as well', () => {
  const f = tree({ id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'r', type: 'RECTANGLE', visible: false, box: box(5, 5, 50, 50), render: null,
      reactions: [{ actions: [{ type: 'URL', url: 'https://example.com/proto' }] }] },
  ]});
  const out = X.linksForNode(kid(f, 'r'), f, 0, 0);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'reaction');
  assert.strictEqual(out[0].hidden, true);
  assert.deepStrictEqual(out[0].rect, { x: 5, y: 5, w: 50, h: 50 });
});

test('a node with no links returns nothing, hidden or not', () => {
  const f = tree({ id: 'frame', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'plain', type: 'RECTANGLE', visible: false, box: box(0, 0, 10, 10) },
  ]});
  assert.deepStrictEqual(X.linksForNode(kid(f, 'plain'), f, 0, 0), []);
  assert.deepStrictEqual(X.linksForNode(null, f, 0, 0), []);
});

/* ------------------------------------------------ CORNER RADIUS ------ */
/* A video fill is painted by a SHAPE, and that shape's rounding is part of how
   the video looks. Nothing read it, so a rounded video card published with hard
   square corners — reported from a real publish. A layer bitmap carries its own
   rounding in its pixels; a live <video> cannot. */

const videoNode = (extra = {}) => ({
  id: 'vid', type: 'RECTANGLE', box: box(100, 100, 200, 120),
  fills: [{ type: 'VIDEO', videoHash: 'h', scaleMode: 'FILL', visible: true }], ...extra,
});
const slideWith = spec => tree({ id: 'slide', name: '01', type: 'FRAME',
  box: box(0, 0, 1440, 810), children: [spec] });

test('cornerRadii reads a uniform radius', () => {
  assert.deepStrictEqual(X.cornerRadii({ cornerRadius: 12 }), [12, 12, 12, 12]);
});

test('cornerRadii reads PER-CORNER radii, which beat the uniform value', () => {
  // cornerRadius reports figma.mixed the moment corners differ, so the
  // per-corner properties are the only usable source.
  assert.deepStrictEqual(X.cornerRadii({
    cornerRadius: Symbol('mixed'),
    topLeftRadius: 24, topRightRadius: 0, bottomRightRadius: 8, bottomLeftRadius: 0,
  }), [24, 0, 8, 0]);
});

test('cornerRadii returns null for square corners and for junk', () => {
  assert.strictEqual(X.cornerRadii({ cornerRadius: 0 }), null);
  assert.strictEqual(X.cornerRadii({ topLeftRadius: 0, topRightRadius: 0,
                                     bottomRightRadius: 0, bottomLeftRadius: 0 }), null);
  assert.strictEqual(X.cornerRadii({ cornerRadius: Symbol('mixed') }), null,
    'figma.mixed is a symbol and must never leak through as a number');
  assert.strictEqual(X.cornerRadii({}), null);
  assert.strictEqual(X.cornerRadii(null), null);
});

test('a video node\'s corner radius reaches the extracted payload', () => {
  const out = X.planSlide(slideWith(videoNode({ cornerRadius: 16 })), 0);
  assert.strictEqual(out.videos.length, 1);
  assert.deepStrictEqual(out.videos[0].radius, [16, 16, 16, 16]);
});

test('a square-cornered video carries no radius at all', () => {
  const out = X.planSlide(slideWith(videoNode()), 0);
  assert.strictEqual(out.videos[0].radius, null, 'nothing to apply, nothing emitted');
});

test('per-corner rounding survives extraction independently', () => {
  const out = X.planSlide(slideWith(videoNode({
    topLeftRadius: 20, topRightRadius: 20, bottomRightRadius: 0, bottomLeftRadius: 0,
  })), 0);
  assert.deepStrictEqual(out.videos[0].radius, [20, 20, 0, 0],
    'a top-rounded card keeps its flat bottom edge');
});

/* ------------------------------------------------------- MASKS ------- */
/* Traversal must never stop at a mask, nor at anything inside one. everyNode()
   descends unconditionally, so this is pinned rather than newly built — a future
   "skip masks for speed" optimisation would silently lose every link, video and
   image inside one, which is exactly the class of silent loss this project keeps
   paying for. Separately, a mask is not CONTENT: exporting it as a layer paints
   the mask shape itself. */

const mask = (id, boxRect, extra = {}) =>
  ({ id, type: 'ELLIPSE', isMask: true, box: boxRect, ...extra });

/** frame > group > frame > mask + content, five levels down. */
const deepMaskSlide = () => tree({
  id: 'slide', name: '01 · Masks', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'lvl1', type: 'FRAME', box: box(600, 40, 400, 400), children: [
      { id: 'lvl2', type: 'GROUP', box: box(600, 40, 400, 400), children: [
        { id: 'lvl3', type: 'FRAME', box: box(600, 40, 400, 400), children: [
          mask('deepMask', box(600, 40, 400, 400)),
          { id: 'deepText', type: 'TEXT', box: box(620, 300, 300, 40), characters: 'link',
            segments: linkSeg('https://example.com/deep-in-mask', 'link') },
          { id: 'deepNamed', type: 'RECTANGLE', name: 'https://example.com/name-in-mask',
            box: box(620, 360, 300, 40) },
        ]},
      ]},
    ]},
  ]});

test('everyNode descends INTO a mask and through everything under it', () => {
  const ids = X.everyNode(deepMaskSlide()).map(n => n.id);
  for (const id of ['lvl1', 'lvl2', 'lvl3', 'deepMask', 'deepText', 'deepNamed']) {
    assert.ok(ids.includes(id), 'traversal must reach ' + id);
  }
});

/* A mask is not always a leaf. A GROUP or FRAME can carry isMask, and then its
   children ARE content whose parent is a mask. This is the case that a
   "skip masks" optimisation would silently destroy — a leaf-mask fixture cannot
   catch it, because stopping at a leaf loses nothing. */
const maskContainerSlide = () => tree({
  id: 'slide', name: '01 · Mask container', type: 'FRAME', box: box(0, 0, 1440, 810),
  children: [
    { id: 'maskGroup', type: 'GROUP', isMask: true, box: box(0, 0, 400, 400), children: [
      { id: 'inMask', type: 'TEXT', box: box(10, 10, 200, 30), characters: 'link',
        segments: linkSeg('https://example.com/child-of-a-mask', 'link') },
      { id: 'inMaskVideo', type: 'RECTANGLE', box: box(10, 60, 200, 120),
        fills: [{ type: 'VIDEO', videoHash: 'h', scaleMode: 'FILL', visible: true }] },
      { id: 'deeper', type: 'FRAME', box: box(10, 200, 200, 100), children: [
        { id: 'deepest', type: 'RECTANGLE', name: 'https://example.com/under-a-mask',
          box: box(20, 210, 100, 40) },
      ]},
    ]},
  ]});

test('traversal continues when the node ITSELF is a mask with children', () => {
  const ids = X.everyNode(maskContainerSlide()).map(n => n.id);
  for (const id of ['maskGroup', 'inMask', 'inMaskVideo', 'deeper', 'deepest']) {
    assert.ok(ids.includes(id),
      'a mask CONTAINER must not prune its subtree — missing ' + id);
  }
});

test('content whose PARENT is a mask is extracted like any other content', () => {
  const out = X.planSlide(maskContainerSlide(), 0);
  assert.deepStrictEqual(out.links.map(l => l.value).sort(), [
    'https://example.com/child-of-a-mask',
    'https://example.com/under-a-mask',
  ], 'links under a mask parent, native and layer-name alike');
  assert.strictEqual(out.videos.length, 1, 'and a video under a mask parent');
  assert.strictEqual(out.videos[0].nodeId, 'inMaskVideo');
  assert.strictEqual(out.census.fills.VIDEO, 1);
});

test('a link five levels down inside a mask is extracted like any other', () => {
  const out = X.planSlide(deepMaskSlide(), 0);
  const vals = out.links.map(l => l.value).sort();
  assert.deepStrictEqual(vals, [
    'https://example.com/deep-in-mask',
    'https://example.com/name-in-mask',
  ], 'native and layer-name detection both work inside a mask');
});

test('a VIDEO inside a mask is detected with its geometry', () => {
  const f = tree({ id: 'slide', name: '01', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'g', type: 'GROUP', box: box(300, 40, 200, 200), children: [
      mask('gMask', box(300, 40, 200, 200)),
      { id: 'gVideo', type: 'RECTANGLE', box: box(300, 40, 200, 200),
        fills: [{ type: 'VIDEO', videoHash: 'h', scaleMode: 'FILL', visible: true }] },
    ]},
  ]});
  const out = X.planSlide(f, 0);
  assert.strictEqual(out.videos.length, 1);
  assert.strictEqual(out.videos[0].nodeId, 'gVideo');
  assert.deepStrictEqual(out.videos[0].rect, { x: 300, y: 40, w: 200, h: 200 });
});

test('the census counts nodes and fills inside masks', () => {
  const f = tree({ id: 'slide', name: '01', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'g', type: 'GROUP', box: box(0, 0, 100, 100), children: [
      mask('m', box(0, 0, 100, 100)),
      { id: 'img', type: 'RECTANGLE', box: box(0, 0, 100, 100),
        fills: [{ type: 'IMAGE', imageHash: 'i', scaleMode: 'FILL', visible: true }] },
    ]},
  ]});
  const c = X.planSlide(f, 0).census;
  assert.strictEqual(c.fills.IMAGE, 1, 'an image inside a mask is still counted');
  assert.strictEqual(c.types.ELLIPSE, 1, 'and the mask node itself is counted');
});

test('a MASK is never exported as a layer — it is not content', () => {
  // Exported it would paint the mask SHAPE, a blob appearing nowhere in Figma.
  const f = tree({ id: 'slide', name: '01', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    mask('topMask', box(40, 40, 200, 200)),
    { id: 'photo', type: 'RECTANGLE', box: box(40, 40, 200, 200) },
  ]});
  const out = X.planSlide(f, 0);
  assert.deepStrictEqual(out.layers.map(l => l.id), ['photo'], 'the mask is not a layer');
  assert.strictEqual(X.describeChild(kid(f, 'topMask'), 0, 0, 0, 1440, 810), null);
  // …but it is still reported, because its siblings will render unmasked.
  assert.deepStrictEqual(out.probe.topMasks, ['topMask']);
  assert.strictEqual(out.probe.masks, 1);
});

test('a MASKED GROUP is never split into parts — the mask needs the whole group', () => {
  /* Parts export one node at a time and Figma applies a mask at group level, so
     splitting one exports the mask shape as a blob and its content unmasked. */
  const f = tree({ id: 'slide', name: '01', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'masked', type: 'GROUP', box: box(0, 0, 200, 200), children: [
      mask('m', box(0, 0, 200, 200)),
      { id: 'a', type: 'RECTANGLE', box: box(0, 0, 100, 100) },
      { id: 'b', type: 'RECTANGLE', box: box(100, 0, 100, 100) },
    ]},
  ]});
  const L = X.planSlide(f, 0).layers[0];
  assert.strictEqual(L.id, 'masked');
  assert.strictEqual(L.hasMask, true);
  assert.strictEqual(L.parts, undefined, 'no fine grain — correctness beats a reveal option');
});

test('an UNMASKED group still splits exactly as before', () => {
  // The whole point: nothing changes for content that has no mask in it.
  const f = tree({ id: 'slide', name: '01', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'plain', type: 'GROUP', box: box(0, 0, 200, 200), children: [
      { id: 'a', type: 'TEXT', box: box(0, 0, 100, 20), characters: 'a' },
      { id: 'b', type: 'TEXT', box: box(0, 30, 100, 20), characters: 'b' },
    ]},
  ]});
  const L = X.planSlide(f, 0).layers[0];
  assert.strictEqual(L.hasMask, false);
  assert.deepStrictEqual((L.parts || []).map(p => p.id).sort(), ['a', 'b']);
});

test('a mask nested deeper does not block its container from splitting', () => {
  // hasMask looks at OWN children only — a mask two levels down is applied
  // inside that subtree's own export and does not constrain this group.
  const f = tree({ id: 'slide', name: '01', type: 'FRAME', box: box(0, 0, 1440, 810), children: [
    { id: 'outer', type: 'GROUP', box: box(0, 0, 400, 400), children: [
      { id: 'innerGroup', type: 'GROUP', box: box(0, 0, 200, 200), children: [
        mask('m', box(0, 0, 200, 200)),
        { id: 'x', type: 'RECTANGLE', box: box(0, 0, 200, 200) },
      ]},
      { id: 'sibling', type: 'RECTANGLE', box: box(200, 0, 200, 200) },
    ]},
  ]});
  const L = X.planSlide(f, 0).layers[0];
  assert.strictEqual(L.hasMask, false, 'no mask among its OWN children');
  assert.deepStrictEqual((L.parts || []).map(p => p.id).sort(), ['innerGroup', 'sibling']);
});

/* ------------------------------------------ URL in the LAYER NAME ----- */
/* Some files carry the link as the layer's NAME rather than as Figma hyperlink
   metadata: no text segment, no TextNode.hyperlink, no prototype reaction — so
   every native path correctly reports nothing. This is a general rule over any
   layer name, consulted LAST and only when a node produced no native link. */

test('urlFromName finds an http(s) URL anywhere in a layer name', () => {
  assert.strictEqual(X.urlFromName('https://example.com/a'), 'https://example.com/a');
  assert.strictEqual(X.urlFromName('CTA — https://example.com/a'), 'https://example.com/a');
  assert.strictEqual(X.urlFromName('http://example.com'), 'http://example.com');
  assert.strictEqual(X.urlFromName('  HTTPS://Example.COM/Path?q=1#x  '),
    'HTTPS://Example.COM/Path?q=1#x', 'scheme and host case are preserved, not normalised');
  assert.strictEqual(X.urlFromName('https://sub.domain.co.uk/a/b?x=1&y=2'),
    'https://sub.domain.co.uk/a/b?x=1&y=2');
  assert.strictEqual(X.urlFromName('http://localhost:3001/preview'),
    'http://localhost:3001/preview', 'localhost needs no dot');
});

test('urlFromName trims sentence punctuation but keeps URL punctuation', () => {
  assert.strictEqual(X.urlFromName('see https://example.com/a.'), 'https://example.com/a');
  assert.strictEqual(X.urlFromName('link (https://example.com/a)'), 'https://example.com/a');
  assert.strictEqual(X.urlFromName('"https://example.com/a",'), 'https://example.com/a');
  // A balanced bracket that is genuinely part of the address survives.
  assert.strictEqual(X.urlFromName('https://en.wikipedia.org/wiki/Foo_(bar)'),
    'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.strictEqual(X.urlFromName('https://example.com/a/b-c_d~e'), 'https://example.com/a/b-c_d~e');
});

test('urlFromName rejects anything that is not a real URL', () => {
  for (const bad of ['Rectangle 42', 'Frame 1', '', null, undefined, 'example.com',
                     'www.example.com', 'ftp://example.com/a', 'mailto:a@b.com',
                     'https://', 'https://.', 'http://nodot', 'https://x./a',
                     'just some copy about http and https']) {
    assert.strictEqual(X.urlFromName(bad), null, 'should reject ' + JSON.stringify(bad));
  }
});

test('a VISIBLE layer whose NAME is a URL becomes a link with the node geometry', () => {
  const f = tree({ id: 'frame', type: 'FRAME', name: '01 · Slide', box: box(0, 0, 1440, 810),
    children: [
      { id: 'hot', type: 'RECTANGLE', name: 'https://example.com/offer',
        box: box(240, 360, 400, 90) },
    ]});
  const out = X.planSlide(f, 0);
  assert.strictEqual(out.links.length, 1);
  const l = out.links[0];
  assert.strictEqual(l.value, 'https://example.com/offer');
  assert.strictEqual(l.linkType, 'URL');
  assert.strictEqual(l.via, 'name');
  assert.strictEqual(l.hidden, false);
  assert.strictEqual(l.partial, false);
  assert.strictEqual(l.internal, false);
  assert.deepStrictEqual(l.rect, { x: 240, y: 360, w: 400, h: 90 },
    'the hotspot uses the node\'s actual Figma geometry');
});

test('a HIDDEN layer whose NAME is a URL still yields a placed hotspot', () => {
  // Both Figma boxes are null on a hidden node; geometry comes from layout.
  const f = tree({ id: 'frame', type: 'FRAME', name: '02 · Slide', box: box(0, 0, 1440, 810),
    children: [
      { id: 'hot', type: 'RECTANGLE', visible: false, name: 'https://example.com/secret',
        box: box(700, 500, 240, 80) },
    ]});
  const node = kid(f, 'hot');
  assert.strictEqual(node.absoluteBoundingBox, null, 'precondition: Figma nulls the boxes');
  assert.strictEqual(node.absoluteRenderBounds, null);

  const out = X.planSlide(f, 0);
  assert.strictEqual(out.links.length, 1);
  const l = out.links[0];
  assert.strictEqual(l.value, 'https://example.com/secret');
  assert.strictEqual(l.via, 'name');
  assert.strictEqual(l.hidden, true, 'tagged so the review table can say so');
  assert.deepStrictEqual(l.rect, { x: 700, y: 500, w: 240, h: 80 },
    'positioned at the node\'s real place on the slide');
  // …and nothing of it is painted.
  assert.ok(!out.layers.some(x => x.id === 'hot'), 'a hidden layer is never exported');
  assert.strictEqual(out.probe.viaName, 1);
});

test('a name URL on a hidden layer nested deep still resolves', () => {
  const f = tree({ id: 'frame', type: 'FRAME', name: '03 · Slide', box: box(0, 0, 1440, 810),
    children: [{ id: 'g', type: 'GROUP', visible: false, box: box(0, 0, 800, 600), children: [
      { id: 'inner', type: 'FRAME', box: box(0, 0, 800, 600), children: [
        { id: 'hot', type: 'RECTANGLE', name: 'go → https://example.com/deep',
          box: box(310, 420, 180, 24) },
      ]},
    ]}]});
  const l = X.planSlide(f, 0).links[0];
  assert.strictEqual(l.value, 'https://example.com/deep');
  assert.strictEqual(l.hidden, true);
  assert.deepStrictEqual(l.rect, { x: 310, y: 420, w: 180, h: 24 });
});

test('a NATIVE hyperlink wins — the name never duplicates or shadows it', () => {
  const f = tree({ id: 'frame', type: 'FRAME', name: '04 · Slide', box: box(0, 0, 1440, 810),
    children: [
      { id: 't', type: 'TEXT', name: 'https://example.com/from-the-name',
        box: box(10, 20, 100, 30), characters: 'link',
        segments: linkSeg('https://example.com/native', 'link') },
    ]});
  const out = X.planSlide(f, 0);
  assert.strictEqual(out.links.length, 1, 'exactly one link, not two');
  assert.strictEqual(out.links[0].value, 'https://example.com/native');
  assert.strictEqual(out.links[0].via, undefined, 'and it is the native one');
  assert.strictEqual(out.probe.viaName, 0);
});

test('a prototype URL action also beats the layer name', () => {
  const f = tree({ id: 'frame', type: 'FRAME', name: '05 · Slide', box: box(0, 0, 1440, 810),
    children: [
      { id: 'r', type: 'RECTANGLE', name: 'https://example.com/from-the-name',
        box: box(0, 0, 50, 50),
        reactions: [{ actions: [{ type: 'URL', url: 'https://example.com/proto' }] }] },
    ]});
  const out = X.planSlide(f, 0);
  assert.strictEqual(out.links.length, 1);
  assert.strictEqual(out.links[0].value, 'https://example.com/proto');
});

test('the SLIDE FRAME\'s own name is never turned into a full-slide hotspot', () => {
  // It would swallow every click and break click-to-advance; a frame name is a
  // title, not a layer annotation.
  const f = tree({ id: 'frame', type: 'FRAME', name: '06 · https://example.com/deck',
    box: box(0, 0, 1440, 810), children: [
      { id: 'r', type: 'RECTANGLE', name: 'Rectangle 1', box: box(0, 0, 10, 10) },
    ]});
  assert.deepStrictEqual(X.planSlide(f, 0).links, []);
});

test('an INTERNAL host in a layer name is flagged exactly like any other link', () => {
  const f = tree({ id: 'frame', type: 'FRAME', name: '07 · Slide', box: box(0, 0, 1440, 810),
    children: [
      { id: 'r', type: 'RECTANGLE', visible: false,
        name: 'https://docs.google.com/presentation/d/abc/edit', box: box(1, 2, 3, 4) },
    ]});
  const l = X.planSlide(f, 0).links[0];
  assert.strictEqual(l.internal, true, 'unchanged internal rule — defaults to EXCLUDED in the UI');
  assert.strictEqual(l.hidden, true);
  assert.strictEqual(l.via, 'name');
});

test('ordinary layer names produce no links at all', () => {
  const f = tree({ id: 'frame', type: 'FRAME', name: '08 · Slide', box: box(0, 0, 1440, 810),
    children: [
      { id: 'a', type: 'RECTANGLE', name: 'Rectangle 42', box: box(0, 0, 10, 10) },
      { id: 'b', type: 'TEXT', name: 'Heading', box: box(0, 0, 10, 10), characters: 'hi',
        segments: [] },
      { id: 'c', type: 'FRAME', name: 'Group 7', box: box(0, 0, 10, 10) },
    ]});
  assert.deepStrictEqual(X.planSlide(f, 0).links, []);
});

/* ------------------------------------ hidden TOP-LEVEL frames --------- */
/* ⚠️ THE ONE THAT ACTUALLY BIT.
   A designer hid the SLIDE holding a hyperlink, not a layer inside it. The frame
   was discarded inside findSlides()'s type filter, so the sweep never saw it and
   the link vanished with no message — the extraction reported "0 hidden nodes",
   which is true and deeply misleading, because the hidden thing was never in the
   traversed tree at all. Hidden frames are still excluded (a hidden slide is not
   part of the deck, and its links would have no slide to sit on) but they are now
   reported, with a count of what goes down with them. */

test('partitionFrames keeps hidden top-level frames instead of discarding them', () => {
  const pool = [
    tree({ id: 'a', type: 'FRAME', box: box(0, 0, 1440, 810) }),
    tree({ id: 'b', type: 'FRAME', visible: false, box: box(0, 0, 1440, 810) }),
    tree({ id: 'c', type: 'COMPONENT', box: box(0, 0, 1440, 810) }),
  ];
  const p = X.partitionFrames(pool);
  assert.deepStrictEqual(p.visible.map(f => f.id), ['a', 'c']);
  assert.deepStrictEqual(p.hiddenFrames.map(f => f.id), ['b'],
    'the hidden frame must survive as REPORTABLE, not be dropped on the floor');
});

test('partitionFrames ignores non-frames without counting them as hidden', () => {
  const pool = [
    tree({ id: 'txt', type: 'TEXT', box: box(0, 0, 10, 10) }),
    tree({ id: 'sec', type: 'SECTION', visible: false, box: box(0, 0, 10, 10) }),
    tree({ id: 'f', type: 'FRAME', box: box(0, 0, 1440, 810) }),
  ];
  const p = X.partitionFrames(pool);
  assert.deepStrictEqual(p.visible.map(f => f.id), ['f']);
  assert.deepStrictEqual(p.hiddenFrames, [], 'a hidden non-frame was never a slide candidate');
  assert.deepStrictEqual(X.partitionFrames([]), { visible: [], hiddenFrames: [] });
  assert.deepStrictEqual(X.partitionFrames(null), { visible: [], hiddenFrames: [] });
});

test('a hidden slide never becomes a slide — deck composition is unchanged', () => {
  const pool = [
    tree({ id: 'a', name: '01 · One', type: 'FRAME', box: box(0, 0, 1440, 810) }),
    tree({ id: 'b', name: '02 · Two', type: 'FRAME', visible: false, box: box(0, 0, 1440, 810) }),
  ];
  const p = X.partitionFrames(pool);
  const found = X.selectSlides(p.visible);
  assert.deepStrictEqual(found.slides.map(f => f.id), ['a'],
    'hiding a slide removes it from the deck, which is correct');
});

test('countLinks reports what a hidden frame takes down with it', () => {
  const hidden = tree({ id: 'slide2', name: '02 · Links', type: 'FRAME', visible: false,
    box: box(0, 0, 1440, 810), children: [
      { id: 't', type: 'TEXT', box: box(10, 10, 100, 20), characters: 'master template',
        segments: linkSeg('https://docs.google.com/presentation/d/abc/edit', 'master template') },
      { id: 'r', type: 'RECTANGLE', box: box(0, 0, 50, 50),
        reactions: [{ actions: [{ type: 'URL', url: 'https://example.com/proto' }] }] },
    ]});
  assert.strictEqual(X.countLinks(hidden), 2, 'both a text link and a prototype action');
  assert.strictEqual(X.countLinks(null), 0);
});

test('countLinks finds links a hidden frame holds several levels down', () => {
  const hidden = tree({ id: 's', type: 'FRAME', visible: false, box: box(0, 0, 1440, 810),
    children: [{ id: 'g', type: 'GROUP', box: box(0, 0, 100, 100), children: [
      { id: 'inner', type: 'FRAME', box: box(0, 0, 100, 100), children: [
        { id: 't', type: 'TEXT', box: box(0, 0, 100, 20), characters: 'x',
          segments: linkSeg('https://example.com/deep', 'x') },
      ]},
    ]}]});
  assert.strictEqual(X.countLinks(hidden), 1);
});

/* ------------------------------------------------- publish failures --- */
/* Regression cover for a real one: a designer's publish came back as
   "Could not publish — bridge returned 500" with nothing else. The bridge had
   sent the actual reason in the response body — surge's "you do not have
   permission to publish to orient.surge.sh", i.e. the project name belonged to
   another Surge account — and the plugin discarded it and printed the status
   instead. The staging path had always read the body; the publish path had not. */

const fs = require('fs');
const pathMod = require('path');
const UI = fs.readFileSync(pathMod.join(__dirname, '..', 'ui.html'), 'utf8');

test('the alpha-max-0 drop removes LAYERS only — links pass through untouched', () => {
  /* The empty-.pptx-spacer filter (`alphaMax === 0`) and the "no bitmap" drop
     both live in the per-LAYER resolve(). Links are carried straight off the
     plan on the slide object, so a dropped layer can never take a link with it.
     Pinned because a missing Links section looks exactly like a filtering bug. */
  const assemble = UI.slice(UI.indexOf('for (const s of plan.slides)'),
                            UI.indexOf('const linkRows'));
  assert.match(assemble, /links:\s*s\.links/,
    'links must come from the plan slide, unconditionally');
  // The drop guards must sit inside resolve(), not around the slide push.
  const resolve = UI.slice(UI.indexOf('function resolve('), UI.indexOf('for (const s of plan.slides)'));
  assert.match(resolve, /alphaMax === 0/, 'the alpha drop belongs to resolve()');
  assert.ok(!/alphaMax/.test(assemble), 'and must never gate the slide or its links');
});

test('the publish path reads the bridge\'s error BODY, not just the status', () => {
  const at = UI.indexOf("fetch(BRIDGE + '/publish'");
  assert.ok(at > -1, 'the publish fetch must be findable');
  const block = UI.slice(at, at + 900);       // the fetch and its result handling
  assert.ok(/res\.json\(\)\.catch/.test(block),
    'a failed publish must parse the body — that is where the reason lives');
  assert.ok(/j\.error \|\|/.test(block),
    'the body\'s `error` must win over the bare status');
  assert.ok(!/if \(!res\.ok\) throw new Error\('bridge returned '/.test(UI),
    'the status-only throw must not come back');
});

test('a surge domain refusal is explained, and nothing else is mistaken for one', () => {
  const m = /const notYours = (\/[^;]+\/[a-z]*)\.test/.exec(UI);
  assert.ok(m, 'the taken-domain test must exist');
  const rx = eval(m[1]);
  // Verbatim from surge's own lib — not paraphrased.
  assert.ok(rx.test('you do not have permission to publish to orient.surge.sh'));
  assert.ok(rx.test('Aborted: Insufficient permission to access domain.'));
  // Must stay quiet on unrelated failures, or the hint becomes noise.
  for (const other of ['surge timed out after 180s',
                       '2 bitmaps were never uploaded — the deck would publish as blank slides',
                       'bridge returned 500']) {
    assert.ok(!rx.test(other), 'must not fire on: ' + other);
  }
});

/* -------------------------------------------------------------------- */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
