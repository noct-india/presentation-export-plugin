/**
 * Turn an extraction payload into a deployable dist/.
 *
 * The viewer SHELL is constant — ported from the proven Kotak deck and never
 * re-authored per publish, because it carries behaviour whose reasons are not
 * inferable from a payload ("muted MUST be set before a source is attached",
 * "paused === false is not proof", "never remove the cap"). What varies per deck
 * is DATA: which grain each layer reveals at, the reveal order, the link and
 * video overlays. That is the split the live deck already uses — index.html plus
 * window.DECK_LAYERS — and it is preserved here.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.join(HERE, 'viewer', 'shell.html');

/**
 * Resolve `auto` grain for one layer.
 *
 * Rule: split when EVERY part is text — a copy block staggers line by line and
 * reads as deliberate. Keep whole otherwise, because splitting artwork reveals
 * pieces of a picture, which reads as a loading bug rather than a build.
 * Explicit coarse/fine from the designer always wins over this.
 */
export function resolveGrain(layer, choice) {
  if (!layer.parts || layer.parts.length < 2) return 'coarse';
  if (choice === 'coarse' || choice === 'fine') return choice;
  const allText = layer.parts.every(p => p.type === 'TEXT');
  return allText ? 'fine' : 'coarse';
}

/** Flatten one slide's layers to the grain actually being published. */
export function layersAtGrain(slide, grainById = {}) {
  const out = [];
  for (const L of slide.layers || []) {
    const grain = resolveGrain(L, grainById[L.id]);
    if (grain === 'fine' && L.parts && L.parts.length > 1) {
      // Parts are ALTERNATES: emit the parts INSTEAD of their parent, never both,
      // or the group paints twice — once whole and once in pieces.
      // parentOrder keeps a split group inside its own z-order band.
      for (const p of L.parts) out.push({ ...p, from: L.id, parentOrder: L.order });
    } else {
      out.push(L);
    }
  }
  // The stagger index is positional and must be contiguous after the swap:
  // a gap in --i shows as a visible hitch mid-reveal.
  return out.map((l, i) => ({ ...l, i }));
}

/**
 * Where a video's media sits inside its clipping window, and how it fits.
 *
 * The whole point: we never need the video's intrinsic pixel size — Figma will
 * not tell us, and CSS computes cover/contain from the media's own aspect ratio
 * at runtime. What we must supply is the MEDIA'S BOX and the WINDOW that clips
 * it. Figma returns both rects on every node, so this derives for any layout at
 * any nesting depth rather than being hand-authored per deck.
 *
 *   window (v.rect)  = absoluteRenderBounds — what survives ancestor clipping
 *   media  (v.box)   = absoluteBoundingBox  — the node's own, unclipped box
 *
 * Returns media geometry RELATIVE TO THE WINDOW, plus the object-fit to use.
 */
export function videoGeometry(v) {
  const win = v.rect;
  if (!win) return null;
  const box = v.box || win;

  let x = box.x - win.x, y = box.y - win.y, w = box.w, h = box.h;
  let fit = 'cover', warn = null;

  const mode = String(v.scaleMode || 'FILL').toUpperCase();

  if (mode === 'FIT') {
    fit = 'contain';                       // letterbox, exactly like Figma's FIT
  } else if (mode === 'CROP') {
    /* CROP carries its framing in videoTransform: a matrix mapping node space
       into normalised media space. Inverting it gives the media's full size and
       offset, after which object-fit has nothing left to decide — hence 'fill'. */
    const t = v.transform;
    const a = t && t[0] && t[0][0], d = t && t[1] && t[1][1];
    const b = t && t[1] && t[1][0], c = t && t[0] && t[0][1];
    if (t && a && d && !b && !c) {
      const fullW = w / a, fullH = h / d;
      x += -t[0][2] * fullW;
      y += -t[1][2] * fullH;
      w = fullW; h = fullH;
      fit = 'fill';
    } else {
      // A rotated or skewed crop cannot be reproduced without the media's own
      // pixel size. Degrade visibly and say so, rather than render it subtly wrong.
      warn = 'CROP uses a rotated or skewed transform — not reproducible, showing cover';
      fit = 'cover';
    }
  } else if (mode === 'TILE') {
    warn = 'TILE has no <video> equivalent — showing cover';
    fit = 'cover';
  }

  const r = n => +Number(n).toFixed(2);
  return { x: r(x), y: r(y), w: r(w), h: r(h), fit, warn };
}

/**
 * Paint order, taken from Figma's hierarchy rather than from DOM order.
 *
 * Layers are appended in REVEAL order (revealOrder reorders for the animation),
 * so DOM order is not Figma order and cannot be used for painting. Each layer
 * gets its Figma child index scaled by 100; a split part sits inside its
 * parent's band; a video sits mid-band, above its own layer — whose PNG is the
 * poster frame — and below the next sibling.
 */
export function zIndexFor(layer, fallback = 0) {
  const own = Number.isFinite(layer.order) ? layer.order : fallback;
  if (Number.isFinite(layer.parentOrder)) return layer.parentOrder * 100 + own + 1;
  return own * 100;
}

/**
 * The nest of clipping boxes a video sits inside, outermost first, each in slide
 * coordinates. The viewer renders one wrapper per entry.
 *
 * A video's shape is rarely its own — a rounded frame with clipsContent, or a
 * mask sibling, is usually what cuts it. Each clip contributes a rounded rect or
 * a mask shape, and nesting them reproduces the intersection exactly, at any
 * depth, without CSS having to intersect anything itself.
 *
 * The video's OWN rounding becomes the innermost entry, so a rounded video
 * inside a rounded frame keeps both.
 */
export function clipBoxes(v) {
  const out = [];
  for (const c of v.clips || []) {
    if (!c || !c.rect) continue;
    const mask = c.mask && c.mask.rect ? c.mask : null;
    // A mask cuts at ITS rect, which may be tighter than its parent's.
    if (mask) {
      out.push({
        rect: mask.rect,
        radius: mask.radius && mask.radius.some(r => r > 0) ? mask.radius : null,
        path: mask.path || null,
        pathBox: mask.box || null,
      });
    }
    if (c.radius && c.radius.some(r => r > 0)) {
      out.push({ rect: c.rect, radius: c.radius, path: null, pathBox: null });
    }
  }
  // The node's own rounding, applied last and tightest.
  const own = v.box || v.rect;
  if (own && Array.isArray(v.radius) && v.radius.some(r => r > 0)) {
    out.push({ rect: own, radius: v.radius, path: null, pathBox: null });
  }
  return out;
}

/** Overlays: links the designer kept, plus a video slot per supplied clip. */
export function overlaysFor(slide, links, videoFiles) {
  const out = [];

  for (const l of links) {
    if (l.slide !== slide.no) continue;
    if (!l.rect) continue;                       // no geometry, no hotspot
    if (l.linkType === 'NODE') continue;         // in-deck jumps are not links out
    out.push({
      kind: 'link',
      x: l.rect.x, y: l.rect.y, w: l.rect.w, h: l.rect.h,
      href: l.value,
      label: l.text || l.nodeName || l.value,
    });
  }

  for (const v of slide.videos || []) {
    const file = videoFiles[v.nodeId];
    if (!file || !v.rect) continue;              // unpaired: the still stands in

    /* The node's OWN exported bitmap is Figma's poster frame, so a poster costs
       nothing to provide and finally gives useFallback() something to show when
       autoplay is refused — it used to bail on `if (!fb) return`. Only present
       when this node was exported as its own layer or part. */
    const ownBitmap =
      (slide.layers || []).find(L => L.id === v.nodeId) ||
      (slide.layers || []).flatMap(L => L.parts || []).find(p => p.id === v.nodeId);

    out.push({
      kind: 'video',
      // The wrapper is the CLIPPING WINDOW; the media is placed inside it.
      x: v.rect.x, y: v.rect.y, w: v.rect.w, h: v.rect.h,
      media: videoGeometry(v),
      // Every shape that cuts this video, outermost first. Supersedes `radius`,
      // which is kept only so an older deck still rounds its own corners.
      clips: clipBoxes(v),
      radius: Array.isArray(v.radius) && v.radius.some(r => r > 0) ? v.radius : null,
      z: Number.isFinite(v.z) && v.z >= 0 ? v.z * 100 + 50 : null,
      /* One FILE, but possibly several type hints for it — a browser checks a
         source's type with canPlayType before fetching, so a container it will
         actually demux can still be skipped when told only its strictest name.
         The designer is never asked for a second encode; these all point at the
         same bytes. */
      sources: (Array.isArray(file.types) && file.types.length ? file.types : [file.type || 'video/mp4'])
        .map(type => ({ src: file.src, type })),
      poster: v.poster || (ownBitmap ? ownBitmap.src : null),
      /* The SAME still, as a real <img> the viewer can swap in. A poster only
         shows until playback starts; if the browser cannot decode the container
         at all — QuickTime in Chrome, always in Firefox — the element has no
         intrinsic size, object-fit has nothing to fit, and the video reads as a
         collapsed empty box. An <img> has no codec to refuse and no autoplay
         policy, so the slide falls back to exactly what Figma drew. */
      fallback: v.fallback || v.poster || (ownBitmap ? ownBitmap.src : null),
      label: v.nodeName || '',
    });
  }

  return out;
}

/** Build the window.DECK object the shell consumes. */
export function buildDeckData(payload, opts = {}) {
  const grainById = {};
  for (const g of payload.grain || []) grainById[g.id] = g.grain;
  const links = payload.links || [];
  const videoFiles = opts.videoFiles || {};

  const first = payload.slides[0] || {};
  return {
    title: opts.title || payload.project || '',
    w: first.w || 1440,
    h: first.h || 810,
    generator: 'presentation-export-plugin',
    slides: payload.slides.map(s => ({
      no: s.no,
      title: s.name || '',
      bg: s.bg || '#fcfcfc',
      flat: s.flat,
      layers: layersAtGrain(s, grainById).map((l, i) => ({
        src: l.src, x: l.x, y: l.y, w: l.w, h: l.h, full: !!l.full,
        z: zIndexFor(l, i),
      })),
      overlays: overlaysFor(s, links, videoFiles),
    })),
  };
}

/** Write dist/: shell, data, and every asset. Returns a manifest of what landed. */
export async function render(payload, outDir, opts = {}) {
  const shell = await fs.readFile(SHELL, 'utf8');
  const title = opts.title || payload.project || 'Presentation';

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const written = [];

  /* Bitmaps normally arrive by being STAGED first — the plugin uploads them in
     batches while publishing, because a 41-slide deck is tens of megabytes and
     one JSON body carrying all of it base64-inflated is a bad shape. Staging
     lives outside outDir because render() clears outDir first. */
  if (opts.assetDir) {
    try {
      await fs.cp(opts.assetDir, outDir, { recursive: true });
      written.push(...await listFiles(opts.assetDir));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  // Inline assets are still supported, for tests and small decks.
  for (const [rel, b64] of Object.entries(opts.assets || {})) {
    const dest = path.join(outDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, Buffer.from(b64, 'base64'));
    written.push(rel);
  }

  const deck = buildDeckData(payload, opts);

  /* A deck whose bitmaps never arrived renders as a page of blank slides — it
     loads, it navigates, and every image 404s. That is a silent failure the
     designer only discovers by opening the link, so refuse it here instead.
     Checked against the RESOLVED deck, not the raw payload: at fine grain a
     layer is replaced by its parts, so its own bitmap is legitimately unused. */
  const wanted = new Set();
  for (const s of deck.slides) {
    if (s.flat) wanted.add(s.flat);
    for (const l of s.layers) if (l.src) wanted.add(l.src);
  }
  const have = new Set(written);
  const missing = [...wanted].filter(w => !have.has(w));
  if (missing.length) {
    const err = new Error(
      missing.length + ' of ' + wanted.size + ' bitmaps were never uploaded — the deck would ' +
      'publish as blank slides. First missing: ' + missing.slice(0, 3).join(', '));
    err.missing = missing;
    throw err;
  }
  await fs.writeFile(path.join(outDir, 'deck-data.js'),
    '/* generated by the presentation-export bridge — do not edit by hand */\n' +
    'window.DECK = ' + JSON.stringify(deck, null, 1) + ';\n');

  await fs.writeFile(path.join(outDir, 'index.html'),
    shell.replace('__TITLE__', escapeHtml(title)));

  // Surge serves 200.html for unknown paths, which keeps #hash deep links working.
  await fs.copyFile(path.join(outDir, 'index.html'), path.join(outDir, '200.html'));

  const layerCount = deck.slides.reduce((a, s) => a + s.layers.length, 0);
  const flatOnly = deck.slides.filter(s => !s.layers.length).length;
  return {
    outDir, assets: written.length, slides: deck.slides.length,
    layers: layerCount, flatFallbacks: flatOnly,
    overlays: deck.slides.reduce((a, s) => a + s.overlays.length, 0),
  };
}

/** Every file under a directory, as paths relative to it, with forward slashes. */
async function listFiles(root, base = '') {
  const out = [];
  for (const e of await fs.readdir(path.join(root, base), { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...await listFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
