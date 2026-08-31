/**
 * Phase 0 spike — three questions that decide the plugin's architecture.
 *
 * A  Does exportAsync return TEXT layers with a REAL alpha channel?
 *    The MCP/REST route does not: it bakes the slide background in behind the
 *    glyphs, so a text layer laid over artwork masks whatever is beneath it.
 *    build-layers.py spends ~50 lines reconstructing the matte from
 *    E = a*C + (1-a)*B to undo that. If exportAsync is clean, the whole
 *    matte-recovery stage disappears and slide 35 may become recoverable.
 *
 * B  Do inherited prototype reactions surface on an INSTANCE's SUBLAYERS,
 *    or only on the instance root? Undocumented. Decides the link sweep.
 *
 * C  How much can we export at 2x before the tab's memory ceiling bites?
 *    exportAsync returns a Uint8Array held in plugin memory and Figma lives
 *    inside the browser's ~2GB per-tab budget.
 *
 * Read-only. Exports nothing to disk, writes nothing to the document.
 */

const SCALE = 2;
const MAX_TEXT_SAMPLES = 12;
const MAX_SHAPE_SAMPLES = 10;

figma.showUI(__html__, { width: 560, height: 640, themeColors: true });

/* ---------------------------------------------------------------- helpers */

/** Parse a PNG IHDR. Colour type 6/4 carry an alpha channel, 2/0/3 do not. */
function pngInfo(bytes) {
  if (bytes.length < 26) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const u32 = (o) =>
    (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0;
  return {
    width: u32(16),
    height: u32(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    hasAlphaChannel: bytes[25] === 6 || bytes[25] === 4,
  };
}

function rgbHex(c) {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

/** The solid background colour of the slide a node sits on, if there is one. */
function slideBg(node) {
  let n = node;
  while (n && n.parent) {
    const fills = n.fills;
    if (Array.isArray(fills)) {
      const solid = fills.filter((f) => f.visible !== false && f.type === 'SOLID');
      if (solid.length) return rgbHex(solid[solid.length - 1].color);
    }
    n = n.parent;
    if (n.type === 'PAGE') break;
  }
  return null;
}

/** Every distinct solid fill colour on a text node, across styled segments. */
function textColours(node) {
  const out = [];
  try {
    for (const seg of node.getStyledTextSegments(['fills'])) {
      for (const f of seg.fills || []) {
        if (f.visible !== false && f.type === 'SOLID') {
          const hex = rgbHex(f.color);
          if (out.indexOf(hex) === -1) out.push(hex);
        }
      }
    }
  } catch (e) { /* mixed or unreadable — not fatal for the spike */ }
  return out;
}

/** Flatten Reaction.actions (with the deprecated .action fallback), including
 *  URL actions nested inside CONDITIONAL blocks. */
function urlActions(node) {
  const found = [];
  const reactions = node.reactions;
  if (!reactions || !reactions.length) return found;

  const walk = (actions) => {
    for (const a of actions || []) {
      if (!a) continue;
      if (a.type === 'URL' && a.url) found.push(a.url);
      if (a.type === 'CONDITIONAL') {
        for (const block of a.conditionalBlocks || []) walk(block.actions);
      }
    }
  };
  for (const r of reactions) walk(r.actions || (r.action ? [r.action] : []));
  return found;
}

/* ------------------------------------------------------------------ scope */

function scope() {
  const sel = figma.currentPage.selection;
  if (sel.length) return { nodes: sel.slice(), label: sel.length + ' selected node(s)' };
  const frames = figma.currentPage.children.filter(
    (n) => n.type === 'FRAME' || n.type === 'SECTION' || n.type === 'COMPONENT'
  );
  return { nodes: frames, label: 'page "' + figma.currentPage.name + '" (' + frames.length + ' top-level)' };
}

function descendants(roots) {
  const out = [];
  const push = (n) => {
    out.push(n);
    if ('children' in n) for (const c of n.children) push(c);
  };
  for (const r of roots) push(r);
  return out;
}

/* ----------------------------------------------------- A: alpha + anchor rect */

async function sampleNode(node) {
  let bytes;
  try {
    bytes = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: SCALE },
    });
  } catch (e) {
    return { name: node.name, type: node.type, error: String(e && e.message || e) };
  }
  const info = pngInfo(bytes);
  const box = node.absoluteBoundingBox;
  const render = node.absoluteRenderBounds;

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    png: info,
    bytes: bytes.length,
    bg: slideBg(node.parent),
    colours: node.type === 'TEXT' ? textColours(node) : [],
    // Trap 2 evidence: which rect actually matches the exported pixels.
    box: box ? { w: +box.width.toFixed(2), h: +box.height.toFixed(2) } : null,
    render: render ? { w: +render.width.toFixed(2), h: +render.height.toFixed(2) } : null,
    exportCss: info ? { w: info.width / SCALE, h: info.height / SCALE } : null,
    clipped: clipGap(node),
    // The UI decodes this on a canvas to read real alpha values.
    data: Array.from(bytes),
  };
}

/** How far absoluteRenderBounds sits from absoluteBoundingBox. Large means the
 *  node is clipped by its parent or cropped to its ink — the interesting case. */
function clipGap(n) {
  const b = n.absoluteBoundingBox, r = n.absoluteRenderBounds;
  if (!b || !r) return 0;
  return +Math.max(Math.abs(b.width - r.width), Math.abs(b.height - r.height)).toFixed(2);
}

async function testAlpha(all) {
  const visible = all.filter((n) => n.visible !== false);
  const texts = visible.filter((n) => n.type === 'TEXT');

  // Non-text nodes carry the OTHER half of trap 2: a shape hanging outside its
  // frame is clipped in absoluteRenderBounds while the export may hold the whole
  // shape — which is where `box` won in the Kotak build. Sample the most-clipped
  // first so those cases actually appear in a capped sample.
  const shapes = visible
    .filter((n) =>
      n.type !== 'TEXT' &&
      'absoluteBoundingBox' in n && n.absoluteBoundingBox &&
      n.parent && n.parent.type !== 'PAGE' &&      // skip the slide roots themselves
      n.type !== 'SECTION')
    .sort((a, b) => clipGap(b) - clipGap(a));

  const samples = [];
  for (const node of texts.slice(0, MAX_TEXT_SAMPLES)) {
    samples.push(await sampleNode(node));
    await new Promise((r) => setTimeout(r, 0));
  }
  const shapeSamples = [];
  for (const node of shapes.slice(0, MAX_SHAPE_SAMPLES)) {
    shapeSamples.push(await sampleNode(node));
    await new Promise((r) => setTimeout(r, 0));
  }

  return {
    total: texts.length, sampled: samples.length, samples,
    shapeTotal: shapes.length, shapeSamples,
  };
}

/* ------------------------------------------------------- B: reactions/links */

function testReactions(all) {
  const withReactions = [];
  const instances = [];
  const hyperlinks = [];

  for (const n of all) {
    if ('reactions' in n) {
      const urls = urlActions(n);
      if (urls.length) {
        withReactions.push({
          id: n.id, name: n.name, type: n.type, urls,
          insideInstance: !!findInstanceAncestor(n),
          isInstanceRoot: n.type === 'INSTANCE',
        });
      }
    }
    if (n.type === 'INSTANCE') instances.push(n);
    if (n.type === 'TEXT') {
      try {
        for (const seg of n.getStyledTextSegments(['hyperlink'])) {
          if (seg.hyperlink) {
            hyperlinks.push({
              id: n.id, name: n.name,
              text: seg.characters.slice(0, 60),
              start: seg.start, end: seg.end,
              linkType: seg.hyperlink.type,
              value: seg.hyperlink.value,
            });
          }
        }
      } catch (e) { /* ignore */ }
    }
  }

  // The undocumented question: do sublayers of an instance report reactions
  // of their own? Compare each instance root against its descendants.
  const instanceProbe = instances.slice(0, 20).map((inst) => {
    const kids = descendants([inst]).filter((k) => k !== inst && 'reactions' in k);
    return {
      name: inst.name,
      rootUrls: urlActions(inst).length,
      sublayers: kids.length,
      sublayersWithReactions: kids.filter((k) => k.reactions && k.reactions.length).length,
      sublayersWithUrls: kids.filter((k) => urlActions(k).length).length,
    };
  });

  return { withReactions, hyperlinks, instanceProbe, instanceCount: instances.length };
}

function findInstanceAncestor(n) {
  let p = n.parent;
  while (p) {
    if (p.type === 'INSTANCE') return p;
    p = p.parent;
  }
  return null;
}

/* ----------------------------------------------------------- C: memory/time */

async function testMemory(roots) {
  const frames = roots.filter((n) => n.type === 'FRAME' || n.type === 'COMPONENT');
  const rows = [];
  let totalBytes = 0;
  let failedAt = null;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const t0 = Date.now();
    try {
      const bytes = await f.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: SCALE },
      });
      totalBytes += bytes.length;
      rows.push({ i: i + 1, name: f.name, bytes: bytes.length, ms: Date.now() - t0 });
      // Drop the reference immediately and yield — never retain 41 buffers.
      figma.ui.postMessage({ type: 'progress', done: i + 1, of: frames.length });
    } catch (e) {
      failedAt = { i: i + 1, name: f.name, error: String(e && e.message || e) };
      break;
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  return { count: frames.length, exported: rows.length, totalBytes, rows, failedAt };
}

/* -------------------------------------------------------------------- run */

figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'run') return;
  const sc = scope();
  const all = descendants(sc.nodes);

  figma.ui.postMessage({ type: 'status', text: 'Scope: ' + sc.label + ' — ' + all.length + ' nodes' });

  try {
    figma.ui.postMessage({ type: 'status', text: 'A — exporting text and shape layers…' });
    const a = await testAlpha(all);

    figma.ui.postMessage({ type: 'status', text: 'B — sweeping reactions and hyperlinks…' });
    const b = testReactions(all);

    let c = null;
    if (msg.memory) {
      figma.ui.postMessage({ type: 'status', text: 'C — exporting every frame at 2x…' });
      c = await testMemory(sc.nodes);
    }

    figma.ui.postMessage({
      type: 'result',
      scope: sc.label,
      nodeCount: all.length,
      file: figma.root.name,
      page: figma.currentPage.name,
      a, b, c,
    });
  } catch (e) {
    figma.ui.postMessage({ type: 'fatal', error: String(e && e.stack || e) });
  }
};
