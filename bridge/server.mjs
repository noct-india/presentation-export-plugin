/**
 * Publish bridge for the Presentation Export plugin.
 *
 * A Figma plugin is sandboxed: no filesystem, no shell. It cannot write a dist/
 * and it cannot run surge. So this sits beside it and does both.
 *
 *   Figma plugin  ──fetch POST /publish──▶  bridge  ──▶  dist/  ──▶  surge
 *
 * TWO LOOPBACK TRAPS, both already paid for by the DS Documentation bridge:
 *
 *  1. It listens on BOTH 127.0.0.1 and [::1]. `localhost` resolves to IPv6 on
 *     macOS and IPv4 elsewhere, and there is no saying which Figma's iframe will
 *     pick. Binding one family leaves a failure that looks exactly like "the
 *     bridge isn't running".
 *  2. The plugin manifest must name the HOSTNAME, not an IP — Figma's validator
 *     rejects http://127.0.0.1:3001 with "must be a valid URL" and accepts
 *     http://localhost:3001.
 *
 * Nothing leaves the machine except the deploy itself, and the Surge token is
 * never logged or returned.
 */

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from './render.mjs';
import { deploy } from './deploy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The plugin folder, one level up from this file — where "Start Bridge.command"
// and "Start Bridge.cmd" actually live, and what the UI reports to a designer
// when the bridge is down and it needs to say where to double-click.
const PLUGIN_ROOT = path.dirname(HERE);
const PORT = Number(process.env.PRESENTATION_BRIDGE_PORT || 3001);
const HOSTS = ['127.0.0.1', '::1'];
const MAX_BODY = 512 * 1024 * 1024;        // 41 slides of 2x PNGs, base64-inflated

const BUILD = '2026-08-26a';

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

/**
 * Container → MIME, per supplied file.
 *
 * ⚠️ This used to be `webm ? video/webm : video/mp4`, so a .mov was handed to
 * the page declared as video/mp4. A <source> type is a HINT the browser uses to
 * decide whether to attempt the resource at all, so a wrong one can make it skip
 * a file it could actually have played. Every slot is judged on its own file, so
 * one slide can mix .mov, .webm and .mp4 freely.
 *
 * Unknown containers are REFUSED rather than silently renamed .mp4 — a .mkv
 * relabelled as mp4 produces a deck that loads and plays nothing.
 */
export const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.qt': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
};

export function videoTypeOf(name) {
  const m = /(\.[a-z0-9]+)$/i.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  const type = VIDEO_TYPES[ext];
  if (!type) {
    throw new Error(
      'unsupported video container ' + (ext ? '"' + ext + '"' : '(no extension)') +
      ' for "' + name + '" — supported: ' + Object.keys(VIDEO_TYPES).join(', '));
  }
  return { ext, type };
}

/**
 * What a file ACTUALLY is, from its first bytes rather than its name.
 *
 * An extension is a claim, not a fact: plenty of files named .mov carry an
 * MP4-family brand and are ordinary MP4s. Reading the container settles it, and
 * costs twelve bytes.
 */
export function sniffVideo(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (a, b) => buf.slice(a, b).toString('latin1');

  // ISO base media family: a `ftyp` box, with the brand right after it.
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    // `qt  ` is QuickTime proper; every other brand in the family is MP4-ish.
    if (/^qt/i.test(brand)) return { container: 'quicktime', brand };
    return { container: 'mp4', brand };
  }
  // Matroska / WebM share the EBML header.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { container: 'webm', brand: 'ebml' };
  }
  if (ascii(0, 4) === 'OggS') return { container: 'ogg', brand: 'oggs' };
  return null;
}

/**
 * ⚠️ QUICKTIME IS LISTED AS video/mp4 FIRST, DELIBERATELY.
 *
 * A browser checks a <source>'s `type` with canPlayType BEFORE fetching it, and
 * Chrome answers "" for video/quicktime — so a source typed that way is skipped
 * without ever being tried, even though Chrome's demuxer handles H.264 in a .mov
 * perfectly well. Labelling .mov "correctly" as video/quicktime is what stopped
 * it playing; leading with video/mp4 gives Chrome a source it will attempt, and
 * video/quicktime stays as a second hint for anything that prefers it.
 *
 * The bytes are never altered and the extension stays truthful. Firefox does not
 * support the container at all, which no hint can fix — the review UI says so.
 */
export const CONTAINERS = {
  mp4:       { ext: '.mp4',  types: ['video/mp4'] },
  webm:      { ext: '.webm', types: ['video/webm'] },
  ogg:       { ext: '.ogv',  types: ['video/ogg'] },
  quicktime: { ext: '.mov',  types: ['video/mp4', 'video/quicktime'] },
};

/** Resolve one dropped file to the extension and ordered type hints to publish. */
export function videoSpecFor(name, buf) {
  const sniffed = sniffVideo(buf);
  if (sniffed && CONTAINERS[sniffed.container]) {
    // Content wins: a file named .mov that is really an MP4 is published as one.
    return { ...CONTAINERS[sniffed.container], container: sniffed.container, brand: sniffed.brand };
  }
  // Unrecognised bytes — fall back to the name, which still refuses junk.
  const { ext, type } = videoTypeOf(name);
  return { ext, types: [type], container: null, brand: null };
}

/** Where a project's uploaded bitmaps wait between staging and rendering. */
function stageDir(project) {
  const p = String(project || '');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(p)) throw new Error('bad project name: ' + JSON.stringify(project));
  return path.join(os.tmpdir(), 'presentation-export', p, 'staged');
}

/* The plugin iframe has a null/`figma.com` origin, so CORS must be permissive —
   safe because the server binds to loopback only and is unreachable off-machine. */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
}

function send(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('body is not valid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

async function handlePublish(body) {
  if (!body || !Array.isArray(body.slides) || !body.slides.length) {
    throw new Error('payload has no slides');
  }
  if (!body.project) throw new Error('no project name');

  const work = path.join(os.tmpdir(), 'presentation-export', String(body.project));
  const dist = path.join(work, 'dist');
  const staged = stageDir(body.project);

  // Videos arrive as bytes; write them and hand the renderer their paths.
  const assets = { ...(body.assets || {}) };
  const videoFiles = {};
  for (const v of body.videos || []) {
    if (!v.file || !v.file.bytes) continue;
    const bytes = Buffer.from(v.file.bytes);
    const spec = videoSpecFor(v.file.name, bytes);
    const rel = 'video/' + v.nodeId.replace(/[^a-z0-9]+/gi, '-') + spec.ext;
    assets[rel] = bytes.toString('base64');
    videoFiles[v.nodeId] = { src: rel, type: spec.types[0], types: spec.types };
    log('video', v.file.name, '→', rel,
        '(' + (spec.container || 'by extension') + (spec.brand ? ' ' + spec.brand.trim() : '') + ')',
        spec.types.join(', '));
  }

  log('rendering', body.slides.length, 'slides →', dist);
  const built = await render(body, dist, {
    assets, videoFiles, assetDir: staged, title: body.title || body.project,
  });
  log('rendered:', JSON.stringify(built));

  /* FAIL CLOSED. A deploy puts content on a public URL, so it requires an
     explicit `deploy: true`; anything else builds and stops.
     This was originally a `dryRun` opt-OUT, and during development a stale
     bridge process that predated the flag ignored it and published a test deck
     for real. An unrecognised or malformed payload must never reach the
     internet — the safe state has to be the default, not the opt-in. */
  if (body.deploy !== true) {
    log('build only (no deploy: true) — not published');
    return {
      deployed: false, build: BUILD, dist, ...built, url: null,
      preview: 'http://localhost:' + PORT + '/preview/' + body.project + '/',
    };
  }

  log('deploying to surge…');
  const { url, domain } = await deploy(dist, body.project);
  log('live:', url);

  return { url, domain, build: BUILD, ...built, outDir: undefined };
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    // `home` tells the plugin where this bridge folder lives on THIS machine —
    // the sandboxed iframe has no filesystem access and could never otherwise
    // point a designer at the launcher to double-click when the bridge is down.
    send(res, 200, { ok: true, build: BUILD, port: PORT, home: PLUGIN_ROOT });
    return;
  }

  /* Bitmaps are staged before publishing, in batches. A 41-slide deck is tens of
     megabytes; carrying all of it inside one base64 JSON body is slow, memory
     hungry, and gives the designer no progress. */
  if (req.method === 'POST' && url.pathname === '/stage/begin') {
    let body; try { body = await readBody(req); } catch (e) { send(res, 400, { error: e.message }); return; }
    try {
      const dir = stageDir(body.project);
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      log('staging reset for', body.project);
      send(res, 200, { ok: true, build: BUILD });
    } catch (e) { send(res, 400, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/stage/asset') {
    let body; try { body = await readBody(req); } catch (e) { send(res, 400, { error: e.message }); return; }
    try {
      const dir = stageDir(body.project);
      let n = 0;
      for (const f of body.files || []) {
        const rel = String(f.path || '');
        // Asset paths come from the plugin, but treat them as untrusted anyway.
        if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(rel) || rel.includes('..')) {
          throw new Error('bad asset path: ' + rel);
        }
        const dest = path.resolve(dir, rel);
        if (!dest.startsWith(path.resolve(dir) + path.sep)) throw new Error('escapes staging: ' + rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, Buffer.from(f.b64, 'base64'));
        n++;
      }
      send(res, 200, { ok: true, staged: n });
    } catch (e) { send(res, 400, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/publish') {
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { error: e.message }); return; }

    try {
      send(res, 200, await handlePublish(body));
    } catch (e) {
      // The message may carry surge output; deploy.mjs has already scrubbed the token.
      log('publish failed:', e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  /* Serve a built deck so it can be checked BEFORE it goes to a public URL.
     A designer should never have to publish in order to look at it. */
  if (req.method === 'GET' && url.pathname.startsWith('/preview/')) {
    const rest = url.pathname.slice('/preview/'.length);
    const slash = rest.indexOf('/');
    const project = slash === -1 ? rest : rest.slice(0, slash);
    let rel = slash === -1 ? '' : decodeURIComponent(rest.slice(slash + 1));
    if (!rel || rel.endsWith('/')) rel += 'index.html';

    if (!/^[a-z0-9][a-z0-9-]*$/i.test(project)) { send(res, 400, { error: 'bad project' }); return; }

    const root = path.join(os.tmpdir(), 'presentation-export', project, 'dist');
    const file = path.resolve(root, rel);
    // Refuse anything that escapes the build directory.
    if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.resolve(root)) {
      send(res, 403, { error: 'outside the build' });
      return;
    }
    try {
      const buf = await fs.readFile(file);
      cors(res);
      res.writeHead(200, { 'Content-Type': mimeFor(file), 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch {
      send(res, 404, { error: 'no such file in ' + project });
    }
    return;
  }

  send(res, 404, { error: 'not found' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.qt': 'video/quicktime',
  '.ogv': 'video/ogg', '.ogg': 'video/ogg',
};
function mimeFor(f) { return MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'; }

/* Listen on both loopback families. Node's default listen() picks one, and which
   one Figma's iframe resolves `localhost` to differs by OS. */
export function listen(port = PORT) {
  const servers = [];
  let listening = 0;
  for (const host of HOSTS) {
    const s = http.createServer(handler);
    s.listen(port, host, () => {
      listening++;
      log('listening on http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port);
    });
    s.on('error', e => {
      // A machine with IPv6 disabled is normal; one family is enough there.
      if (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT') {
        log('skipping ' + host + ' (' + e.code + ')');
        return;
      }
      if (e.code === 'EADDRINUSE') {
        if (listening > 0) return;             // the other family already covers it
        console.error('Port ' + port + ' is already in use — another bridge is probably running.');
        process.exit(1);
      }
      console.error(host + ': ' + e.message);
    });
    servers.push(s);
  }
  return servers;
}

/* Only listen when run directly. Importing this module — which the tests do, to
   exercise handlePublish — must not bind a port, or the suite cannot run while a
   bridge is up and `import` gains a surprising side effect. */
const runDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (runDirectly) {
  log('presentation-export bridge, build ' + BUILD);
  listen();
  log('plugin should point at http://localhost:' + PORT);
}

export { handler, handlePublish, BUILD };
