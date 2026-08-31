/**
 * Deploy a built dist/ to Surge.
 *
 * The token is read from NOCT/credentials/surge.env at run time and never
 * hardcoded, never logged, and never returned to the plugin. The plugin folder
 * stays shareable.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Walk up to the NOCT/ folder, so this works wherever the repo is checked out. */
export async function findCredentials(startDir = HERE) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'NOCT', 'credentials', 'surge.env');
    try { await fs.access(candidate); return candidate; } catch {}
    // Also handle being *inside* NOCT already.
    if (path.basename(dir) === 'NOCT') {
      const inner = path.join(dir, 'credentials', 'surge.env');
      try { await fs.access(inner); return inner; } catch {}
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Minimal .env parse — no dependency, tolerant of quotes, comments and CRLF. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export async function readSurgeToken() {
  const file = await findCredentials();
  if (!file) throw new Error('surge.env not found — expected NOCT/credentials/surge.env');
  const env = parseEnv(await fs.readFile(file, 'utf8'));
  const token = env.SURGE_TOKEN || env.SURGE_LOGIN_TOKEN;
  if (!token) throw new Error('SURGE_TOKEN missing from ' + file);
  return { token, login: env.SURGE_LOGIN || env.SURGE_EMAIL || null };
}

/** Surge accepts `<slug>.surge.sh`; validate before spending a deploy on a typo. */
export function domainFor(project) {
  const slug = String(project || '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.length < 3 || slug.length > 63) {
    throw new Error('invalid project name: ' + JSON.stringify(project));
  }
  return slug + '.surge.sh';
}

/**
 * Run surge non-interactively. Never runs `surge login` — an interactive prompt
 * inside a spawned process is a hang with no error, which is the worst failure
 * shape for something a designer triggers from a plugin.
 */
export function runSurge(distDir, domain, token, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(npx, ['--yes', 'surge', distDir, domain], {
      env: { ...process.env, SURGE_TOKEN: token, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('surge timed out after ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);

    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const combined = out + '\n' + err;
      if (code !== 0) { reject(new Error(scrub(combined, token) || ('surge exited ' + code))); return; }
      resolve({ url: 'https://' + domain, log: scrub(combined, token) });
    });
  });
}

/** A token must never reach a log line, a plugin response, or an error message. */
export function scrub(text, token) {
  if (!token) return String(text || '').trim();
  return String(text || '').split(token).join('«token»').trim();
}

export async function deploy(distDir, project, opts = {}) {
  const domain = domainFor(project);
  const { token } = await readSurgeToken();
  const res = await runSurge(distDir, domain, token, opts);
  return { url: res.url, domain };
}
