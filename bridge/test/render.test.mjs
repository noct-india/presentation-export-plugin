/**
 * Bridge tests — grain resolution, overlay building, deploy guards, and a real
 * dist/ written to a temp dir. No network, no Figma.
 *
 * Run: node bridge/test/render.test.mjs
 */

import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fsSync, { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveGrain, layersAtGrain, overlaysFor, buildDeckData, render,
         videoGeometry, zIndexFor, clipBoxes } from '../render.mjs';
import { parseEnv, domainFor, scrub } from '../deploy.mjs';
import { videoTypeOf, VIDEO_TYPES, sniffVideo, videoSpecFor } from '../server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('FAIL  ' + name + '\n      ' + e.message); }
};

const L = (id, o = {}) => ({
  id, name: id, type: 'FRAME', x: 0, y: 0, w: 100, h: 50, full: false,
  src: 'layers/01-00-' + id + '.png', i: 0, ...o,
});
const P = (id, type = 'TEXT') => ({
  id, name: id, type, x: 0, y: 0, w: 100, h: 20, full: false,
  src: 'parts/01-00-' + id + '.png', i: 0,
});

/* ------------------------------------------------------------- grain --- */

await test('resolveGrain: a layer with no parts is always coarse', () => {
  assert.strictEqual(resolveGrain(L('a'), 'fine'), 'coarse');
  assert.strictEqual(resolveGrain(L('a', { parts: [P('x')] }), 'fine'), 'coarse');
});

await test('resolveGrain: explicit choice beats the heuristic both ways', () => {
  const allText = L('copy', { parts: [P('a'), P('b')] });
  const mixed = L('art', { parts: [P('a'), P('b', 'RECTANGLE')] });
  assert.strictEqual(resolveGrain(allText, 'coarse'), 'coarse');
  assert.strictEqual(resolveGrain(mixed, 'fine'), 'fine');
});

await test('auto splits an all-text group and keeps a mixed one whole', () => {
  // Slide 7's "Copy" is nine text lines — staggering them reads as deliberate.
  assert.strictEqual(resolveGrain(L('copy', { parts: [P('a'), P('b'), P('c')] }), 'auto'), 'fine');
  // Slide 35's "Artwork" is picture pieces — splitting reads as a loading bug.
  assert.strictEqual(resolveGrain(L('art', { parts: [P('a'), P('b', 'VECTOR')] }), 'auto'), 'coarse');
  assert.strictEqual(resolveGrain(L('art', { parts: [P('a'), P('b', 'VECTOR')] }), undefined), 'coarse');
});

/* ------------------------------------------------- layers at a grain --- */

await test('fine grain emits the parts INSTEAD of their parent, never both', () => {
  const slide = { layers: [L('copy', { parts: [P('a'), P('b')] })] };
  const out = layersAtGrain(slide, { copy: 'fine' });
  assert.deepStrictEqual(out.map(l => l.id), ['a', 'b']);   // no 'copy'
});

await test('coarse grain emits the parent and drops the parts', () => {
  const slide = { layers: [L('copy', { parts: [P('a'), P('b')] })] };
  const out = layersAtGrain(slide, { copy: 'coarse' });
  assert.deepStrictEqual(out.map(l => l.id), ['copy']);
});

await test('stagger indices stay CONTIGUOUS across a grain swap', () => {
  // A gap in --i shows as a visible hitch mid-reveal, since the delay is
  // calc(var(--i) * var(--stagger)).
  const slide = { layers: [
    L('head'),
    L('copy', { parts: [P('a'), P('b'), P('c')] }),
    L('foot'),
  ]};
  const out = layersAtGrain(slide, { copy: 'fine' });
  assert.deepStrictEqual(out.map(l => l.i), [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(out.map(l => l.id), ['head', 'a', 'b', 'c', 'foot']);
});

await test('a split layer records which parent it came from', () => {
  const slide = { layers: [L('copy', { parts: [P('a'), P('b')] })] };
  assert.strictEqual(layersAtGrain(slide, { copy: 'fine' })[0].from, 'copy');
});

/* --------------------------------------------------------- overlays --- */

const slide41 = {
  no: 41, videos: [],
  layers: [], name: '41', w: 1440, h: 810, bg: '#fcfcfc', flat: 'flat/41.png',
};

await test('overlays include a kept link with its rect', () => {
  const out = overlaysFor(slide41, [
    { slide: 41, linkType: 'URL', value: 'https://kotak.com/811', text: 'learn more',
      rect: { x: 10, y: 20, w: 100, h: 30 } },
  ], {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'link');
  assert.strictEqual(out[0].href, 'https://kotak.com/811');
  assert.deepStrictEqual([out[0].x, out[0].y, out[0].w, out[0].h], [10, 20, 100, 30]);
});

await test('overlays skip links from other slides, NODE jumps, and rect-less links', () => {
  const out = overlaysFor(slide41, [
    { slide: 7, linkType: 'URL', value: 'https://a.com', rect: { x: 0, y: 0, w: 1, h: 1 } },
    { slide: 41, linkType: 'NODE', value: '227:69', rect: { x: 0, y: 0, w: 1, h: 1 } },
    { slide: 41, linkType: 'URL', value: 'https://b.com', rect: null },
  ], {});
  assert.deepStrictEqual(out, []);
});

await test('a link off a HIDDEN layer becomes an ordinary invisible hotspot', () => {
  /* The renderer must not treat `hidden` as a reason to skip: the whole point is
     a clickable area where nothing is drawn. Overlays carry no paint of their
     own — the <a> is a bare hotspot — so a hidden link and a visible one produce
     byte-identical output apart from position and href. */
  const at = r => overlaysFor(slide41,
    [{ slide: 41, linkType: 'URL', value: 'https://k.com/x', text: 't', ...r }], {})[0];
  const visible = at({ rect: { x: 10, y: 20, w: 100, h: 30 }, hidden: false });
  const hidden = at({ rect: { x: 10, y: 20, w: 100, h: 30 }, hidden: true });
  assert.ok(hidden, 'a hidden link must still produce an overlay');
  assert.deepStrictEqual(hidden, visible, 'and be indistinguishable from a visible one');
  assert.strictEqual(hidden.kind, 'link');
  assert.deepStrictEqual([hidden.x, hidden.y, hidden.w, hidden.h], [10, 20, 100, 30]);
});

await test('an EXCLUDED link never reaches the deck', () => {
  // The plugin filters before sending; the renderer only sees what survived.
  // This pins that the renderer adds nothing back.
  const out = overlaysFor(slide41, [], {});
  assert.deepStrictEqual(out, []);
});

/* ------------------------------------------------ video geometry ----- */
/* Every video used to render with a hardcoded object-fit:cover in a centring
   grid, so Figma's scaleMode, crop transform and clip were all discarded and a
   clipped video was offset by half its overflow. These derive from the two
   rects Figma returns on every node, so they hold for any layout. */

const vid = (o = {}) => ({ nodeId: 'v', rect: { x: 100, y: 50, w: 200, h: 120 }, ...o });

await test('with no clipping, the media exactly fills its window', () => {
  const g = videoGeometry(vid({ box: { x: 100, y: 50, w: 200, h: 120 }, scaleMode: 'FILL' }));
  assert.deepStrictEqual(g, { x: 0, y: 0, w: 200, h: 120, fit: 'cover', warn: null });
});

await test('a CLIPPED video keeps its own box, offset inside the window', () => {
  /* The reference deck's real case: a 150×150 video on a rect sitting at (0,0)
     inside a 196×116 frame that clips, so Figma shows its TOP 116px. cover would
     have cropped from the centre and lost ~17px off the top. */
  const g = videoGeometry(vid({
    rect: { x: 1104, y: 373, w: 150, h: 116 },
    box:  { x: 1104, y: 373, w: 150, h: 150 },
    scaleMode: 'FILL',
  }));
  assert.deepStrictEqual(g, { x: 0, y: 0, w: 150, h: 150, fit: 'cover', warn: null });
});

await test('a window clipped on its LEFT/TOP gives the media a negative offset', () => {
  // The node starts off-window, so the media must shift up and left under it.
  const g = videoGeometry(vid({
    rect: { x: 200, y: 100, w: 300, h: 200 },
    box:  { x: 150, y: 60,  w: 400, h: 300 },
    scaleMode: 'FILL',
  }));
  assert.deepStrictEqual(g, { x: -50, y: -40, w: 400, h: 300, fit: 'cover', warn: null });
});

await test('scaleMode maps to the matching object-fit', () => {
  const at = mode => videoGeometry(vid({ box: { x: 100, y: 50, w: 200, h: 120 }, scaleMode: mode })).fit;
  assert.strictEqual(at('FILL'), 'cover',   'FILL crops to cover, like Figma');
  assert.strictEqual(at('FIT'), 'contain',  'FIT letterboxes, like Figma');
  assert.strictEqual(at(undefined), 'cover', 'FILL is the default');
  assert.strictEqual(at('fill'), 'cover',   'case-insensitive');
});

await test('CROP is reconstructed from videoTransform, not guessed', () => {
  /* transform maps node space into normalised media space: a=d=0.5 means the
     node shows half the media each way, so the media is twice the node; tx/ty
     of 0.25 means that half starts a quarter in. */
  const g = videoGeometry(vid({
    rect: { x: 0, y: 0, w: 200, h: 100 },
    box:  { x: 0, y: 0, w: 200, h: 100 },
    scaleMode: 'CROP',
    transform: [[0.5, 0, 0.25], [0, 0.5, 0.25]],
  }));
  assert.deepStrictEqual(g, { x: -100, y: -50, w: 400, h: 200, fit: 'fill', warn: null },
    'media twice the node, shifted so the cropped window lands on it');
});

await test('a rotated or skewed CROP degrades visibly and says why', () => {
  const g = videoGeometry(vid({
    box: { x: 100, y: 50, w: 200, h: 120 }, scaleMode: 'CROP',
    transform: [[0.7, -0.7, 0], [0.7, 0.7, 0]],       // rotation: b and c non-zero
  }));
  assert.strictEqual(g.fit, 'cover');
  assert.match(g.warn, /rotated or skewed/);
});

await test('TILE has no video equivalent and says so rather than lying', () => {
  const g = videoGeometry(vid({ box: { x: 100, y: 50, w: 200, h: 120 }, scaleMode: 'TILE' }));
  assert.strictEqual(g.fit, 'cover');
  assert.match(g.warn, /TILE/);
});

await test('videoGeometry survives a missing box or rect', () => {
  assert.strictEqual(videoGeometry({ rect: null }), null);
  // No separate box (older payload) → the media simply fills the window.
  assert.deepStrictEqual(videoGeometry(vid({ scaleMode: 'FILL' })),
    { x: 0, y: 0, w: 200, h: 120, fit: 'cover', warn: null });
});

/* ------------------------------------------------------- z-order ----- */

await test('zIndexFor puts layers in FIGMA order, not reveal order', () => {
  assert.strictEqual(zIndexFor({ order: 0 }), 0);
  assert.strictEqual(zIndexFor({ order: 3 }), 300);
  // A split part sits inside its parent's band, above the parent, below the next.
  assert.strictEqual(zIndexFor({ order: 0, parentOrder: 2 }), 201);
  assert.strictEqual(zIndexFor({ order: 4, parentOrder: 2 }), 205);
  assert.ok(zIndexFor({ order: 4, parentOrder: 2 }) < zIndexFor({ order: 3 }),
    'a part never escapes its parent\'s band');
  // No order at all → positional fallback, so nothing collapses to the same plane.
  assert.strictEqual(zIndexFor({}, 5), 500);
});

await test('a video sits ABOVE its own layer and BELOW the next one', () => {
  const s = { ...slide41, no: 41,
    layers: [L('under', { order: 1, src: 'layers/41-00-under.png' })],
    videos: [{ nodeId: 'under', nodeName: 'clip', z: 1,
               rect: { x: 0, y: 0, w: 10, h: 10 }, box: { x: 0, y: 0, w: 10, h: 10 } }] };
  const ov = overlaysFor(s, [], { under: { src: 'video/u.mp4', type: 'video/mp4' } })[0];
  assert.strictEqual(ov.z, 150, 'mid-band above its own layer');
  assert.ok(ov.z > zIndexFor({ order: 1 }), 'above the layer it belongs to');
  assert.ok(ov.z < zIndexFor({ order: 2 }), 'below anything drawn over it in Figma');
});

await test('the video node\'s own bitmap becomes its poster, for free', () => {
  const s = { ...slide41, no: 41,
    layers: [L('vidnode', { order: 0, src: 'layers/41-00-vidnode.png' })],
    videos: [{ nodeId: 'vidnode', nodeName: 'clip', z: 0,
               rect: { x: 0, y: 0, w: 10, h: 10 }, box: { x: 0, y: 0, w: 10, h: 10 } }] };
  const ov = overlaysFor(s, [], { vidnode: { src: 'video/v.mp4', type: 'video/mp4' } })[0];
  assert.strictEqual(ov.poster, 'layers/41-00-vidnode.png',
    'Figma already exported the poster frame as that node\'s layer');
});

await test('an undecodable video falls back to a real IMG, not an empty box', () => {
  /* Confirmed live: only .mov failed, and it failed BOTH ways — no autoplay and
     a collapsed bounding box. Same cause: a container the browser cannot decode
     gives the element no intrinsic size, so object-fit has nothing to fit. A
     poster only shows until playback starts, so the fallback has to be a real
     <img> — no codec to refuse, no autoplay policy. */
  const s = { ...slide41, no: 41,
    layers: [L('vidnode', { order: 0, src: 'layers/41-00-vidnode.png' })],
    videos: [{ nodeId: 'vidnode', nodeName: 'clip', z: 0,
               rect: { x: 0, y: 0, w: 10, h: 10 }, box: { x: 0, y: 0, w: 10, h: 10 } }] };
  const ov = overlaysFor(s, [], { vidnode: { src: 'video/v.mov', type: 'video/mp4' } })[0];
  assert.strictEqual(ov.fallback, 'layers/41-00-vidnode.png',
    'the node\'s own exported bitmap IS the Figma frame — no new asset needed');
  assert.strictEqual(ov.poster, ov.fallback, 'and the poster is the same still');
});

await test('with no bitmap for the node there is simply no fallback', () => {
  const s = { ...slide41, no: 41, layers: [],
    videos: [{ nodeId: 'v', nodeName: 'clip', z: 0, rect: { x: 0, y: 0, w: 10, h: 10 } }] };
  const ov = overlaysFor(s, [], { v: { src: 'video/v.mp4', type: 'video/mp4' } })[0];
  assert.strictEqual(ov.fallback, null);
  assert.strictEqual(ov.poster, null);
});

await test('a video overlay appears only when a file was supplied', () => {
  const s = { ...slide41, videos: [{ nodeId: 'v1', nodeName: 'Money Transfer 1',
                                     rect: { x: 5, y: 5, w: 213, h: 213 } }] };
  assert.deepStrictEqual(overlaysFor(s, [], {}), []);            // unpaired → still stands in
  const out = overlaysFor(s, [], { v1: { src: 'video/v1.mp4', type: 'video/mp4' } });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'video');
  assert.deepStrictEqual(out[0].sources, [{ src: 'video/v1.mp4', type: 'video/mp4' }]);
});

/* ------------------------------------------------------- deck data --- */

const payload = {
  project: 'kotak-811-pitch',
  slides: [
    { no: 3, name: '03 · Design at scale', w: 1440, h: 810, bg: '#fcfcfc', flat: 'flat/03.png',
      layers: [L('vid', { src: 'layers/03-00-vid.png' })],
      videos: [{ nodeId: 'v1', nodeName: 'Money Transfer 1', rect: { x: 5, y: 5, w: 213, h: 213 } }] },
    { no: 7, name: '07 · Step 1', w: 1440, h: 810, bg: '#fcfcfc', flat: 'flat/07.png',
      layers: [L('copy', { parts: [P('a'), P('b')] })], videos: [] },
    { no: 35, name: '35 · Fallback', w: 1440, h: 810, bg: '#fcfcfc', flat: 'flat/35.png',
      layers: [], videos: [] },
  ],
  links: [{ slide: 7, linkType: 'URL', value: 'https://kotak.com/811', text: 'cta',
            rect: { x: 1, y: 2, w: 3, h: 4 } }],
  grain: [{ id: 'copy', grain: 'fine' }],
};

await test('buildDeckData carries slide size, titles and backgrounds', () => {
  const d = buildDeckData(payload, {});
  assert.strictEqual(d.w, 1440);
  assert.strictEqual(d.h, 810);
  assert.deepStrictEqual(d.slides.map(s => s.no), [3, 7, 35]);
  assert.strictEqual(d.slides[1].title, '07 · Step 1');
});

await test('a slide with NO layers keeps its flat render — the free fallback', () => {
  const d = buildDeckData(payload, {});
  const s35 = d.slides.find(s => s.no === 35);
  assert.deepStrictEqual(s35.layers, []);
  assert.strictEqual(s35.flat, 'flat/35.png');
});

await test('deck data honours the grain choice sent by the plugin', () => {
  const d = buildDeckData(payload, {});
  assert.strictEqual(d.slides.find(s => s.no === 7).layers.length, 2);   // split
});

/* ---------------------------------------------- video containers ----- */
/* This used to be `webm ? video/webm : video/mp4`, so a .mov reached the page
   declared as video/mp4. A <source> type is a hint the browser uses to decide
   whether to attempt the resource at all, so a wrong one can make it skip a file
   it could have played. Each slot is judged on its own file. */

await test('every supported container gets its OWN correct MIME type', () => {
  assert.deepStrictEqual(videoTypeOf('clip.mp4'),  { ext: '.mp4',  type: 'video/mp4' });
  assert.deepStrictEqual(videoTypeOf('clip.webm'), { ext: '.webm', type: 'video/webm' });
  assert.deepStrictEqual(videoTypeOf('clip.mov'),  { ext: '.mov',  type: 'video/quicktime' });
  assert.strictEqual(videoTypeOf('clip.mov').type !== 'video/mp4', true,
    'the regression: .mov must never be labelled mp4');
});

await test('container detection is case-insensitive and survives dotted names', () => {
  assert.deepStrictEqual(videoTypeOf('CLIP.MOV'), { ext: '.mov', type: 'video/quicktime' });
  assert.deepStrictEqual(videoTypeOf('my.clip.v2.WebM'), { ext: '.webm', type: 'video/webm' });
  assert.deepStrictEqual(videoTypeOf('a.b.mp4'), { ext: '.mp4', type: 'video/mp4' });
});

await test('an unsupported container is REFUSED, not silently renamed .mp4', () => {
  // A .mkv relabelled mp4 produces a deck that loads and plays nothing.
  for (const bad of ['clip.mkv', 'clip.avi', 'clip', '', null, 'clip.txt']) {
    assert.throws(() => videoTypeOf(bad), /unsupported video container/,
      'should refuse ' + JSON.stringify(bad));
  }
});

await test('different slots on one slide can use different containers', () => {
  const s = { ...slide41, no: 41, layers: [], videos: [
    { nodeId: 'a', nodeName: 'a', z: 0, rect: { x: 0, y: 0, w: 10, h: 10 } },
    { nodeId: 'b', nodeName: 'b', z: 1, rect: { x: 0, y: 0, w: 10, h: 10 } },
    { nodeId: 'c', nodeName: 'c', z: 2, rect: { x: 0, y: 0, w: 10, h: 10 } },
  ]};
  const files = {};
  for (const [id, name] of [['a', 'x.mp4'], ['b', 'y.webm'], ['c', 'z.mov']]) {
    const { ext, type } = videoTypeOf(name);
    files[id] = { src: 'video/' + id + ext, type };
  }
  const types = overlaysFor(s, [], files).map(o => o.sources[0].type);
  assert.deepStrictEqual(types, ['video/mp4', 'video/webm', 'video/quicktime'],
    'no format is required to match any other — one file per slot');
});

/* ⚠️ QUICKTIME MUST LEAD WITH video/mp4.
   A browser checks a <source>'s type with canPlayType BEFORE fetching it, and
   Chrome answers "" for video/quicktime — so labelling .mov "correctly" made
   Chrome skip the source without ever trying it, even though its demuxer handles
   H.264 in a .mov. Reported from a real publish: the video positioned correctly
   and showed its poster, but never played. */

await test('a QuickTime file leads with video/mp4 so Chrome will attempt it', () => {
  const mov = isoBmff('qt  ');
  const spec = videoSpecFor('clip.mov', mov);
  assert.deepStrictEqual(spec.types, ['video/mp4', 'video/quicktime'],
    'mp4 FIRST — a quicktime-only hint is skipped unfetched by Chrome');
  assert.strictEqual(spec.ext, '.mov', 'the extension stays truthful');
});

await test('type hints all point at ONE file — no second encode is ever needed', () => {
  const s = { ...slide41, no: 41, layers: [],
    videos: [{ nodeId: 'v', nodeName: 'v', z: 0, rect: { x: 0, y: 0, w: 10, h: 10 } }] };
  const spec = videoSpecFor('clip.mov', isoBmff('qt  '));
  const ov = overlaysFor(s, [], { v: { src: 'video/v.mov', type: spec.types[0], types: spec.types } })[0];
  assert.strictEqual(ov.sources.length, 2, 'two hints');
  assert.strictEqual(new Set(ov.sources.map(x => x.src)).size, 1, 'for exactly one file');
  assert.deepStrictEqual(ov.sources.map(x => x.type), ['video/mp4', 'video/quicktime']);
});

/* Content beats filename: an extension is a claim, the bytes are the fact. */

function isoBmff(brand) {
  const b = Buffer.alloc(16);
  b.write('ftyp', 4, 'latin1');
  b.write(brand, 8, 'latin1');
  return b;
}

await test('sniffVideo reads the real container out of the first bytes', () => {
  assert.strictEqual(sniffVideo(isoBmff('qt  ')).container, 'quicktime');
  assert.strictEqual(sniffVideo(isoBmff('isom')).container, 'mp4');
  assert.strictEqual(sniffVideo(isoBmff('mp42')).container, 'mp4');
  assert.strictEqual(sniffVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])).container, 'webm');
  assert.strictEqual(sniffVideo(Buffer.from('OggS' + '\0'.repeat(12), 'latin1')).container, 'ogg');
  assert.strictEqual(sniffVideo(Buffer.alloc(4)), null, 'too short to judge');
  assert.strictEqual(sniffVideo(null), null);
});

await test('a file NAMED .mov that is really an MP4 is published as an MP4', () => {
  // Common enough to matter, and pure gain: no shim, just correct identification.
  const spec = videoSpecFor('exported.mov', isoBmff('isom'));
  assert.strictEqual(spec.ext, '.mp4');
  assert.deepStrictEqual(spec.types, ['video/mp4']);
  assert.strictEqual(spec.container, 'mp4');
});

await test('unrecognised bytes fall back to the extension, still refusing junk', () => {
  const junk = Buffer.from('not a video at all!!', 'latin1');
  assert.deepStrictEqual(videoSpecFor('clip.webm', junk).types, ['video/webm']);
  assert.throws(() => videoSpecFor('clip.mkv', junk), /unsupported video container/);
});

/* ------------------------------------------------ corner radius ------ */
/* Figma rounds the SHAPE carrying the video fill. A layer bitmap carries its own
   rounding in its pixels; a live <video> cannot, so rounded video came out with
   hard square corners. Reported from a real publish. */

await test('corner radii reach the overlay, and square corners stay absent', () => {
  const withRadius = { nodeId: 'v', nodeName: 'v', z: 0,
    rect: { x: 0, y: 0, w: 200, h: 100 }, radius: [16, 16, 16, 16] };
  const mk = v => overlaysFor({ ...slide41, no: 41, layers: [], videos: [v] }, [],
    { v: { src: 'video/v.mp4', type: 'video/mp4' } })[0];

  assert.deepStrictEqual(mk(withRadius).radius, [16, 16, 16, 16]);
  assert.strictEqual(mk({ ...withRadius, radius: [0, 0, 0, 0] }).radius, null,
    'all-zero is square — no border-radius emitted at all');
  assert.strictEqual(mk({ ...withRadius, radius: null }).radius, null);
  assert.strictEqual(mk({ ...withRadius, radius: undefined }).radius, null);
});

/* ⚠️ A VIDEO'S SHAPE IS RARELY ITS OWN.
   Reading cornerRadius off the node carrying the video fill misses the usual
   Figma construction: a FRAME with rounded corners and clipsContent holding a
   square-cornered rectangle that carries the fill. Reported from a real publish
   — rounded videos still published square, because the rounding was upstairs. */

await test('a rounded clipping ANCESTOR shapes the video, not just its own node', () => {
  const boxes = clipBoxes({
    rect: { x: 100, y: 100, w: 200, h: 120 },
    box: { x: 100, y: 100, w: 200, h: 120 },
    radius: null,                                   // the video node is square
    clips: [{ id: 'frame', rect: { x: 90, y: 90, w: 220, h: 140 },
              radius: [16, 16, 16, 16], mask: null }],
  });
  assert.strictEqual(boxes.length, 1);
  assert.deepStrictEqual(boxes[0].radius, [16, 16, 16, 16]);
  assert.deepStrictEqual(boxes[0].rect, { x: 90, y: 90, w: 220, h: 140 },
    'and it cuts at the ANCESTOR\'s rect, not the video\'s');
});

await test('a rounded video inside a rounded frame keeps BOTH shapes', () => {
  const boxes = clipBoxes({
    rect: { x: 100, y: 100, w: 200, h: 120 },
    box: { x: 100, y: 100, w: 200, h: 120 },
    radius: [8, 8, 8, 8],
    clips: [{ id: 'f', rect: { x: 90, y: 90, w: 220, h: 140 },
              radius: [24, 24, 24, 24], mask: null }],
  });
  assert.deepStrictEqual(boxes.map(b => b.radius), [[24, 24, 24, 24], [8, 8, 8, 8]],
    'outermost first, the video\'s own rounding innermost and tightest');
});

await test('a CUSTOM VECTOR MASK travels as an SVG path with its own viewBox', () => {
  // border-radius only describes rounded rectangles, so a vector mask published
  // as a plain box until the path came with it.
  const boxes = clipBoxes({
    rect: { x: 0, y: 0, w: 100, h: 100 }, box: { x: 0, y: 0, w: 100, h: 100 },
    radius: null,
    clips: [{ id: 'g', rect: { x: 0, y: 0, w: 100, h: 100 }, radius: null,
              mask: { rect: { x: 10, y: 20, w: 80, h: 60 }, radius: null,
                      path: 'M0 0 L80 0 L40 60 Z', box: { w: 80, h: 60 }, type: 'VECTOR' } }],
  });
  assert.strictEqual(boxes.length, 1);
  assert.strictEqual(boxes[0].path, 'M0 0 L80 0 L40 60 Z');
  assert.deepStrictEqual(boxes[0].pathBox, { w: 80, h: 60 }, 'the viewBox the path is drawn in');
  assert.deepStrictEqual(boxes[0].rect, { x: 10, y: 20, w: 80, h: 60 },
    'a mask cuts at ITS rect, which can be tighter than its parent');
});

await test('clips nest OUTERMOST FIRST through several ancestors', () => {
  const boxes = clipBoxes({
    rect: { x: 50, y: 50, w: 50, h: 50 }, box: { x: 50, y: 50, w: 50, h: 50 }, radius: null,
    clips: [
      { id: 'outer', rect: { x: 0, y: 0, w: 400, h: 400 }, radius: [40, 40, 40, 40], mask: null },
      { id: 'inner', rect: { x: 20, y: 20, w: 200, h: 200 }, radius: [10, 10, 10, 10], mask: null },
    ],
  });
  assert.deepStrictEqual(boxes.map(b => b.rect.w), [400, 200],
    'wrappers nest from the widest inwards');
});

await test('clips with nothing to contribute are dropped, not emitted empty', () => {
  // A frame that clips but is square adds no SHAPE — only the rectangular
  // intersection, which the render bounds already carry.
  assert.deepStrictEqual(clipBoxes({
    rect: { x: 0, y: 0, w: 10, h: 10 }, box: { x: 0, y: 0, w: 10, h: 10 }, radius: null,
    clips: [{ id: 'f', rect: { x: 0, y: 0, w: 20, h: 20 }, radius: null, mask: null }],
  }), []);
  assert.deepStrictEqual(clipBoxes({ rect: { x: 0, y: 0, w: 10, h: 10 } }), []);
  assert.deepStrictEqual(clipBoxes({ rect: null, clips: [{ rect: null }] }), []);
});

await test('per-corner radii survive independently, in Figma order', () => {
  const ov = overlaysFor(
    { ...slide41, no: 41, layers: [],
      videos: [{ nodeId: 'v', nodeName: 'v', z: 0,
                 rect: { x: 0, y: 0, w: 200, h: 100 }, radius: [24, 0, 8, 0] }] },
    [], { v: { src: 'video/v.mp4', type: 'video/mp4' } })[0];
  assert.deepStrictEqual(ov.radius, [24, 0, 8, 0],
    'top-left, top-right, bottom-right, bottom-left');
});

await test('every declared container maps to exactly one source, never a pair', () => {
  // The designer supplies the one file they have; alternates are never required.
  for (const ext of Object.keys(VIDEO_TYPES)) {
    const s = { ...slide41, no: 41, layers: [],
      videos: [{ nodeId: 'v', nodeName: 'v', z: 0, rect: { x: 0, y: 0, w: 10, h: 10 } }] };
    const { type } = videoTypeOf('clip' + ext);
    const ov = overlaysFor(s, [], { v: { src: 'video/v' + ext, type } })[0];
    assert.strictEqual(ov.sources.length, 1, ext + ' must produce exactly one source');
    assert.strictEqual(ov.sources[0].type, VIDEO_TYPES[ext]);
  }
});

/* ---------------------------------------------------------- deploy --- */

await test('parseEnv handles quotes, comments, CRLF and stray blank lines', () => {
  const env = parseEnv('# comment\r\nSURGE_TOKEN="abc123"\r\n\r\nSURGE_LOGIN=\'a@b.c\'\nBAD\n');
  assert.strictEqual(env.SURGE_TOKEN, 'abc123');
  assert.strictEqual(env.SURGE_LOGIN, 'a@b.c');
  assert.strictEqual(env.BAD, undefined);
});

await test('domainFor accepts a valid slug and rejects the ways it can go wrong', () => {
  assert.strictEqual(domainFor('kotak-811-pitch'), 'kotak-811-pitch.surge.sh');
  for (const bad of ['', 'ab', 'Has Caps', '-lead', 'trail-', 'has space', 'a'.repeat(64), null]) {
    assert.throws(() => domainFor(bad), /invalid project name/, 'should reject ' + JSON.stringify(bad));
  }
});

await test('scrub removes the token from anything that could be logged or returned', () => {
  const t = 'sk-secret-token';
  assert.strictEqual(scrub('using ' + t + ' now, ' + t, t), 'using «token» now, «token»');
  assert.strictEqual(scrub('nothing to hide', t), 'nothing to hide');
  assert.strictEqual(scrub('', t), '');
});

/* ------------------------------------------------ a real dist/ ------- */

await test('render writes a complete, self-consistent dist/', async () => {
  const out = path.join(os.tmpdir(), 'pe-test-' + Date.now());
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6300010000050001', 'hex').toString('base64');

  const res = await render(payload, out, {
    title: 'Kotak 811',
    assets: { 'flat/03.png': png, 'flat/07.png': png, 'flat/35.png': png,
              'layers/03-00-vid.png': png, 'parts/01-00-a.png': png, 'parts/01-00-b.png': png },
    videoFiles: { v1: { src: 'video/v1.mp4', type: 'video/mp4' } },
  });

  const index = await fs.readFile(path.join(out, 'index.html'), 'utf8');
  const data = await fs.readFile(path.join(out, 'deck-data.js'), 'utf8');

  assert.ok(index.includes('<title>Kotak 811</title>'), 'title injected');
  assert.ok(!index.includes('__TITLE__'), 'no placeholder left behind');
  assert.ok(index.includes('DECODE_GATE_MS = 400'), 'the decode-gate cap survived the port');
  assert.ok(index.includes('--stagger:70ms'), 'the stagger constant survived the port');
  assert.ok(index.includes('cubic-bezier(.22,1,.36,1)'), 'the reveal easing survived the port');

  assert.ok(data.startsWith('/* generated'), 'data file is marked generated');
  const deck = JSON.parse(data.slice(data.indexOf('{'), data.lastIndexOf(';')));
  assert.strictEqual(deck.slides.length, 3);
  assert.strictEqual(deck.slides[0].overlays[0].kind, 'video');
  assert.strictEqual(deck.slides[1].layers.length, 2);

  // 200.html keeps #hash deep links working on Surge.
  await fs.access(path.join(out, '200.html'));
  await fs.access(path.join(out, 'flat', '35.png'));

  assert.strictEqual(res.slides, 3);
  assert.strictEqual(res.flatFallbacks, 1);
  assert.strictEqual(res.assets, 6);

  await fs.rm(out, { recursive: true, force: true });
});

await test('render clears a previous build rather than layering onto it', async () => {
  const out = path.join(os.tmpdir(), 'pe-stale-' + Date.now());
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6300010000050001', 'hex').toString('base64');
  await fs.mkdir(path.join(out, 'layers'), { recursive: true });
  await fs.writeFile(path.join(out, 'layers', 'stale.png'), 'x');
  await render(payload, out, { assets: {
    'flat/03.png': png, 'flat/07.png': png, 'flat/35.png': png,
    'layers/03-00-vid.png': png, 'parts/01-00-a.png': png, 'parts/01-00-b.png': png },
  });
  await assert.rejects(fs.access(path.join(out, 'layers', 'stale.png')),
    'a stale asset from a previous publish must not survive');
  await fs.rm(out, { recursive: true, force: true });
});

/* ------------------------------------------------ the toolbar -------- */
/* Regression cover for a real failure: the toolbar hid itself on `mouseleave`
   from #stage. Since the bar overlays the stage, reaching for a button IS a
   mouseleave — the bar went pointer-events:none and the click fell THROUGH to
   the click-to-advance handler. Every button sat inside the left 11% edge zone,
   so a click aimed at Next ran prev(). Measured in-browser: the old Next button
   centred at x=100 on a 1280px window, where the prev zone ends at x=141. */

const shellOf = async () => {
  const out = path.join(os.tmpdir(), 'pe-shell-' + Date.now());
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6300010000050001', 'hex').toString('base64');
  await render(payload, out, { assets: {
    'flat/03.png': png, 'flat/07.png': png, 'flat/35.png': png,
    'layers/03-00-vid.png': png, 'parts/01-00-a.png': png, 'parts/01-00-b.png': png },
  });
  const html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
  await fs.rm(out, { recursive: true, force: true });
  return html;
};

await test('the toolbar is never opacity-gated or made non-interactive', async () => {
  const html = await shellOf();
  assert.ok(!/show-chrome/.test(html),
    'the hover gate that hid the bar from under the cursor must not come back');
  assert.ok(!/#chrome\s*\{[^}]*pointer-events\s*:\s*none/.test(html),
    '#chrome must never be pointer-events:none — that is what let clicks fall through');
  assert.ok(!/is-grid\s+#chrome\s*\{[^}]*opacity\s*:\s*0/.test(html),
    'the toolbar must stay visible in the overview, not be traded away for it');
});

await test('the toolbar stacks ABOVE the overview, so it stays usable there', async () => {
  const html = await shellOf();
  const z = sel => {
    const m = new RegExp(sel + '\\{[^}]*z-index:(\\d+)').exec(html.replace(/\s*\n\s*/g, ''));
    return m ? Number(m[1]) : null;
  };
  const chrome = z('#chrome'), grid = z('#grid');
  assert.ok(chrome !== null && grid !== null, 'both need an explicit z-index');
  assert.ok(chrome > grid, 'chrome (' + chrome + ') must out-stack grid (' + grid + ')');
});

await test('next() and prev() move UNCONDITIONALLY — one input, one slide', () => {
  /* The reference deck's "first press completes a running build, the second
     advances" does not survive the port. Every navigation starts a build lasting
     the decode gate + REVEAL_MS + the stagger (~1.2s on a three-layer slide), so
     at any normal clicking pace EVERY first click landed inside one and was
     swallowed — the deck only moved on the second click, in both directions.
     Reported from the live preview after the first fix attempt, which had made
     the swallow window LONGER by extending it over the decode gate. */
  const shell = fsSync.readFileSync(path.join(HERE, '..', 'viewer', 'shell.html'), 'utf8');

  const nx = /function next\(\)\s*\{([\s\S]*?)\}/.exec(shell);
  const pv = /function prev\(\)\s*\{([\s\S]*?)\}/.exec(shell);
  assert.ok(nx && pv, 'next() and prev() must exist');
  assert.match(nx[1].trim(), /^go\(current \+ 1\);$/,
    'next() must be a bare go() — no branch may consume the click');
  assert.match(pv[1].trim(), /^go\(current - 1\);$/,
    'prev() must be a bare go() — no branch may consume the click');

  assert.ok(!/isRevealing/.test(shell),
    'the build-in-flight test is gone; reintroducing it re-swallows the first click');
  assert.ok(!/\.pending/.test(shell),
    'the pending flag only existed to widen that swallow window');
});

await test('prev and next are exact mirrors, so neither direction can drift', () => {
  const shell = fsSync.readFileSync(path.join(HERE, '..', 'viewer', 'shell.html'), 'utf8');
  const bodyOf = name =>
    new RegExp('function ' + name + '\\(\\)\\s*\\{([\\s\\S]*?)\\}').exec(shell)[1].trim();
  // Normalise the step's sign; anything else that differs is a real asymmetry.
  assert.strictEqual(
    bodyOf('next').replace('current + 1', 'current ± 1'),
    bodyOf('prev').replace('current - 1', 'current ± 1'),
    'next() and prev() must differ only in the sign of the step');
});

await test('the viewer ships NO progress bar', async () => {
  const html = await shellOf();
  assert.ok(!/id="progress"/.test(html), 'no progress element in the markup');
  assert.ok(!/#progress\s*\{/.test(html), 'no progress styles left behind');
  assert.ok(!/progress\.style/.test(html), 'nothing still writes to it');
});

await test('an overview caption is built ABOVE its thumbnail', () => {
  const shell = fsSync.readFileSync(path.join(HERE, '..', 'viewer', 'shell.html'), 'utf8');
  const cap = shell.indexOf('b.appendChild(cap)');
  const img = shell.indexOf('b.appendChild(ti)');
  assert.ok(cap > -1 && img > -1, 'both appends must exist');
  assert.ok(cap < img,
    'the caption must be appended first — a title under one thumbnail reads as ' +
    'the caption of the thumbnail BELOW it, and the reading order should match');
});

/* --------------------------------------- the blank-deck guard -------- */
/* Regression cover for a real failure: the plugin measured every PNG and then
   DISCARDED the bytes, and the publish body carried no assets at all. The deck
   deployed fine, loaded fine, navigated fine — and every image 404'd, so the
   client would have opened a set of blank slides. Silent, and only visible by
   opening the link. render() now refuses instead. */

await test('render REFUSES a payload whose bitmaps were never uploaded', async () => {
  const out = path.join(os.tmpdir(), 'pe-blank-' + Date.now());
  await assert.rejects(
    render(payload, out, { assets: {} }),
    /never uploaded|blank slides/,
    'a deck with no bitmaps must not render');
  await fs.rm(out, { recursive: true, force: true });
});

await test('render names what is missing, so the failure is actionable', async () => {
  const out = path.join(os.tmpdir(), 'pe-blank2-' + Date.now());
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6300010000050001', 'hex').toString('base64');
  // Everything present except one layer.
  try {
    await render(payload, out, { assets: {
      'flat/03.png': png, 'flat/07.png': png, 'flat/35.png': png,
      'parts/01-00-a.png': png, 'parts/01-00-b.png': png,
    }});
    assert.fail('should have refused');
  } catch (e) {
    assert.ok(Array.isArray(e.missing), 'carries the missing list');
    assert.deepStrictEqual(e.missing, ['layers/03-00-vid.png']);
  }
  await fs.rm(out, { recursive: true, force: true });
});

await test('render accepts bitmaps that were STAGED rather than inlined', async () => {
  const out = path.join(os.tmpdir(), 'pe-staged-' + Date.now());
  const stage = path.join(os.tmpdir(), 'pe-stage-' + Date.now());
  const bytes = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6300010000050001', 'hex');
  for (const rel of ['flat/03.png', 'flat/07.png', 'flat/35.png',
                     'layers/03-00-vid.png', 'parts/01-00-a.png', 'parts/01-00-b.png']) {
    const dest = path.join(stage, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
  }
  const res = await render(payload, out, { assetDir: stage });
  assert.strictEqual(res.assets, 6);
  await fs.access(path.join(out, 'layers', '03-00-vid.png'));
  await fs.rm(out, { recursive: true, force: true });
  await fs.rm(stage, { recursive: true, force: true });
});

/* ------------------------------------------------- fail closed ------- */
/* Regression cover for a real incident: a `dryRun` opt-OUT flag meant a payload
   that did not carry it deployed. A stale bridge process that predated the flag
   ignored it and published a test deck to a public URL. The safe state must be
   the default. */

await test('handlePublish does NOT deploy unless deploy === true', async () => {
  const { handlePublish } = await import('../server.mjs');
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6300010000050001', 'hex').toString('base64');
  const base = {
    project: 'fail-closed-test',
    slides: [{ no: 1, name: '01', w: 1440, h: 810, bg: '#fff', flat: 'flat/01.png',
               layers: [], videos: [] }],
    links: [], grain: [], videos: [], assets: { 'flat/01.png': png },
  };

  // Every shape that is not exactly `true` must build and stop.
  for (const deploy of [undefined, false, 'true', 1, null, {}]) {
    const r = await handlePublish({ ...base, deploy });
    assert.strictEqual(r.url, null, 'deploy=' + JSON.stringify(deploy) + ' must not publish');
    assert.strictEqual(r.deployed, false);
  }
});

await test('handlePublish refuses a payload with no slides or no project', async () => {
  const { handlePublish } = await import('../server.mjs');
  await assert.rejects(handlePublish({ project: 'x', slides: [] }), /no slides/);
  await assert.rejects(handlePublish({ slides: [{ no: 1 }] }), /no project name/);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
