/**
 * Video Byte Probe — can a plugin get the ORIGINAL bytes of a video fill?
 *
 * The earlier answer ("no") came from reading developers.figma.com. Docs lag the
 * runtime, so this asks the runtime instead: it enumerates the real `figma`
 * global and the real VideoPaint object — own properties AND the prototype
 * chain, which is where undocumented methods hide — then attempts every
 * plausible retrieval path against the actual video in this deck.
 *
 * It also separates two things that were previously conflated: the MCP's
 * `export_video` (which froze a video fill at its poster) and the PLUGIN's
 * `exportAsync({format:'MP4'})`. Different surfaces; the second was never tested.
 *
 * Read-only. Run it on the page holding the video.
 */

figma.showUI(__html__, { width: 620, height: 720, themeColors: true });

/** Own + inherited property names, so undocumented methods are not missed. */
function allKeys(o) {
  const out = [];
  let cur = o;
  while (cur && cur !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(cur)) if (out.indexOf(k) === -1) out.push(k);
    cur = Object.getPrototypeOf(cur);
  }
  return out.sort();
}

function typeOfKey(o, k) {
  try { return typeof o[k]; } catch (e) { return 'threw:' + (e && e.message); }
}

function everyNode(root) {
  const out = [];
  (function push(n) { out.push(n); if ('children' in n) n.children.forEach(push); })(root);
  return out;
}

function findVideoFills() {
  const hits = [];
  for (const page of [figma.currentPage]) {
    for (const node of everyNode(page)) {
      const fills = node.fills;
      if (!Array.isArray(fills)) continue;
      fills.forEach((f, i) => {
        if (f.type === 'VIDEO') hits.push({ node, paint: f, index: i });
      });
    }
  }
  return hits;
}

async function probe() {
  const log = [];
  const say = (k, v) => log.push({ k, v });

  say('apiVersion', figma.apiVersion || '(none reported)');
  say('editorType', figma.editorType);
  say('fileKey', figma.fileKey ? '(present)' : '(not exposed)');

  /* ---- 1. What does the figma global actually expose? ------------------ */
  const figmaKeys = allKeys(figma);
  const mediaKeys = figmaKeys.filter(k => /video|media|image|gif|asset|byte/i.test(k));
  say('figma.* keys matching video/media/image/gif/asset/byte',
      mediaKeys.map(k => k + ' [' + typeOfKey(figma, k) + ']').join('\n') || '(none)');

  // The specific names the docs do and do not claim exist.
  ['getVideoByIdAsync', 'getVideoByHash', 'getVideoById', 'createVideoAsync',
   'getImageByHash', 'createImage', 'createImageAsync', 'createGif']
    .forEach(n => say('figma.' + n, typeOfKey(figma, n)));

  /* ---- 2. The actual video node in this file --------------------------- */
  const hits = findVideoFills();
  say('video fills found on this page', String(hits.length));
  if (!hits.length) {
    say('RESULT', 'No VIDEO fill on this page — open the page holding the video and re-run.');
    figma.ui.postMessage({ type: 'report', log, videos: [] });
    return;
  }

  const videos = [];
  for (const hit of hits) {
    const { node, paint } = hit;
    const v = {
      nodeName: node.name, nodeType: node.type, nodeId: node.id,
      w: node.width, h: node.height,
      paintKeys: allKeys(paint).map(k => k + ' [' + typeOfKey(paint, k) + ']'),
      videoHash: paint.videoHash || null,
      attempts: [],
    };

    const attempt = async (label, fn) => {
      try {
        const r = await fn();
        v.attempts.push({ label, ok: true, detail: r });
      } catch (e) {
        v.attempts.push({ label, ok: false, detail: String(e && e.message || e) });
      }
    };

    /* ---- 3. Every plausible byte-retrieval path ----------------------- */

    await attempt('figma.getVideoByIdAsync(videoHash)', async () => {
      if (typeof figma.getVideoByIdAsync !== 'function') return 'method does not exist';
      const vid = await figma.getVideoByIdAsync(paint.videoHash);
      if (!vid) return 'returned null';
      const keys = allKeys(vid).map(k => k + ' [' + typeOfKey(vid, k) + ']');
      if (typeof vid.getBytesAsync === 'function') {
        const b = await vid.getBytesAsync();
        return 'BYTES: ' + b.length + ' — keys: ' + keys.join(', ');
      }
      return 'object with keys: ' + keys.join(', ') + ' — no getBytesAsync';
    });

    await attempt('figma.getVideoByHash(videoHash)', async () => {
      if (typeof figma.getVideoByHash !== 'function') return 'method does not exist';
      const vid = figma.getVideoByHash(paint.videoHash);
      return vid ? 'object with keys: ' + allKeys(vid).join(', ') : 'returned null';
    });

    // Long shot, but cheap: does the image path accept a video hash?
    await attempt('figma.getImageByHash(videoHash).getBytesAsync()', async () => {
      if (typeof figma.getImageByHash !== 'function') return 'getImageByHash does not exist';
      const img = figma.getImageByHash(paint.videoHash);
      if (!img) return 'returned null — video hashes are not image hashes';
      const b = await img.getBytesAsync();
      return 'BYTES: ' + b.length;
    });

    /* ---- 4. exportAsync video formats — never tested from a PLUGIN ----
       Video export wants a FRAME. Walking up to "parent is PAGE" overshot on the
       first run: these slides live inside a SECTION, so it tested the section
       (and a RECTANGLE), both of which fail whatever the video does. Collect
       every distinct frame ancestor instead, and print each target's TYPE so a
       mis-aimed test is visible in the report rather than silent. */
    const targets = [{ label: 'the video node itself', node: node }];
    (function collect(n) {
      let cur = n.parent;
      while (cur && cur.type !== 'PAGE') {
        if (cur.type === 'FRAME' || cur.type === 'COMPONENT') {
          targets.push({ label: 'ancestor frame "' + cur.name + '"', node: cur });
        }
        cur = cur.parent;
      }
    })(node);
    // The slide frame is the outermost frame ancestor — the likeliest legal target.
    const slideFrame = targets.length > 1 ? targets[targets.length - 1] : null;
    say('video export targets', targets.map(t => t.node.type + ' "' + t.node.name + '"').join('\n'));
    if (slideFrame) say('outermost frame ancestor (the slide)', slideFrame.node.type + ' "' + slideFrame.node.name + '"');

    for (const fmt of ['MP4', 'WEBM', 'GIF']) {
      for (const t of targets) {
        await attempt('exportAsync({format:"' + fmt + '"}) on ' + t.node.type + ' — ' + t.label, async () => {
          const b = await t.node.exportAsync({ format: fmt });
          figma.ui.postMessage({
            type: 'media', label: fmt + ' from ' + t.node.type + ' ' + t.node.name,
            fmt, bytes: b, from: t.node.name,
          });
          return 'BYTES: ' + b.length;
        });
      }
    }

    // Baseline: a PNG export of the same node, for size comparison.
    await attempt('node.exportAsync PNG @2x (baseline)', async () => {
      const b = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
      return 'BYTES: ' + b.length;
    });

    videos.push(v);
  }

  figma.ui.postMessage({ type: 'report', log, videos });
}

figma.ui.onmessage = (m) => {
  if (m && m.type === 'run') {
    probe().catch(e => figma.ui.postMessage({ type: 'fatal', error: String(e && e.stack || e) }));
  }
};
