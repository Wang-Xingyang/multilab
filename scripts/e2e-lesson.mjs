/**
 * MultiLab end-to-end lesson flow (Docker required for run/test).
 *
 * Runs against an existing server (default http://localhost:3000). For full
 * isolation start a separate server first:
 *   PORT=3001 RUNTIME_STATE_DIR=/tmp/ml-e2e-state PACKAGE_LIBRARY_DIR=/tmp/ml-e2e-pkgs \
 *     CONTAINER_NAME=multilab-e2e node server/index.js
 *   ML_URL=http://localhost:3001 node scripts/e2e-lesson.mjs
 *
 * Usage:
 *   node scripts/e2e-lesson.mjs
 *   npm run test:e2e   # from multilab/server
 */
import assert from 'assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import { createWriteStream } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TUTORIALS_DIR = path.resolve(ROOT, '../tutorials');
const BASE = process.env.ML_URL || 'http://localhost:3000';

let WebSocket;
try {
  WebSocket = require(path.join(ROOT, 'server/node_modules/ws')).WebSocket;
} catch {
  WebSocket = globalThis.WebSocket;
}

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failed += 1; failures.push(name); console.log(`  FAIL  ${name}: ${e.message}`); }
}

const api = (p, opts = {}) => fetch(`${BASE}${p}`, opts).then(async (r) => {
  const txt = await r.text();
  let body = txt;
  try { body = JSON.parse(txt); } catch {}
  return { ok: r.ok, status: r.status, body };
});
const apiJson = (p, body) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function wsCollect(tutorial, step, command, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
    let out = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(out);
    };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') ws.send(JSON.stringify({ type: 'command', tutorial, step, command }));
      else if (msg.type === 'output') out += msg.data;
      else if (msg.type === 'command_done') finish();
      else if (msg.type === 'error') finish(new Error(msg.message));
    });
    ws.on('error', (e) => finish(e));
    setTimeout(() => finish(new Error('ws timeout')), timeoutMs);
  });
}

console.log(`\nMultiLab E2E lesson flow against ${BASE}\n`);

// --- A/B. tutorial list + open + run/test ---
await test('tutorial list includes hello-c', async () => {
  const { body } = await api('/api/tutorials');
  const t = body.tutorials.find((x) => x.id === 'hello-c');
  assert.ok(t, 'hello-c missing from list');
  assert.ok(t.package_digest?.startsWith('sha256:'));
});

await test('tutorial detail returns progress for resume', async () => {
  const { body } = await api('/api/tutorials/hello-c');
  assert.ok(body.progress, 'detail missing progress');
  // On a fresh tutorial current_step is null; after a step visit it is a string.
  assert.ok(
    body.progress.current_step === null || typeof body.progress.current_step === 'string',
    `current_step must be null|string, got ${typeof body.progress.current_step}`
  );
  assert.ok(Array.isArray(body.progress.visited));
  assert.equal(body.trust, 'untrusted');
});

await test('captured test command PASS on first exercise', async () => {
  await apiJson('/api/steps/load', { tutorial: 'hello-c', step: '01-watch-hello' });
  await apiJson('/api/steps/load', { tutorial: 'hello-c', step: '02-first-program' });
  const { body } = await apiJson('/api/commands/run', { tutorial: 'hello-c', step: '02-first-program', command: 'test' });
  assert.equal(body.passed, true, `expected passed=true, got exitCode=${body.exitCode} output=${(body.output || '').slice(0, 120)}`);
});

await test('WS interactive run outputs program text', async () => {
  const out = await wsCollect('hello-c', '02-first-program', 'run');
  assert.match(out, /Hello, CS Student/);
});

// --- B. save + resume ---
await test('step save persists and resume survives reload', async () => {
  await apiJson('/api/steps/load', { tutorial: 'hello-c', step: '05-args' });
  const { body } = await api('/api/tutorials/hello-c');
  assert.equal(body.progress.current_step, '05-args', 'current_step must reflect last loaded step, not step 0');
});

await test('step reset restores template files', async () => {
  const { body } = await apiJson('/api/steps/reset', { tutorial: 'hello-c', step: '02-first-program' });
  assert.ok(body.files.some((f) => f.name === 'hello.c'));
});

// --- C. kernel + trust + diagnostics ---
await test('kernel resolve picks offline gcc kernel for hello-c', async () => {
  const { body } = await api('/api/kernels/resolve?tutorial=hello-c');
  assert.equal(body.selected.id, 'gcc-ubuntu24-docker');
  assert.equal(body.selected.network_default, 'none');
});

await test('trust toggles untrusted -> user-trusted -> untrusted', async () => {
  const before = (await api('/api/trust?package_digest=' + encodeURIComponent('sha256:' + '0'.repeat(64)))).body;
  assert.equal(before.trust, 'untrusted');
  const set = (await apiJson('/api/trust', { package_digest: 'sha256:' + '0'.repeat(64), trust: 'user-trusted' })).body;
  assert.equal(set.trust, 'user-trusted');
  const back = (await apiJson('/api/trust', { package_digest: 'sha256:' + '0'.repeat(64), trust: 'untrusted' })).body;
  assert.equal(back.trust, 'untrusted');
});

await test('diagnostics aggregates kernel/trust/runtime for hello-c', async () => {
  const { body } = await api('/api/diagnostics?tutorial=hello-c');
  assert.equal(body.resolution.selected.id, 'gcc-ubuntu24-docker');
  assert.equal(body.trust.trust, 'untrusted');
  assert.ok(body.runtime.image);
  assert.equal(body.runtime.probe?.ok, true, `probe should find the OS image, got ${JSON.stringify(body.runtime.probe)}`);
});

// --- D. package library: pack -> upload -> list -> open -> delete ---
let uploadedPkg = null;
await test('pack hello-c to .mlab via pack_mlab.py', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ml-e2e-'));
  const outPath = path.join(tmp, 'hello-c.mlab');
  await new Promise((resolve, reject) => {
    const py = spawn('python3', [path.join(ROOT, 'docs/tutorial-skill/scripts/pack_mlab.py'), TUTORIALS_DIR + '/hello-c', '-o', outPath]);
    let err = '';
    py.stderr.on('data', (d) => { err += d; });
    py.on('close', (c) => (c === 0 ? resolve() : reject(new Error('pack failed: ' + err))));
  });
  const stat = await fs.stat(outPath);
  assert.ok(stat.size > 0);
  // upload
  const buf = await fs.readFile(outPath);
  const res = await fetch(`${BASE}/api/packages/upload`, {
    method: 'POST', headers: { 'x-filename': 'hello-c.mlab', 'content-type': 'application/octet-stream' }, body: buf,
  });
  uploadedPkg = (await res.json());
  assert.ok(uploadedPkg.source_key?.startsWith('pkg-'), `expected source_key pkg-*, got ${uploadedPkg.source_key}`);
  await fs.rm(tmp, { recursive: true, force: true });
});

await test('package library lists uploaded package and opens installed source', async () => {
  const { body } = await api('/api/packages');
  const found = body.packages.find((p) => p.digest === uploadedPkg.digest);
  assert.ok(found, 'uploaded package not in library list');
  const detail = (await api(`/api/tutorials/${encodeURIComponent(found.source_key)}`)).body;
  assert.equal(detail.source_type, 'installed');
});

await test('delete installed package removes it from library', async () => {
  const params = new URLSearchParams({ id: uploadedPkg.id, version: uploadedPkg.version || '1.0.0', digest: uploadedPkg.digest });
  const { ok } = await api(`/api/packages/item?${params}`, { method: 'DELETE' });
  assert.ok(ok);
  const { body } = await api('/api/packages');
  assert.ok(!body.packages.some((p) => p.digest === uploadedPkg.digest), 'deleted package still listed');
});

await test('development hello-c still openable after installed delete', async () => {
  const { ok, body } = await api('/api/tutorials/hello-c');
  assert.ok(ok && body.id === 'hello-c');
});

// --- D. save export/import + package_missing ---
await test('save export/import roundtrip restores progress', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ml-e2e-save-'));
  const exportPath = path.join(tmp, 'hello-c.mlab-save');
  const exp = (await apiJson('/api/saves/export', { tutorial: 'hello-c', path: exportPath })).body;
  assert.ok(exp.files >= 1);
  const imp = (await apiJson('/api/saves/import', { path: exportPath })).body;
  assert.ok(imp.progress);
  await fs.rm(tmp, { recursive: true, force: true });
});

await test('save import with missing package returns package_missing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ml-e2e-missing-'));
  const archivePath = path.join(tmp, 'orphan.mlab-save');
  const yazl = require(path.join(ROOT, 'server/node_modules/yazl'));
  const zipFile = new yazl.ZipFile();
  const saveJson = JSON.stringify({
    package: {
      id: 'hello-c',
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
    },
    current_step: '02-first-program',
    visited: ['02-first-program'],
    test_passed: {},
  }, null, 2) + '\n';
  zipFile.addBuffer(Buffer.from(saveJson), 'save.json');
  zipFile.addBuffer(Buffer.from('int main(){return 0;}\n'), 'steps/02-first-program/files/hello.c');
  await new Promise((resolve, reject) => {
    const output = createWriteStream(archivePath);
    output.on('close', resolve);
    output.on('error', reject);
    zipFile.outputStream.on('error', reject);
    zipFile.outputStream.pipe(output);
    zipFile.end();
  });
  const { status, body } = await apiJson('/api/saves/import', { path: archivePath });
  assert.equal(status, 404, `expected 404, got ${status} ${JSON.stringify(body)}`);
  assert.equal(body.code, 'package_missing');
  assert.equal(body.package?.id, 'hello-c');
  await fs.rm(tmp, { recursive: true, force: true });
});

// --- E. fs tree ---
await test('fs tree lists workspace files', async () => {
  const { body } = await api('/api/fs/ls?path=/home/student/workspace&tree=1&depth=2');
  assert.ok(Array.isArray(body.entries));
  assert.ok(body.entries.some((e) => e.name === 'hello.c'));
  for (const entry of body.entries) {
    const blob = `${entry.path || ''} ${entry.relative || ''} ${entry.name || ''}`;
    assert.ok(!blob.includes('.mlab-saves'), `file-tree leaked save path: ${blob}`);
    assert.ok(!blob.includes('/mlab/saves'), `file-tree leaked save path: ${blob}`);
    assert.ok(!blob.includes('sha256-'), `file-tree leaked digest: ${blob}`);
  }
});

await test('container mkdir shows up in file-tree listing', async () => {
  const container = process.env.CONTAINER_NAME || 'multilab-session';
  const probe = `__mlab_tree_${Date.now()}`;
  await apiJson('/api/steps/load', { tutorial: 'hello-c', step: '02-first-program' });
  const created = spawnSync('docker', ['exec', '-u', 'student', container, 'mkdir', '-p', `/home/student/workspace/${probe}`], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  let found = false;
  for (let i = 0; i < 8; i++) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const { body } = await api('/api/fs/ls?path=/home/student/workspace&tree=1&depth=2');
    found = (body.entries || []).some((e) => e.name === probe || e.relative === probe);
    if (found) break;
  }
  spawnSync('docker', ['exec', '-u', 'student', container, 'rmdir', `/home/student/workspace/${probe}`]);
  assert.ok(found, `mkdir ${probe} did not appear in /api/fs/ls within 3.2s`);
});

await test('learner-visible cwd does not print the save digest path', async () => {
  const container = process.env.CONTAINER_NAME || 'multilab-session';
  await apiJson('/api/steps/load', { tutorial: 'hello-c', step: '02-first-program' });
  const probe = spawnSync('docker', [
    'exec', '-u', 'student', '-w', '/home/student/workspace', container,
    'bash', '--login', '-ic', 'printf %s "$PWD"',
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const pwd = (probe.stdout || '').trim();
  assert.ok(pwd, 'login shell PWD was empty');
  assert.ok(!pwd.includes('.mlab-saves'), `PWD leaked save tree: ${pwd}`);
  assert.ok(!pwd.includes('/mlab/saves'), `PWD leaked save tree: ${pwd}`);
  assert.ok(!pwd.includes('sha256-'), `PWD leaked digest: ${pwd}`);
});

// --- F. untrusted policy still allows hello-c ---
await test('untrusted hello-c passes security policy (sandbox kernel, no network)', async () => {
  const { body } = await api('/api/kernels/resolve?tutorial=hello-c');
  assert.equal(body.selected.network_default, 'none');
  assert.ok(body.selected.capabilities?.includes('sandbox'));
});

console.log('');
console.log(`E2E lesson: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:', failures.join(', '));
process.exit(failed ? 1 : 0);
