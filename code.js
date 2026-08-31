/**
 * Presentation export — EXTRACTOR (Phase 1)
 *
 * Turns a deck of Figma slide frames into a design payload: per-slide geometry,
 * a proposed reveal order, link targets, video slots, and one transparent 2x PNG
 * per layer. Claude authors the web page from that payload; this file decides
 * nothing about how the deck should look.
 *
 * WHY LAYERS AND NOT SLIDE IMAGES
 * A flat slide render is one element, so nothing in it can stagger. Each slide
 * becomes a stack of separately exported children positioned at their own rects,
 * so the viewer can reveal them in sequence without re-typesetting anything.
 *
 * ANCHOR RECT — settled empirically in Phase 0
 * exportAsync crops TEXT to its ink AND clips a shape to its parent, and
 * absoluteRenderBounds describes both. 27 decisive samples across 4 slides, all
 * on render, none on box. Box is kept only as an assertion fallback. Note this
 * DIFFERS from the MCP/REST route, where the export held the whole unclipped
 * shape and box sometimes won — do not port that assumption back in.
 *
 * WHAT THIS FILE DOES NOT DO
 * No pixel work. The plugin sandbox has no canvas, so alpha inspection (dropping
 * empty spacer frames, trap 3) and the anchor assertion happen UI-side, where a
 * canvas exists. This file streams bytes out and lets the UI decide.
 *
 * Read-only against the document.
 */

var SCALE = 2;
var FULL_BLEED_RATIO = 0.85;   // >= this share of the slide fades without translating
var READING_BAND = 24;         // top edges within this many px count as the same row
var ANCHOR_TOL = 1.0;          // export rounds up to whole device px

// Hosts that almost never belong in a client-facing deck. Phase 0 found a live
// docs.google.com link inside slide 41's body text.
var INTERNAL_HOSTS = [
  'docs.google.com', 'drive.google.com', 'figma.com', 'notion.so',
  'slack.com', 'dropbox.com', 'airtable.com', 'localhost',
];

/* ------------------------------------------------------------------ pure --- */
/* Everything below is testable in Node — no figma global.                     */

function slug(name) {
  return String(name || 'layer')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'layer';
}

function rgbHex(c) {
  function h(v) {
    var s = Math.round(v * 255).toString(16);
    return s.length < 2 ? '0' + s : s;
  }
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

/** Last visible solid fill on a node, or null. */
function solidFillHex(node) {
  var fills = node && node.fills;
  if (!Array.isArray(fills)) return null;
  for (var i = fills.length - 1; i >= 0; i--) {
    var f = fills[i];
    if (f.visible !== false && f.type === 'SOLID') return rgbHex(f.color);
  }
  return null;
}

function isFullBleed(rect, slideW, slideH) {
  if (!rect || !slideW || !slideH) return false;
  return (rect.w * rect.h) >= FULL_BLEED_RATIO * slideW * slideH;
}

/**
 * Proposed reveal order: backdrops first, then reading order — top edge banded
 * so near-level items share a row, then left edge.
 *
 * This is a PROPOSAL, not a rule. The Kotak deck deliberately reverses Figma's
 * child order on slide 8, and the payload carries the raw order alongside so a
 * human or Claude can override. Order IS reveal order downstream.
 */
function revealOrder(layers, slideW, slideH) {
  return layers.slice().sort(function (a, b) {
    var af = isFullBleed(a, slideW, slideH);
    var bf = isFullBleed(b, slideW, slideH);
    if (af !== bf) return af ? -1 : 1;

    var ab = Math.floor(a.y / READING_BAND);
    var bb = Math.floor(b.y / READING_BAND);
    if (ab !== bb) return ab - bb;

    if (a.x !== b.x) return a.x - b.x;
    return a.order - b.order;             // stable: fall back to Figma order
  });
}

/**
 * Which rect the exported pixels actually describe.
 * Render first — Phase 0 says it always wins — with box as an assertion
 * fallback so a future Figma change surfaces as a warning rather than a
 * silently misplaced layer.
 */
function pickAnchor(box, render, exW, exH, tol) {
  if (tol === undefined) tol = ANCHOR_TOL;
  var cands = [];
  if (render) cands.push({ which: 'render', r: render });
  if (box) cands.push({ which: 'box', r: box });

  var best = null;
  for (var i = 0; i < cands.length; i++) {
    var err = Math.max(
      Math.abs(cands[i].r.w - exW),
      Math.abs(cands[i].r.h - exH)
    );
    if (err <= tol) return { which: cands[i].which, rect: cands[i].r, err: err, ok: true };
    if (!best || err < best.err) best = { which: cands[i].which, rect: cands[i].r, err: err };
  }
  if (!best) return null;
  best.ok = false;                        // caller warns; layer still ships
  return best;
}

/** Leading number in a slide name ("35 · Our approach" -> 35), else null. */
function slideNumber(name) {
  var m = /^\s*(\d{1,3})\b/.exec(String(name || ''));
  return m ? parseInt(m[1], 10) : null;
}

function isInternalUrl(url) {
  var s = String(url || '').toLowerCase();
  for (var i = 0; i < INTERNAL_HOSTS.length; i++) {
    if (s.indexOf('//' + INTERNAL_HOSTS[i]) !== -1 ||
        s.indexOf('.' + INTERNAL_HOSTS[i]) !== -1) return true;
  }
  return false;
}

/**
 * Flatten Reaction.actions into URL strings. Reads `actions` with a fallback to
 * the deprecated singular `action` (old files still carry it), and recurses into
 * CONDITIONAL blocks, which can nest a URL action.
 *
 * NOTE: unexercised. The Kotak fixture is a .pptx conversion with zero
 * reactions and zero instances, so this path rests on the API docs alone.
 */
function urlActions(node) {
  var found = [];
  var reactions = node && node.reactions;
  if (!reactions || !reactions.length) return found;

  function walk(actions) {
    for (var i = 0; i < (actions || []).length; i++) {
      var a = actions[i];
      if (!a) continue;
      if (a.type === 'URL' && a.url) found.push(a.url);
      if (a.type === 'CONDITIONAL') {
        var blocks = a.conditionalBlocks || [];
        for (var b = 0; b < blocks.length; b++) walk(blocks[b].actions);
      }
    }
  }
  for (var r = 0; r < reactions.length; r++) {
    var rx = reactions[r];
    walk(rx.actions || (rx.action ? [rx.action] : []));
  }
  return found;
}

/**
 * Hyperlinks on a text node, one entry per styled range.
 *
 * Figma gives no per-character bounding box, so a link that covers only part of
 * a text node cannot get a tight hotspot. Those are emitted with partial:true
 * and the whole node's rect — deliberately visible in the payload rather than
 * quietly approximated.
 */
function textLinks(node, onError) {
  var out = [];
  if (!node || node.type !== 'TEXT') return out;

  /* ⚠️ TWO INDEPENDENT DETECTION PATHS, and the second is not optional.
     Figma throws when a property is read off a node it considers inaccessible,
     which includes invisible ones in some editor states — and this catch used to
     `return out` with no trace at all. That silence is how a hyperlink on a
     hidden layer vanished from the extraction across three rounds of debugging:
     the link was never reported missing, it simply was not there.
     Nothing here changes what a VISIBLE link produces — the segment path runs
     first and wins whenever it yields anything, exactly as before. */
  var segs = null;
  try {
    segs = node.getStyledTextSegments(['hyperlink']);
  } catch (e) {
    if (onError) onError(node, 'getStyledTextSegments failed — ' + errText(e));
  }

  var total = 0;
  try { total = (node.characters || '').length; } catch (e) { total = 0; }

  if (segs) {
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s.hyperlink) continue;
      out.push({
        kind: 'text',
        linkType: s.hyperlink.type,          // "URL" | "NODE"
        value: s.hyperlink.value,            // NODE means a node id, not a url
        text: (s.characters || '').slice(0, 120),
        start: s.start,
        end: s.end,
        partial: !(s.start === 0 && s.end === total),
      });
    }
  }
  if (out.length) return out;

  /* Fallback: TextNode.hyperlink is a different, simpler API — a HyperlinkTarget
     when exactly ONE link covers the whole node, which is what applying a link to
     a whole text layer produces. It is read separately from the segment API, so a
     whole-node link survives the segment call throwing or coming back empty.
     Only consulted when the segment path found nothing, so it can never change,
     duplicate or override a link the segment path already reported. */
  try {
    var h = node.hyperlink;
    var isMixed = typeof figma !== 'undefined' && figma && h === figma.mixed;
    if (h && !isMixed && h.value) {
      var chars = '';
      try { chars = (node.characters || '').slice(0, 120); } catch (e) { chars = ''; }
      out.push({
        kind: 'text', linkType: h.type || 'URL', value: h.value,
        text: chars, start: 0, end: total,
        partial: false,                      // by definition: it covers the node
        via: 'hyperlink',                    // which path found it, for diagnostics
      });
    }
  } catch (e) {
    if (onError) onError(node, 'hyperlink property unreadable — ' + errText(e));
  }

  return out;
}

/** Message out of anything throwable, without assuming it is an Error. */
function errText(e) {
  if (!e) return 'unknown';
  return String(e.message || e);
}

/**
 * A URL written into a LAYER NAME, or null.
 *
 * Some files carry the link as the layer's name rather than as Figma hyperlink
 * metadata — the URL is in `node.name` and appears in no text segment, no
 * `TextNode.hyperlink`, and no prototype reaction, so every native path
 * correctly reports nothing.
 *
 * Deliberately a general rule, not a pattern for one file: find an http(s) URL
 * anywhere in the name, trim trailing punctuation that reads as prose rather
 * than address, and require a host that is either dotted or localhost. Any
 * layer name in any file is handled the same way.
 */
function urlFromName(name) {
  var s;
  try { s = String(name == null ? '' : name); } catch (e) { return null; }

  var m = /https?:\/\/[^\s<>"'`\\|]+/i.exec(s);
  if (!m) return null;

  /* A name like "CTA (https://x.com/a)." or "see https://x.com/a," ends with
     characters that belong to the sentence, not the address. Closing brackets
     are only trimmed when unbalanced, so a genuine trailing ")" in a URL
     survives. */
  var url = m[0].replace(/[.,;:!?'"]+$/, '');
  while (/[)\]}]$/.test(url)) {
    var close = url.slice(-1);
    var open = close === ')' ? '(' : (close === ']' ? '[' : '{');
    // Equal counts means the bracket is balanced and belongs to the URL.
    if (url.split(open).length >= url.split(close).length) break;
    url = url.slice(0, -1).replace(/[.,;:!?'"]+$/, '');
  }

  var host = /^https?:\/\/([^\/?#\s]*)/i.exec(url);
  if (!host) return null;
  var h = host[1];
  if (!h || /^\.+$/.test(h)) return null;
  // A real host is dotted (example.com) or localhost, optionally with a port.
  if (!/\./.test(h) && !/^localhost(:\d+)?$/i.test(h)) return null;
  if (/\.$/.test(h.split(':')[0])) return null;                    // "http://x." is not a host

  return url;
}

/* --------------------------------------------------------------- figma --- */

function rectOf(r, originX, originY) {
  if (!r) return null;
  return {
    x: +(r.x - originX).toFixed(2),
    y: +(r.y - originY).toFixed(2),
    w: +r.width.toFixed(2),
    h: +r.height.toFixed(2),
  };
}

/**
 * Geometry for one child of a slide (or one child of a grouping layer).
 * Returns null when the node renders nothing, so there is nothing to place.
 */
function describeChild(c, order, ox, oy, slideW, slideH) {
  if (!c || c.visible === false) return null;

  /* ⚠️ A MASK IS NOT CONTENT — it defines what its siblings show.
     Exported as its own layer it paints the mask SHAPE, a solid blob that
     appears nowhere in the design, while the siblings it masks export unmasked.
     Skipped as a layer only. TRAVERSAL IS UNTOUCHED: everyNode still descends
     through masks, so links, videos, images and the census inside one are swept
     exactly as they are anywhere else. */
  if (c.isMask === true) return null;

  var rBox = rectOf(c.absoluteBoundingBox, ox, oy);
  var rRen = rectOf(c.absoluteRenderBounds, ox, oy);
  var anchor = rRen || rBox;
  if (!anchor) return null;
  return {
    id: c.id, name: c.name, type: c.type,
    order: order,
    box: rBox, render: rRen,
    x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h,
    full: isFullBleed(anchor, slideW, slideH),
    slug: slug(c.name),
    // How many children this layer groups — what tells Claude whether splitting
    // it would make the reveal finer.
    kids: ('children' in c) ? c.children.filter(function (k) {
      return k.visible !== false;
    }).length : 0,
    /* Whether this container is held together by a mask. A masked group renders
       correctly ONLY when the group is exported whole — Figma applies the mask
       at that level — so it must never be split into parts. */
    hasMask: hasMaskChild(c),
  };
}

/** A finite number, or null — `figma.mixed` is a symbol and must not slip past. */
function finiteNum(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/**
 * Corner radii as [topLeft, topRight, bottomRight, bottomLeft], or null when
 * the node has square corners.
 *
 * A video fill is painted by a SHAPE, and that shape's rounding is part of how
 * the video looks — a rounded card of video came out as a hard-edged rectangle
 * because nothing read this. Per-corner values win over the uniform
 * `cornerRadius`, which reports `figma.mixed` the moment corners differ.
 */
function cornerRadii(node) {
  if (!node) return null;
  var tl = finiteNum(node.topLeftRadius), tr = finiteNum(node.topRightRadius),
      br = finiteNum(node.bottomRightRadius), bl = finiteNum(node.bottomLeftRadius);

  if (tl === null && tr === null && br === null && bl === null) {
    var uniform = finiteNum(node.cornerRadius);
    if (!uniform) return null;
    return [uniform, uniform, uniform, uniform];
  }
  tl = tl || 0; tr = tr || 0; br = br || 0; bl = bl || 0;
  if (!tl && !tr && !br && !bl) return null;
  return [tl, tr, br, bl];
}

/**
 * The mask that shapes a container's children, or null.
 *
 * A mask clips its SIBLINGS, so the shape that actually cuts a video is the mask
 * node sitting beside it. `fillGeometry` gives that shape as an SVG path in the
 * node's own coordinates — which is what turns "a custom vector mask" from an
 * unreproducible blob into something CSS can apply.
 */
function maskOf(container, ox, oy) {
  if (!container || !('children' in container) || !container.children) return null;
  for (var i = 0; i < container.children.length; i++) {
    var k = container.children[i];
    if (!k || k.isMask !== true || k.visible === false) continue;
    var b = k.absoluteBoundingBox;
    var geo = k.fillGeometry;
    var d = (Array.isArray(geo) && geo.length && geo[0] && geo[0].data) ? geo[0].data : null;
    return {
      rect: rectOf(b, ox, oy),
      radius: cornerRadii(k),
      // Null for a plain rectangular mask — radius alone reproduces those, and a
      // path is only worth carrying when the shape is genuinely custom.
      path: d,
      box: b ? { w: +b.width.toFixed(2), h: +b.height.toFixed(2) } : null,
      type: k.type || null,
    };
  }
  return null;
}

/**
 * Every ancestor that visually clips this node, OUTERMOST FIRST.
 *
 * ⚠️ A VIDEO'S SHAPE IS RARELY ITS OWN. Reading `cornerRadius` off the node that
 * carries the video fill misses the usual Figma construction entirely: a FRAME
 * with rounded corners and `clipsContent`, holding a square-cornered rectangle
 * that carries the fill. The rounding lives on the frame, so the video published
 * with hard corners while Figma showed it rounded. The same applies to a mask
 * group — the shape doing the cutting is a sibling, not the video node.
 *
 * Walks to the slide frame and stops: the slide is the viewport, not a clip.
 */
function clipChain(node, frame, ox, oy) {
  var chain = [];
  var n = node && node.parent, hops = 0;
  while (n && n !== frame && hops < 64) {
    var mask = maskOf(n, ox, oy);
    var clips = n.clipsContent === true;
    if (clips || mask) {
      chain.push({
        id: n.id, name: n.name,
        rect: rectOf(n.absoluteBoundingBox, ox, oy),
        radius: clips ? cornerRadii(n) : null,
        mask: mask,
      });
    }
    n = n.parent; hops++;
  }
  chain.reverse();                   // outermost first, so wrappers nest naturally
  return chain;
}

/** Does this container hold a mask among its own children? */
function hasMaskChild(c) {
  if (!c || !('children' in c) || !c.children) return false;
  for (var i = 0; i < c.children.length; i++) {
    var k = c.children[i];
    if (k && k.isMask === true && k.visible !== false) return true;
  }
  return false;
}

function videoFills(node) {
  var fills = node && node.fills;
  if (!Array.isArray(fills)) return [];
  var out = [];
  for (var i = 0; i < fills.length; i++) {
    var f = fills[i];
    if (f.type === 'VIDEO' && f.visible !== false) {
      // videoHash is a dead end — no API consumes it. Recorded only so the UI
      // can pair a designer-supplied file to the right node.
      out.push({
        videoHash: f.videoHash || null,
        scaleMode: f.scaleMode || null,
        /* How the paint sits inside the node. scaleMode alone is not enough:
           CROP carries its framing in videoTransform, and TILE its repeat size
           in scalingFactor. Both were being discarded, which is why every video
           came out as a hardcoded object-fit:cover regardless of Figma. */
        videoTransform: f.videoTransform || null,
        scalingFactor: typeof f.scalingFactor === 'number' ? f.scalingFactor : null,
      });
    }
  }
  return out;
}

/**
 * Index of the slide-frame child that this node sits under, or -1.
 *
 * A video's z-order on the web has to match its place in the Figma hierarchy,
 * and the unit that matters is the TOP-LEVEL layer: everything below a direct
 * child of the slide is flattened into that child's exported PNG, so the video
 * only needs to sit above its own layer and below the next one.
 */
function topLevelIndex(node, frame) {
  if (!node || !frame || node === frame) return -1;
  var n = node, hops = 0;
  while (n && n.parent && n.parent !== frame && hops < 64) { n = n.parent; hops++; }
  if (!n || n.parent !== frame) return -1;
  var kids = frame.children || [];
  for (var i = 0; i < kids.length; i++) if (kids[i] === n) return i;
  return -1;
}

/**
 * Census of what a node actually is and what it is painted with.
 *
 * Exists because "no videos found" is not evidence of "no video present": a
 * video can hide as an EMBED node, as an animated GIF (an IMAGE fill, since the
 * Plugin API has no gifHash), or behind `figma.mixed` fills, which the
 * Array.isArray guard in videoFills silently skips. This reports all of it so
 * absence can be distinguished from a blind spot.
 */
function census(node, acc) {
  acc.types[node.type] = (acc.types[node.type] || 0) + 1;

  var fills = node.fills;
  if (fills === undefined) return acc;
  if (!Array.isArray(fills)) {
    // figma.mixed — a symbol, not an array. Worth counting: it is exactly the
    // case videoFills cannot see into.
    acc.fills.MIXED = (acc.fills.MIXED || 0) + 1;
    acc.mixedNodes.push({ id: node.id, name: node.name, type: node.type });
    return acc;
  }
  for (var i = 0; i < fills.length; i++) {
    var t = fills[i].type;
    acc.fills[t] = (acc.fills[t] || 0) + 1;
    if (t === 'IMAGE' || t === 'VIDEO') {
      acc.mediaNodes.push({
        id: node.id, name: node.name, nodeType: node.type,
        fill: t, hash: fills[i].imageHash || fills[i].videoHash || null,
        visible: fills[i].visible !== false,
      });
    }
  }
  return acc;
}

function newCensus() {
  return { types: {}, fills: {}, mediaNodes: [], mixedNodes: [] };
}

/**
 * Identify an image from its magic bytes, and say whether it ANIMATES.
 *
 * This matters because every layer ships as an exportAsync PNG, and exporting an
 * animated GIF flattens it to a single frozen frame — silently. Unlike video,
 * the fix is available: Image.getBytesAsync returns the real file, so an
 * animated fill can be shipped as its own bytes instead of a render.
 *
 * Pure and byte-only, so it is testable without Figma.
 */
function sniffImage(bytes) {
  var b = bytes;
  if (!b || b.length < 12) return { format: 'unknown', animated: false };

  // GIF87a / GIF89a — animated when more than one Graphic Control Extension.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    var gce = 0;
    for (var i = 0; i < b.length - 1; i++) {
      if (b[i] === 0x21 && b[i + 1] === 0xF9) { gce++; if (gce > 1) break; }
    }
    return { format: 'gif', animated: gce > 1 };
  }

  // PNG — animated only if an acTL chunk appears before the first IDAT (APNG).
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
    for (var p = 8; p < b.length - 4; p++) {
      if (b[p] === 0x61 && b[p + 1] === 0x63 && b[p + 2] === 0x54 && b[p + 3] === 0x4C) {
        return { format: 'apng', animated: true };
      }
      if (b[p] === 0x49 && b[p + 1] === 0x44 && b[p + 2] === 0x41 && b[p + 3] === 0x54) break;
    }
    return { format: 'png', animated: false };
  }

  if (b[0] === 0xFF && b[1] === 0xD8) return { format: 'jpeg', animated: false };

  // RIFF....WEBP — animated when an ANIM chunk is present.
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    var cap = Math.min(b.length - 4, 4096);
    for (var w = 12; w < cap; w++) {
      if (b[w] === 0x41 && b[w + 1] === 0x4E && b[w + 2] === 0x49 && b[w + 3] === 0x4D) {
        return { format: 'webp', animated: true };
      }
    }
    return { format: 'webp', animated: false };
  }

  return { format: 'unknown', animated: false };
}

/**
 * Frame-relative rect for a node whose render AND bounding boxes are both null.
 *
 * ⚠️ THIS IS WHY HIDDEN LINKS PRODUCED NO HOTSPOT.
 * Figma returns null for `absoluteRenderBounds` **and** `absoluteBoundingBox` on
 * any node that is invisible or has an invisible ancestor — both describe what is
 * RENDERED, and nothing is. (A node can even have `visible === true` and still
 * get null boxes, purely because a parent is hidden.) So a hidden link was
 * extracted with `rect: null`, and the renderer drops a rect-less link, so no
 * <a> ever reached the page. Sweeping the link was necessary but not sufficient.
 *
 * x/y/width/height survive regardless — they are LAYOUT, not render.
 * `absoluteTransform` is preferred: its tx/ty are already absolute and it stays
 * correct under a rotated or scaled ancestor, which summing offsets does not.
 * The parent-chain sum is the fallback for anything that lacks it.
 *
 * Only ever reached when both boxes are null, so a visible node cannot take this
 * path and render-first anchoring is untouched.
 */
function geometricRect(node, originX, originY, root) {
  if (!node || typeof node.width !== 'number' || typeof node.height !== 'number') return null;
  if (!isFinite(node.width) || !isFinite(node.height)) return null;

  // Absolute transform: [[a, c, tx], [b, d, ty]] — tx/ty are absolute canvas px.
  var t = node.absoluteTransform;
  if (t && t[0] && t[1] && isFinite(t[0][2]) && isFinite(t[1][2])) {
    return rectOf({ x: t[0][2], y: t[1][2], width: node.width, height: node.height },
                  originX, originY);
  }

  /* Fallback: sum x/y up to (not including) the slide frame. The result is
     ALREADY frame-relative, so unlike the transform path it takes no origin
     subtraction — mixing those two spaces would place every hotspot twice-offset. */
  var x = 0, y = 0, hops = 0;
  for (var n = node; n && n !== root && hops < 64; n = n.parent, hops++) {
    if (typeof n.x !== 'number' || typeof n.y !== 'number') return null;
    x += n.x; y += n.y;
    if (!n.parent || n.parent.type === 'PAGE' || n.parent.type === 'DOCUMENT') break;
  }
  return { x: +x.toFixed(2), y: +y.toFixed(2),
           w: +node.width.toFixed(2), h: +node.height.toFixed(2) };
}

/**
 * Every link on ONE node — text hyperlinks and prototype URL actions — tagged
 * with where it sits and whether anything is drawn there.
 *
 * ⚠️ LINKS ARE SWEPT WHETHER OR NOT THE NODE RENDERS.
 * A blanket `if (node.visible === false) continue;` used to sit in the sweep,
 * which silently dropped every hyperlink a designer had parked on a hidden layer
 * or inside a hidden section. The link never reached the review table, so its
 * absence was invisible too. Detection itself is untouched — the same
 * textLinks() and urlActions() run on the same nodes; only the gate moved, and
 * only for links. A hidden link is TAGGED (`hidden: true`), never filtered.
 *
 * The rect, in order: render bounds → bounding box → geometry. The first two are
 * BOTH null once anything above the node is hidden, which is what left hidden
 * links with no hotspot; geometricRect() derives the position from layout
 * instead. A visible node never reaches the third step, so its anchoring is
 * exactly what it always was.
 */
function linksForNode(node, frame, ox, oy, onError) {
  var out = [];
  if (!node) return out;

  var hidden = node.visible === false || hiddenWithin(node, frame);
  var r = rectOf(node.absoluteRenderBounds || node.absoluteBoundingBox, ox, oy);
  if (!r) r = geometricRect(node, ox, oy, frame);

  var tl = textLinks(node, onError);
  for (var t = 0; t < tl.length; t++) {
    tl[t].nodeId = node.id;
    tl[t].nodeName = node.name;
    tl[t].rect = r;
    tl[t].internal = tl[t].linkType === 'URL' && isInternalUrl(tl[t].value);
    tl[t].hidden = hidden;
    out.push(tl[t]);
  }

  if ('reactions' in node) {
    var urls = urlActions(node);
    for (var u = 0; u < urls.length; u++) {
      out.push({
        kind: 'reaction', linkType: 'URL', value: urls[u],
        nodeId: node.id, nodeName: node.name, rect: r,
        partial: false, internal: isInternalUrl(urls[u]), hidden: hidden,
      });
    }
  }

  /* THIRD PATH — the URL lives in the LAYER NAME.
     Some files carry the link that way, where it appears in no text segment, no
     TextNode.hyperlink and no reaction, so every native path correctly finds
     nothing. Consulted LAST and only when this node produced no native link, so
     it can never duplicate, shadow or reorder one: a node that already has a
     real hyperlink keeps exactly the link it had, and its name is ignored.

     The slide frame itself is excluded. A frame named with a URL would become a
     hotspot covering the entire slide, swallowing every click and breaking
     click-to-advance — and a slide's name is a title ("01 · Cover"), not a
     layer annotation. */
  if (!out.length && node !== frame) {
    var rawName = null;
    try { rawName = node.name; }
    catch (e) { if (onError) onError(node, 'name unreadable — ' + errText(e)); }

    var named = urlFromName(rawName);
    if (named) {
      out.push({
        kind: 'name', linkType: 'URL', value: named,
        nodeId: node.id, nodeName: rawName,
        text: String(rawName || '').slice(0, 120),
        rect: r,
        start: 0, end: 0,
        partial: false,                       // the name names the whole node
        internal: isInternalUrl(named),       // unchanged internal/external rule
        hidden: hidden,
        via: 'name',                          // which path found it
      });
    }
  }
  return out;
}

/**
 * Is anything BETWEEN this node and its slide frame switched off?
 *
 * Ancestors only. The node's own `visible` is read directly at the call site,
 * because the two answer different questions: a hidden video is skipped on its
 * own visibility, while a link is kept either way and merely tagged.
 *
 * Bounded at the slide frame, and at PAGE/DOCUMENT for the frame itself — a
 * PageNode has no `visible`, so an unbounded walk would just burn parents.
 */
function hiddenWithin(node, root) {
  var n = node && node.parent;
  while (n && n !== root && n.type !== 'PAGE' && n.type !== 'DOCUMENT') {
    if (n.visible === false) return true;
    n = n.parent;
  }
  return false;
}

function everyNode(root) {
  var out = [];
  (function push(n) {
    out.push(n);
    if ('children' in n) for (var i = 0; i < n.children.length; i++) push(n.children[i]);
  })(root);
  return out;
}

/** The most common frame size in a pool — the deck's real slide size. */
function modalSize(frames) {
  var counts = {}, best = null, bestN = 0;
  for (var i = 0; i < frames.length; i++) {
    var b = frames[i].absoluteBoundingBox;
    if (!b) continue;
    var k = Math.round(b.width) + 'x' + Math.round(b.height);
    counts[k] = (counts[k] || 0) + 1;
    if (counts[k] > bestN) { best = k; bestN = counts[k]; }
  }
  return best;
}

/**
 * Reading order for frames laid out as a GRID: band by row, then left to right.
 *
 * Sorting x-primary looks reasonable and is badly wrong here — the Kotak section
 * is 8614x9788, roughly 5 columns by 12 rows, so x-primary yields column-major
 * order (1, 6, 11, 16, ...) and scrambles the whole deck.
 */
function readingOrder(frames) {
  var usable = frames.filter(function (f) { return f.absoluteBoundingBox; });
  var h = 0;
  for (var i = 0; i < usable.length; i++) {
    h = Math.max(h, usable[i].absoluteBoundingBox.height);
  }
  var band = Math.max(h * 0.5, 1);

  // Rows are CLUSTERED, not floor-divided into fixed bands. Fixed banding breaks
  // twice: Math.floor on a negative y lands in a different band than y=0, and two
  // frames either side of any band boundary get split however close they sit.
  var byY = usable.slice().sort(function (a, b) {
    return a.absoluteBoundingBox.y - b.absoluteBoundingBox.y;
  });

  var rows = [], cur = null;
  for (var j = 0; j < byY.length; j++) {
    var y = byY[j].absoluteBoundingBox.y;
    if (!cur || y - cur.y0 > band) { cur = { y0: y, items: [] }; rows.push(cur); }
    cur.items.push(byY[j]);
  }

  var out = [];
  for (var r = 0; r < rows.length; r++) {
    rows[r].items.sort(function (a, b) {
      return a.absoluteBoundingBox.x - b.absoluteBoundingBox.x;
    });
    out = out.concat(rows[r].items);
  }
  return out;
}

/**
 * Pick the deck's slides out of a pool, and say what was left out.
 *
 * Strays matter more than they look. The Kotak section carries a 196x116 frame
 * named "spacer" beside 41 real slides: keeping it adds a blank slide AND breaks
 * the numbering rule for every other slide, because that rule only fires when
 * EVERY frame is numbered. One stray would silently drop the whole deck onto the
 * positional fallback.
 */
function selectSlides(frames) {
  var usable = frames.filter(function (f) { return f.absoluteBoundingBox; });
  var modal = modalSize(usable);
  var skipped = [];
  var slides = usable.filter(function (f) {
    var b = f.absoluteBoundingBox;
    var k = Math.round(b.width) + 'x' + Math.round(b.height);
    if (k !== modal) {
      skipped.push({ name: f.name, size: k, why: 'not the deck size (' + modal + ')' });
      return false;
    }
    return true;
  });

  var allNumbered = slides.length > 0 && slides.every(function (f) {
    return slideNumber(f.name) !== null;
  });
  if (allNumbered) {
    slides = slides.slice().sort(function (a, b) {
      return slideNumber(a.name) - slideNumber(b.name);
    });
  } else {
    slides = readingOrder(slides);
  }
  return { slides: slides, skipped: skipped, modal: modal, ordered: allNumbered ? 'name' : 'position' };
}

/**
 * Every link anywhere under a node — count only, for reporting.
 * Goes through linksForNode so it counts exactly what an extraction would find,
 * including layer-name URLs, rather than drifting from it.
 */
function countLinks(root) {
  if (!root) return 0;
  var all = everyNode(root), n = 0;
  for (var i = 0; i < all.length; i++) n += linksForNode(all[i], root, 0, 0, null).length;
  return n;
}

/**
 * The slides to extract: an explicit selection, else the page's top-level frames.
 *
 * ⚠️ A HIDDEN TOP-LEVEL FRAME IS NOT A SLIDE — AND MUST NOT VANISH QUIETLY.
 * Hiding a slide removes it from the deck, which is correct: there would be no
 * slide for its links to sit on. But this used to drop it inside the same
 * .filter() as the type test, so the information was destroyed on the spot.
 *
 * That is not hypothetical. A designer hid the SLIDE holding a hyperlink rather
 * than a layer inside it; the frame was discarded here, the sweep never saw it,
 * and the link disappeared with no message — indistinguishable from a detection
 * bug, and it was chased as one through several rounds. The frames are collected
 * now and reported by name, with a count of the links going down with them.
 */
function findSlides() {
  var sel = figma.currentPage.selection;
  var pool = [];

  if (sel.length === 1 && sel[0].type === 'SECTION') pool = sel[0].children.slice();
  else if (sel.length) pool = sel.slice();
  else pool = figma.currentPage.children.slice();

  var part = partitionFrames(pool);
  var found = selectSlides(part.visible);
  found.hiddenFrames = part.hiddenFrames;
  return found;
}

/** Candidate slide frames, split into those that count and those switched off. */
function partitionFrames(pool) {
  var visible = [], hiddenFrames = [];
  for (var i = 0; i < (pool || []).length; i++) {
    var n = pool[i];
    if (!n || (n.type !== 'FRAME' && n.type !== 'COMPONENT')) continue;
    if (n.visible === false) hiddenFrames.push(n);
    else visible.push(n);
  }
  return { visible: visible, hiddenFrames: hiddenFrames };
}

/** Geometry, links and video slots for one slide. No bytes. */
function planSlide(frame, index) {
  var box = frame.absoluteBoundingBox;
  var ox = box ? box.x : 0, oy = box ? box.y : 0;
  var slideW = box ? box.width : 0, slideH = box ? box.height : 0;

  var layers = [];
  for (var i = 0; i < frame.children.length; i++) {
    var L = describeChild(frame.children[i], i, ox, oy, slideW, slideH);
    if (!L) continue;

    // Extract the grouping layer AND its children, so reveal grain becomes an
    // authoring decision rather than an extraction one. Claude can stagger a
    // copy block line by line on one slide and keep an artwork group whole on
    // the next, without re-running anything. One level only — deeper is not what
    // the grain analysis measured, and nests past usefulness.
    /* A MASKED GROUP IS NEVER SPLIT. Parts are exported one node at a time, and
       Figma applies a mask at the group level — so splitting one exports the
       mask shape as a blob and its content unmasked. The group stays whole and
       simply offers no fine grain, which costs a reveal option and keeps the
       picture correct. */
    if (L.kids > 1 && !L.hasMask) {
      var parts = [];
      var kids = frame.children[i].children;
      for (var k = 0; k < kids.length; k++) {
        var P = describeChild(kids[k], k, ox, oy, slideW, slideH);
        if (P) parts.push(P);
      }
      if (parts.length > 1) L.parts = revealOrder(parts, slideW, slideH);
    }
    layers.push(L);
  }

  var ordered = revealOrder(layers, slideW, slideH);

  // Links and videos are swept over the WHOLE subtree, not just direct children —
  // a hyperlink lives on a text node nested several levels down.
  var links = [], videos = [];
  var cen = newCensus();

  /* A probe that separates "never reached the node" from "reached it and found
     nothing". Without it, a missing link looks identical either way, which is
     what made this take several passes to locate. */
  var probe = { nodes: 0, hiddenNodes: 0, text: 0, hiddenText: 0, viaSegments: 0,
                viaProperty: 0, viaName: 0, masks: 0, topMasks: [], errors: [] };
  function noteError(node, msg) {
    if (probe.errors.length < 12) {
      probe.errors.push((node && node.name ? '"' + node.name + '": ' : '') + msg);
    }
  }

  var all = everyNode(frame);
  for (var n = 0; n < all.length; n++) {
    var node = all[n];
    // Census EVERY node, hidden ones included — a hidden video still tells us
    // the video is there, which is the question being asked.
    census(node, cen);

    probe.nodes++;
    var nodeHidden = node.visible === false || hiddenWithin(node, frame);
    if (nodeHidden) probe.hiddenNodes++;
    if (node.type === 'TEXT') { probe.text++; if (nodeHidden) probe.hiddenText++; }

    /* A mask directly on the slide cannot be reproduced by per-layer export:
       Figma applies it at the level of the node that CONTAINS it, and here that
       is the slide frame itself — whose export is the flat render. Inside a
       group it is fine, because the group exports as one bitmap. Recorded so
       the designer is told rather than left with an unmasked layer. */
    if (node.isMask === true) {
      probe.masks++;
      if (node.parent === frame && probe.topMasks.length < 8) {
        probe.topMasks.push(node.name || node.id);
      }
    }

    var found = linksForNode(node, frame, ox, oy, noteError);
    for (var l = 0; l < found.length; l++) {
      if (found[l].via === 'name') probe.viaName++;
      else if (found[l].via === 'hyperlink') probe.viaProperty++;
      else if (found[l].kind === 'text') probe.viaSegments++;
      links.push(found[l]);
    }

    /* Videos keep the ORIGINAL gate — the node's own visibility, not the
       ancestor walk. Widening it here would change which clips the designer is
       asked to supply, which is not what this change is for. The census already
       records hidden media, which is the question that path answers. */
    if (node.visible === false) continue;

    var r = rectOf(node.absoluteRenderBounds || node.absoluteBoundingBox, ox, oy);
    var vf = videoFills(node);
    for (var v = 0; v < vf.length; v++) {
      /* TWO RECTS, because they are two different things and the difference IS
         the crop. `render` is what survives ancestor clipping — the window the
         viewer sees. `box` is the node's own full box — where the media
         actually lives. Figma returns both on every node, so the clip the
         reference deck hand-authored as `clip:{w,h}` is derivable here for any
         layout, at any nesting depth. */
      videos.push({
        nodeId: node.id, nodeName: node.name,
        rect: r,                                            // visible window
        box: rectOf(node.absoluteBoundingBox, ox, oy),      // the media's own box
        scaleMode: vf[v].scaleMode,
        transform: vf[v].videoTransform,
        scalingFactor: vf[v].scalingFactor,
        // The shape's rounding is part of the video's appearance, and a layer
        // bitmap cannot carry it for a live <video> the way it does for a still.
        radius: cornerRadii(node),
        // …and the shape is usually not the video node's own: a rounded parent
        // frame with clipsContent, or a mask sibling, is what actually cuts it.
        clips: clipChain(node, frame, ox, oy),
        // Where this video sits in the Figma stack, so anything drawn over it
        // in Figma stays over it on the web.
        z: topLevelIndex(node, frame),
        // The file itself cannot be read from Figma — the API is write-only for
        // video. The designer supplies it; this row is what they drop onto.
        needsFile: true,
      });
    }
  }

  var no = slideNumber(frame.name);
  return {
    no: no === null ? index + 1 : no,
    id: frame.id,
    name: frame.name,
    w: slideW, h: slideH,
    bg: solidFillHex(frame),
    layers: ordered,
    rawOrder: layers.map(function (l) { return l.id; }),
    links: links,
    videos: videos,
    census: cen,
    probe: probe,
  };
}

/* ------------------------------------------------------------ bootstrap --- */

function exportPng(node) {
  return node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: SCALE } });
}

async function run() {
  /* Hidden layers must stay traversable — this plugin deliberately reads links
     out of them. The default is false in Figma and FigJam but TRUE in Dev Mode,
     where it makes `children` skip invisible nodes inside instances entirely and
     throws on their properties. Setting it explicitly costs nothing and removes
     the editor mode as a variable. */
  try { figma.skipInvisibleInstanceChildren = false; } catch (e) {}

  var found = findSlides();
  var frames = found.slides;
  if (!frames.length) {
    figma.ui.postMessage({ type: 'fatal', error: 'No slide frames found. Select a section, some frames, or open the deck page.' });
    return;
  }

  // Never drop a frame silently — a missing slide is invisible in the output.
  for (var k = 0; k < found.skipped.length; k++) {
    figma.ui.postMessage({
      type: 'warn',
      text: 'skipped "' + found.skipped[k].name + '" (' + found.skipped[k].size + ') — ' + found.skipped[k].why,
    });
  }

  /* A hidden top-level frame is not part of the deck, but say so — and say what
     goes down with it. Losing a hyperlink because the SLIDE was hidden, rather
     than a layer inside it, is indistinguishable from a detection bug unless
     this is stated outright. */
  var hiddenFrames = found.hiddenFrames || [];
  for (var hf = 0; hf < hiddenFrames.length; hf++) {
    var frameNode = hiddenFrames[hf];
    var nLinks = countLinks(frameNode);
    figma.ui.postMessage({
      type: 'warn',
      text: 'hidden frame "' + frameNode.name + '" was not extracted — it is switched off in ' +
            'Figma, so it is not part of the deck' +
            (nLinks
              ? '. ⚠️ It contains ' + nLinks + ' hyperlink' + (nLinks === 1 ? '' : 's') +
                ' that will NOT appear: unhide the frame, or move the link onto a visible slide. ' +
                '(Hiding a LAYER inside a visible slide does keep its link — hiding the slide ' +
                'itself removes the slide.)'
              : '.'),
    });
  }

  var slides = frames.map(planSlide);

  /* Report anything that could make a link go missing. All three of these were
     silent at some point, and each silence cost a debugging round. */
  var seen = { nodes: 0, hiddenNodes: 0, text: 0, hiddenText: 0,
               viaSegments: 0, viaProperty: 0, viaName: 0, masks: 0 };
  for (var s = 0; s < slides.length; s++) {
    var p = slides[s].probe;
    if (p) {
      seen.nodes += p.nodes; seen.hiddenNodes += p.hiddenNodes;
      seen.text += p.text; seen.hiddenText += p.hiddenText;
      seen.viaSegments += p.viaSegments; seen.viaProperty += p.viaProperty;
      seen.viaName += p.viaName; seen.masks += p.masks || 0;
      for (var e = 0; e < p.errors.length; e++) {
        figma.ui.postMessage({
          type: 'warn',
          text: 'slide ' + slides[s].no + ': ' + p.errors[e],
        });
      }
    }
    /* A mask sitting directly on the slide masks its SIBLING layers, and those
       export one at a time — so the mask cannot be applied and its content will
       render unmasked. Grouping the mask with what it masks fixes it, because a
       group exports as a single bitmap with the mask baked in. */
    var tm = (slides[s].probe && slides[s].probe.topMasks) || [];
    for (var m = 0; m < tm.length; m++) {
      figma.ui.postMessage({
        type: 'warn',
        text: 'slide ' + slides[s].no + ': "' + tm[m] + '" is a mask directly on the slide — ' +
              'layers export one at a time, so it cannot be applied and the layers it masks will ' +
              'render UNMASKED. Group the mask together with what it masks and it will be exact.',
      });
    }

    /* Per-video shape report. "The corners are still square" is not actionable
       on its own — it cannot distinguish "Figma has no radius there" from
       "extraction missed it" from "the viewer dropped it". This says which. */
    var vs = slides[s].videos || [];
    for (var vi = 0; vi < vs.length; vi++) {
      var vd = vs[vi];
      var shape = vd.radius ? 'radius ' + vd.radius.join(',') : 'radius none';
      var ch = vd.clips || [];
      if (ch.length) {
        var bits = [];
        for (var ci = 0; ci < ch.length; ci++) {
          bits.push('"' + (ch[ci].name || '?') + '"' +
            (ch[ci].radius ? ' r=' + ch[ci].radius.join(',') : '') +
            (ch[ci].mask ? (ch[ci].mask.path ? ' mask=vector' : ' mask=rect') : ''));
        }
        shape += ' · clipped by ' + bits.join(' > ');
      } else {
        shape += ' · no clipping ancestor';
      }
      figma.ui.postMessage({
        type: 'warn',
        text: 'slide ' + slides[s].no + ': video "' + vd.nodeName + '" ' +
              (vd.rect ? vd.rect.w + '×' + vd.rect.h : '?') + ' ' +
              (vd.scaleMode || 'FILL') + ' · ' + shape,
      });
    }

    // A link with no rect cannot become a hotspot — the renderer drops it.
    var ls = slides[s].links;
    for (var li = 0; li < ls.length; li++) {
      if (ls[li].rect) continue;
      figma.ui.postMessage({
        type: 'warn',
        text: 'slide ' + slides[s].no + ': no geometry for the link on "' +
              ls[li].nodeName + '" — it cannot be placed and will not be clickable',
      });
    }
  }
  figma.ui.postMessage({
    type: 'probe',
    text: 'slide pool : ' + frames.length + ' extracted · ' + hiddenFrames.length +
          ' hidden top-level frame(s) NOT extracted\n' +
          'link sweep : ' + seen.nodes + ' nodes visited (' + seen.hiddenNodes +
          ' hidden, ' + seen.masks + ' masks — all descended into) · ' +
          seen.text + ' text nodes (' + seen.hiddenText +
          ' hidden) · links found: ' + seen.viaSegments + ' via segments, ' +
          seen.viaProperty + ' via the hyperlink property, ' +
          seen.viaName + ' via the layer name',
  });

  figma.ui.postMessage({
    type: 'plan',
    meta: {
      file: figma.root.name,
      page: figma.currentPage.name,
      scale: SCALE,
      slideCount: slides.length,
      slideSize: found.modal,
      orderedBy: found.ordered,
      skipped: found.skipped,
    },
    slides: slides,
  });

  // Sniff every distinct image fill for animation BEFORE exporting anything.
  // Deduped by hash — the same art reused across slides is one fetch. Bytes are
  // discarded immediately; only the verdict is kept.
  var hashes = {};
  for (var s0 = 0; s0 < slides.length; s0++) {
    var mn = (slides[s0].census && slides[s0].census.mediaNodes) || [];
    for (var m0 = 0; m0 < mn.length; m0++) {
      if (mn[m0].fill === 'IMAGE' && mn[m0].hash && !hashes[mn[m0].hash]) {
        hashes[mn[m0].hash] = { node: mn[m0], slide: slides[s0].no };
      }
    }
  }
  var hkeys = Object.keys(hashes);
  for (var hi = 0; hi < hkeys.length; hi++) {
    figma.ui.postMessage({ type: 'status', text: 'checking image ' + (hi + 1) + '/' + hkeys.length + ' for animation' });
    try {
      var img = figma.getImageByHash(hkeys[hi]);
      if (img) {
        var ibytes = await img.getBytesAsync();
        var info = sniffImage(ibytes);
        figma.ui.postMessage({
          type: 'image', hash: hkeys[hi], format: info.format, animated: info.animated,
          size: ibytes.length, slide: hashes[hkeys[hi]].slide,
          name: hashes[hkeys[hi]].node.name, nodeId: hashes[hkeys[hi]].node.id,
        });
        ibytes = null;
      }
    } catch (e) {
      figma.ui.postMessage({ type: 'warn', text: 'image ' + hkeys[hi].slice(0, 8) + ': ' + (e && e.message || e) });
    }
    await new Promise(function (r) { setTimeout(r, 0); });
  }

  // Sequential, never Promise.all: each Uint8Array is held in plugin memory and
  // Figma lives inside the tab's ~2GB budget. Hand each buffer to the UI and drop
  // the reference before starting the next.
  var totalAssets = slides.reduce(function (a, s) {
    return a + s.layers.reduce(function (b, L) {
      return b + 1 + (L.parts ? L.parts.length : 0);
    }, 1);                                   // +1 for the slide's flat render
  }, 0);
  var done = 0;

  async function exportOne(id, label, slideNo, kind) {
    var node = await figma.getNodeByIdAsync(id);
    if (!node) {
      figma.ui.postMessage({ type: 'warn', text: 'slide ' + slideNo + ': node ' + id + ' vanished' });
      return;
    }
    try {
      var bytes = await exportPng(node);
      figma.ui.postMessage({
        type: 'asset', kind: kind, slide: slideNo, layerId: id,
        bytes: bytes, done: ++done, total: totalAssets,
      });
    } catch (e) {
      figma.ui.postMessage({
        type: 'warn',
        text: 'slide ' + slideNo + '/' + label + ': export failed — ' + (e && e.message || e),
      });
    }
    await new Promise(function (r) { setTimeout(r, 0); });
  }

  for (var i = 0; i < slides.length; i++) {
    var s = slides[i];
    var frame = frames[i];

    try {
      var flat = await exportPng(frame);
      figma.ui.postMessage({ type: 'asset', kind: 'flat', slide: s.no, bytes: flat, done: ++done, total: totalAssets });
    } catch (e) {
      figma.ui.postMessage({ type: 'warn', text: 'slide ' + s.no + ': flat export failed — ' + (e && e.message || e) });
    }
    await new Promise(function (r) { setTimeout(r, 0); });

    for (var j = 0; j < s.layers.length; j++) {
      var L = s.layers[j];
      await exportOne(L.id, L.name, s.no, 'layer');
      // Its children too — the deck can then be authored at either grain.
      for (var q = 0; q < (L.parts || []).length; q++) {
        await exportOne(L.parts[q].id, L.parts[q].name, s.no, 'part');
      }
    }
  }

  figma.ui.postMessage({ type: 'done' });
}

// clientStorage key for the bridge folder path — see the 'rememberBridgeHome'
// and 'getBridgeHome' messages below.
var BRIDGE_HOME_KEY = 'presentation-export.bridgeHome';

if (typeof figma !== 'undefined') {
  figma.showUI(__html__, { width: 620, height: 700, themeColors: true });
  figma.ui.onmessage = function (msg) {
    if (msg && msg.type === 'extract') {
      run().catch(function (e) {
        figma.ui.postMessage({ type: 'fatal', error: String(e && e.stack || e) });
      });
      return;
    }

    // Where the bridge lives, remembered so the plugin can still point at it
    // (with a ready-to-copy path and terminal command) once the bridge goes
    // offline — the only time anyone actually needs to be told where it is.
    // clientStorage rather than the document: this is a fact about the
    // designer's machine, not about the deck, so it must not follow the file
    // to whoever opens it next.
    if (msg && msg.type === 'rememberBridgeHome') {
      figma.clientStorage.setAsync(BRIDGE_HOME_KEY, msg.path).catch(function () {});
      return;
    }

    if (msg && msg.type === 'getBridgeHome') {
      figma.clientStorage.getAsync(BRIDGE_HOME_KEY).then(function (stored) {
        figma.ui.postMessage({ type: 'bridgeHome', path: typeof stored === 'string' ? stored : null });
      }).catch(function () {
        figma.ui.postMessage({ type: 'bridgeHome', path: null });
      });
      return;
    }
  };
}

/* Node test harness picks up the pure half; Figma's sandbox has no `module`. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    slug: slug, rgbHex: rgbHex, solidFillHex: solidFillHex,
    isFullBleed: isFullBleed, revealOrder: revealOrder, pickAnchor: pickAnchor,
    slideNumber: slideNumber, isInternalUrl: isInternalUrl,
    urlActions: urlActions, textLinks: textLinks,
    hiddenWithin: hiddenWithin, linksForNode: linksForNode,
    geometricRect: geometricRect, urlFromName: urlFromName,
    cornerRadii: cornerRadii, hasMaskChild: hasMaskChild,
    videoFills: videoFills, rectOf: rectOf,
    census: census, newCensus: newCensus, sniffImage: sniffImage,
    describeChild: describeChild,
    modalSize: modalSize, readingOrder: readingOrder, selectSlides: selectSlides,
    partitionFrames: partitionFrames, countLinks: countLinks,
    // Exported so the FULL sweep can be exercised offline, not just its leaves:
    // planSlide touches no figma.* API, so a mock frame drives the real path.
    everyNode: everyNode, planSlide: planSlide,
    SCALE: SCALE, ANCHOR_TOL: ANCHOR_TOL, READING_BAND: READING_BAND,
    FULL_BLEED_RATIO: FULL_BLEED_RATIO,
  };
}
