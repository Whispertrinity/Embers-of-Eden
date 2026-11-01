#!/usr/bin/env node
/**
 * codex-sync — keeps the Pages of Eden codex HTML and the Data/*.md plan in sync.
 *
 * The page can only write its own HTML file (browser sandbox), so this tool does
 * the rest: it reads what you actually saved, diffs it against the last known
 * state, patches the matching markdown text, and records anything it could not
 * place into an auto-generated block at the bottom of the markdown.
 *
 * Nothing is ever deleted from the markdown. Nothing is guessed.
 *
 * USAGE
 *   node tools/codex-sync.mjs                 # sync every book that changed
 *   node tools/codex-sync.mjs --book "Arms of Eden"
 *   node tools/codex-sync.mjs --check         # report drift, write nothing
 *   node tools/codex-sync.mjs --watch         # run on every Save (leave running)
 *   node tools/codex-sync.mjs --watch --push  # ...and commit+push the sync files
 *
 * OUTPUT FILES (all git-tracked)
 *   design/Pages of Eden/Data/_live/<Book>.json        exact saved DATA, verbatim
 *   design/Pages of Eden/Data/_live/<Book>.state.json  last-seen baseline (diff source)
 *   design/Pages of Eden/Data/<Book>.md                patched plan
 *
 * WHY A BASELINE: the markdown is a richer document than the page — the page is a
 * condensed appendix. Regenerating md from the DATA would throw away prose. So we
 * only ever touch what you changed, and only where the old wording still exists
 * verbatim in the markdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CODEX = path.join(ROOT, 'design', 'Pages of Eden');
const DATA = path.join(CODEX, 'Data');
const LIVE = path.join(DATA, '_live');

const BAKED_RE = /<script type="application\/json" id="codex-baked">([\s\S]*?)<\/script>/;

/* ------------------------------------------------------------------ reading */

// The DATA object is either baked JSON (written by "Save into HTML") or the
// DEFAULT_DATA literal. DEFAULT_DATA builds on small helper factories (W_, A_,
// N_, P_...) defined just above it, so we evaluate it inside a vm sandbox,
// widening the slice until those helpers are all in scope.
function extractDefault(html) {
  const at = html.indexOf('const DEFAULT_DATA');
  if (at < 0) throw new Error('no DEFAULT_DATA found');
  const starts = [...html.slice(0, at).matchAll(/^const /gm)].map(m => m.index);
  const candidates = [at, ...starts.reverse()];
  let lastErr;
  for (const s of candidates) {
    const chunk = html.slice(s, at + html.slice(at).indexOf('\n};') + 3) + '\nreturn DEFAULT_DATA;';
    try {
      return vm.runInNewContext(`(()=>{${chunk}})()`, Object.create(null), { timeout: 5000 });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('could not evaluate DEFAULT_DATA');
}

function readBook(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(BAKED_RE);
  const baked = m && m[1].trim() && m[1].trim() !== 'null' ? JSON.parse(m[1]) : null;
  return { baked, defaults: extractDefault(html) };
}

/* -------------------------------------------------------------------- diff */

function walk(node, base, out) {
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${base}[${i}]`, out));
  else if (node && typeof node === 'object') for (const k of Object.keys(node)) walk(node[k], base ? `${base}.${k}` : k, out);
  else out.push([base, node]);
}

function flatten(o) { const out = []; walk(o, '', out); return new Map(out); }

function diff(prev, next) {
  const a = flatten(prev), b = flatten(next);
  const changes = [];
  for (const [p, v] of b) {
    if (!a.has(p)) changes.push({ path: p, kind: 'added', old: null, new: v });
    else if (JSON.stringify(a.get(p)) !== JSON.stringify(v)) changes.push({ path: p, kind: 'changed', old: a.get(p), new: v });
  }
  for (const [p, v] of a) if (!b.has(p)) changes.push({ path: p, kind: 'removed', old: v, new: null });
  return changes;
}

/* ---------------------------------------------------------------- md patch */

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const q = s => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

// Find a string in prose, tolerating markdown bold, quote styles and whitespace.
function findFlexible(text, needle) {
  const n = q(needle).trim();
  if (!n || n.length < 12) return null;
  const direct = text.indexOf(needle);
  if (direct >= 0) return [direct, direct + needle.length];
  const body = esc(n).replace(/\\ /g, '\\s+').replace(/\*/g, '\\*?');
  const re = new RegExp(body.replace(/\\'|'|"/g, m => `[${m === '"' ? `'"“”` : `'‘’`}]`), 'i');
  const hit = re.exec(text);
  return hit ? [hit.index, hit.index + hit[0].length] : null;
}

function patchMd(md, changes) {
  let text = md;
  const applied = [], pending = [];
  for (const c of changes) {
    if (c.kind !== 'changed' || typeof c.old !== 'string' || typeof c.new !== 'string') { pending.push(c); continue; }
    const span = findFlexible(text, c.old);
    if (!span) { pending.push(c); continue; }
    text = text.slice(0, span[0]) + c.new.replace(/\$/g, '$$$$') + text.slice(span[1]);
    applied.push(c);
  }
  return { text, applied, pending };
}

const BLOCK_START = '<!-- codex-sync:begin — generated by tools/codex-sync.mjs, edits here are overwritten -->';
const BLOCK_END = '<!-- codex-sync:end -->';

function labelOf(p, data) {
  const m = p.match(/^tabs\[(\d+)\]\.(.*)$/);
  if (m) {
    const t = data?.tabs?.[+m[1]];
    const name = t ? (t.title || t.id) : `tab ${m[1]}`;
    return name + ' → ' + m[2].replace(/\./g, ' › ').replace(/\[(\d+)\]/g, ' #$1');
  }
  return p.replace(/\./g, ' › ').replace(/\[(\d+)\]/g, ' #$1');
}

function writeBlock(md, pending, stamp, data) {
  const stripped = md.replace(new RegExp(`\\n*${esc(BLOCK_START)}[\\s\\S]*?${esc(BLOCK_END)}\\n*`, 'g'), '\n');
  if (!pending.length) return stripped.replace(/\n*$/, '\n');
  const lines = [
    BLOCK_START,
    '',
    `## Codex edits not yet merged into the prose above`,
    '',
    `_Saved ${stamp}. These values were changed in the page but could not be matched to existing markdown text._`,
    `_Merge them into the section they belong to, then they disappear from this block on the next run._`,
    '',
  ];
  for (const c of pending) {
    const label = labelOf(c.path, data);
    if (c.kind === 'changed') lines.push(`- **${label}** — was: ${one(c.old)}\n  now: ${one(c.new)}`);
    else if (c.kind === 'added') lines.push(`- **${label}** — new: ${one(c.new)}`);
    else lines.push(`- **${label}** — removed: ${one(c.old)}`);
  }
  lines.push('', BLOCK_END, '');
  return stripped.replace(/\n*$/, '\n') + '\n' + lines.join('\n');
}

const one = v => (v === null || v === undefined ? '—' : '`' + String(v).replace(/\n/g, ' ').slice(0, 400) + '`');

// Noisy paths that change on every save or carry no design decision.
const NOISE = /(^|\.)(meta\.(dataRev|updated|pictures)|art\.[a-z]+|color|icon|kicker|id|label)$/i;
const meaningful = c => !NOISE.test(c.path);

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

function humanDate(d = new Date()) {
  return d.getDate() + ' ' + d.toLocaleString('en-AU', { month: 'long' }) + ' ' + d.getFullYear();
}

function stampUpdated(md, stamp) {
  return md.replace(/^(\*\*Last updated:\*\* )[^\n]*?(\s*)$/m, (_m, p, tail) => p + stamp + (tail ? tail : '  '));
}

/* ------------------------------------------------------------------- sync */

function bookPairs() {
  if (!fs.existsSync(CODEX)) throw new Error(`not found: ${CODEX}`);
  const pairs = [];
  for (const f of fs.readdirSync(CODEX)) {
    if (!f.endsWith('.html')) continue;
    const base = f.replace(/\.html$/, '');
    const md = path.join(DATA, base.replace(/ /g, '_') + '.md');
    if (fs.existsSync(md)) pairs.push({ name: base, html: path.join(CODEX, f), md });
  }
  return pairs;
}

function syncBook(b, { check }) {
  const { baked, defaults } = readBook(b.html);
  const current = baked || defaults;
  const slug = b.name.replace(/ /g, '_');
  const statePath = path.join(LIVE, slug + '.state.json');
  const metaPath = path.join(LIVE, slug + '.meta.json');
  const livePath = path.join(LIVE, slug + '.json');

  const baseline = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : defaults;                       // first run: the page's own factory data is the baseline

  const changes = diff(baseline, current).filter(meaningful);
  if (check) {
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
    const directMdEdit = !!meta && md5(fs.readFileSync(b.md, 'utf8')) !== meta.mdHash;
    const note = changes.length ? 'drift (not written)' : directMdEdit ? 'md edited directly (page not updated)' : 'unchanged';
    return { name: b.name, changes, note };
  }

  fs.mkdirSync(LIVE, { recursive: true });
  fs.writeFileSync(livePath, JSON.stringify(current, null, 2) + '\n');

  if (!changes.length) {
    fs.writeFileSync(statePath, JSON.stringify(current, null, 2) + '\n');
    return { name: b.name, changes, note: 'unchanged' };
  }

  const md = fs.readFileSync(b.md, 'utf8');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const patched = patchMd(md, changes);
  const out = writeBlock(stampUpdated(patched.text, humanDate()), patched.pending, stamp, current);

  fs.writeFileSync(statePath, JSON.stringify(current, null, 2) + '\n');
  fs.writeFileSync(b.md, out);

  return { name: b.name, changes, applied: patched.applied.length, pending: patched.pending.length, src: baked ? 'saved page' : 'factory data' };
}

function report(r) {
  if (r.note === 'unchanged') return null;
  const head = `── ${r.name} — ${r.changes.length} change${r.changes.length === 1 ? '' : 's'}`;
  if (r.note === 'drift (not written)') return head + ' (drift, --check)\n' + r.changes.map(c => '   • ' + c.path).join('\n');
  return `${head}\n   source: ${r.src} · merged into md: ${r.applied} · pending: ${r.pending}`;
}

function push() {
  const files = ['design/Pages of Eden/Data'];
  try {
    execFileSync('git', ['add', ...files], { cwd: ROOT, stdio: 'ignore' });
    const dirty = execFileSync('git', ['status', '--porcelain', ...files], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (!dirty) return console.log('push: nothing to commit');
    const msg = `codex: sync plan from page saves (${new Date().toISOString().slice(0, 10)})`;
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: ROOT, stdio: 'inherit' });
    console.log('push: committed + pushed to origin');
  } catch (e) { console.error('push failed:', e.message); process.exitCode = 1; }
}

/* -------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const opts = { check: has('--check'), watch: has('--watch'), push: has('--push') };
const only = val('--book');

function runOnce() {
  const pairs = bookPairs().filter(b => !only || b.name.toLowerCase() === only.toLowerCase());
  if (!pairs.length) { console.error(only ? `no book matching "${only}"` : 'no book/md pairs found'); process.exitCode = 1; return 0; }
  let touched = 0;
  for (const b of pairs) {
    try {
      const r = syncBook(b, opts);
      const line = report(r);
      if (line) { console.log(line); touched++; }
    } catch (e) { console.error(`!! ${b.name}: ${e.message}`); process.exitCode = 1; }
  }
  if (!touched) console.log('in sync — nothing to do');
  return touched;
}

if (!opts.watch) {
  const n = runOnce();
  if (n && opts.push && !opts.check) push();
} else {
  console.log(`watching ${CODEX} for saves… (ctrl-c to stop)`);
  runOnce();
  const timers = new Map();
  fs.watch(CODEX, (evt, file) => {
    if (!file || !file.endsWith('.html')) return;
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => {
      const b = bookPairs().find(p => path.basename(p.html) === file);
      if (!b) return;
      const r = syncBook(b, opts);
      const line = report(r);
      if (line) { console.log(`[${new Date().toLocaleTimeString()}] ${line}`); if (opts.push) push(); }
    }, 1200));
  });
}
