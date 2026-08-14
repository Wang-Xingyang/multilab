#!/usr/bin/env node
/**
 * Lightweight MultiLab smoke tests (no Docker required).
 *
 * Usage:
 *   node scripts/smoke-tests.mjs
 *   npm run test:smoke   # from multilab/server
 */

import assert from 'assert/strict';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';

import { normalizePanels, FALLBACK_PANELS } from '../server/services/PanelModel.js';
import { createDefaultKernelRegistry, packageNeedsNetwork } from '../server/services/KernelRegistry.js';
import { PackageService } from '../server/services/PackageService.js';
import { SaveService } from '../server/services/SaveService.js';
import {
  WorkspaceService,
  parseFindTreeOutput,
  sortWorkspaceTreeEntries,
} from '../server/services/WorkspaceService.js';
import { createFindPollingWatcher } from '../server/workspace/FindPollingWatcher.js';
import {
  WORKSPACE_STRATEGY_KINDS,
  describeRuntimeInternalStrategy,
} from '../server/workspace/WorkspaceStrategy.js';
import { RuntimeProvider } from '../server/runtime/RuntimeProvider.js';
import { MlabSaveArchiveService } from '../server/services/MlabSaveArchiveService.js';
import { KernelSelectionStore } from '../server/services/KernelSelectionStore.js';
import { sanitizeUploadFilename } from '../server/services/TempArchiveUpload.js';
import { SecurityPolicyService } from '../server/services/SecurityPolicyService.js';
import { TrustStore } from '../server/services/TrustStore.js';
import {
  normalizePublishPorts,
  rewritePreviewUrl,
  buildPreviewMeta,
} from '../server/services/PreviewPortMap.js';
import { t, getCatalog } from '../public/js/messages.js';
import { normalizeProgress, stepIndexFromId } from '../public/js/progress.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TUTORIALS_DIR = path.resolve(ROOT, '../tutorials');

let passed = 0;
let failed = 0;

function createMemoryWorkspaceSession(initialFiles = []) {
  const files = new Map(initialFiles.map(file => [file.name, file.content || '']));
  const session = {
    workspaceDir: '/home/student/workspace',
    async ensureWorkspace() {},
    async writeFiles(next, opts = {}) {
      if (opts.clear !== false) files.clear();
      for (const file of next || []) files.set(file.name, file.content || '');
    },
    async readFiles() {
      return [...files.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, content]) => ({ name, content }));
    },
    async uploadScript(content, filePath) {
      const name = String(filePath || '').split('/').pop();
      files.set(name, content ?? '');
    },
    async exec(cmd) {
      const [bin, ...args] = cmd;
      if (bin === 'find') {
        const printfIdx = args.indexOf('-printf');
        const format = printfIdx >= 0 ? args[printfIdx + 1] : '%f\n';
        const names = [...files.keys()].sort();
        if (String(format).includes('%y')) {
          return { stdout: names.map(name => `f\t${name}\n`).join(''), stderr: '', exitCode: 0 };
        }
        return { stdout: names.map(name => `${name}\n`).join(''), stderr: '', exitCode: 0 };
      }
      if (bin === 'cat') {
        const name = String(args[0] || '').split('/').pop();
        if (!files.has(name)) return { stdout: '', stderr: 'not found', exitCode: 1 };
        return { stdout: files.get(name), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unsupported', exitCode: 1 };
    },
  };
  return { session, files };
}

function createSaveService(tmp, extraFiles = []) {
  const packageService = new PackageService({ tutorialsDir: TUTORIALS_DIR });
  const { session, files } = createMemoryWorkspaceSession(extraFiles);
  const workspaceService = new WorkspaceService({ runtimeSession: session });
  const saveService = new SaveService({
    runtimeStateDir: path.join(tmp, 'state'),
    workspaceService,
    packageService,
  });
  return { packageService, saveService, workspaceService, session, files };
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.stack || e.message}`);
  }
}

await test('PanelModel falls back when panels missing', () => {
  const result = normalizePanels(null);
  assert.equal(result.panels.length, FALLBACK_PANELS.length);
  assert.equal(result.has.tutorial, true);
  assert.equal(result.has.editor, true);
  assert.equal(result.has.terminal, true);
});

await test('PanelModel keeps hello-c test-results and file-tree panels', async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(TUTORIALS_DIR, 'hello-c', 'multilab.json'), 'utf8')
  );
  const result = normalizePanels(manifest.default_panels);
  assert.equal(result.has['test-results'], true);
  assert.equal(result.has['file-tree'], true);
  assert.equal(result.has.logs, true);
  assert.equal(result.has.diagnostics, true);
  const testPanel = result.panels.find(p => p.type === 'test-results');
  assert.ok(testPanel);
  assert.equal(testPanel.hidden, true);
  assert.equal(result.has['web-preview'], false);
});

await test('PanelModel ignores unknown panel types', () => {
  const result = normalizePanels([
    { id: 'tutorial', type: 'tutorial', area: 'left' },
    { id: 'evil', type: 'arbitrary-ui', area: 'right' },
  ]);
  assert.equal(result.panels.length, 1);
  assert.equal(result.panels[0].type, 'tutorial');
});

await test('KernelRegistry preferred kernel selection', () => {
  const registry = createDefaultKernelRegistry({
    image: 'multilab/os:latest',
    workspaceDir: '/home/student/workspace',
  });
  const pkg = {
    recommended_kernel: 'gcc-ubuntu24-docker',
    runtime_requirements: {
      platform: 'linux',
      capabilities: ['tty'],
      commands: { gcc: '>=13' },
    },
  };
  const preferred = registry.resolveForPackage(pkg, { preferredKernelId: 'gcc-ubuntu24-docker' });
  assert.equal(preferred.preferred_applied, true);
  assert.equal(preferred.selected.id, 'gcc-ubuntu24-docker');
  const missing = registry.resolveForPackage(pkg, { preferredKernelId: 'nope' });
  assert.equal(missing.preferred_applied, false);
  assert.equal(missing.selected.id, 'gcc-ubuntu24-docker');
});

await test('PackageService loads hello-c with ui_panels', async () => {
  const packageService = new PackageService({ tutorialsDir: TUTORIALS_DIR });
  const tutorial = await packageService.loadTutorial('hello-c');
  assert.equal(tutorial.id, 'hello-c');
  assert.ok(tutorial.package_digest.startsWith('sha256:'));
  assert.ok(tutorial.ui_panels?.has?.['test-results']);
  assert.ok(tutorial.steps.length >= 1);
});

await test('Save archive export/import roundtrip', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const { saveService, packageService } = createSaveService(tmp);
    const archiveService = new MlabSaveArchiveService({ saveService });
    const cfg = await packageService.loadTutorial('hello-c');
    const root = saveService.packageSaveRoot(cfg);
    await fs.mkdir(path.join(root, 'steps', '01-first-program', 'files'), { recursive: true });
    await fs.writeFile(path.join(root, 'steps', '01-first-program', 'files', 'hello.c'), 'int main(){return 0;}\n');
    await saveService.writeSaveMetadata(cfg, {
      current_step: '01-first-program',
      visited: ['01-first-program'],
      test_passed: { '01-first-program': true },
    });
    const exportPath = path.join(tmp, 'hello.mlab-save');
    const exported = await archiveService.exportArchive('hello-c', exportPath);
    assert.ok(exported.files >= 2);
    await fs.rm(root, { recursive: true, force: true });
    const imported = await archiveService.importArchive(exportPath);
    assert.deepEqual(imported.steps, ['01-first-program']);
    assert.equal(imported.progress.test_passed['01-first-program'], true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('SaveService.getProgress reads progress without overwriting current_step', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const { saveService, packageService } = createSaveService(tmp);
    const cfg = await packageService.loadTutorial('hello-c');
    // Fresh tutorial: getProgress must return defaults and NOT create save.json.
    const fresh = await saveService.getProgress(cfg);
    assert.equal(fresh.current_step, null);
    assert.deepEqual(fresh.visited, []);
    await assert.rejects(() => fs.access(saveService.saveMetadataPath(cfg)), (e) => e.code === 'ENOENT');
    // After recording a visit on step 2, getProgress must return that current_step
    // without being reset to step 0 by a probe.
    await saveService.recordStepVisit(cfg, '02-args');
    const after = await saveService.getProgress(cfg);
    assert.equal(after.current_step, '02-args');
    assert.ok(after.visited.includes('02-args'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('KernelSelectionStore persists preference', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const store = new KernelSelectionStore({ runtimeStateDir: tmp });
    const digest = 'sha256:' + 'a'.repeat(64);
    assert.equal(await store.getPreferredKernel(digest), null);
    await store.setPreferredKernel(digest, 'gcc-ubuntu24-docker');
    assert.equal(await store.getPreferredKernel(digest), 'gcc-ubuntu24-docker');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('TempArchiveUpload filename validation', () => {
  assert.equal(sanitizeUploadFilename('hello-c.mlab', '.mlab'), 'hello-c.mlab');
  assert.equal(sanitizeUploadFilename('../x.mlab', '.mlab'), 'x.mlab');
  assert.throws(() => sanitizeUploadFilename('hello.txt', '.mlab'));
});

await test('SecurityPolicyService allows default hello-c path', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const packageService = new PackageService({ tutorialsDir: TUTORIALS_DIR });
    const trustStore = new TrustStore({ runtimeStateDir: tmp });
    const kernelRegistry = createDefaultKernelRegistry({
      image: 'multilab/os:latest',
      workspaceDir: '/home/student/workspace',
    });
    const policy = new SecurityPolicyService({
      packageService,
      trustStore,
      kernelRegistry,
    });
    const auth = await policy.authorizeCommand({ tutorial: 'hello-c' });
    assert.equal(auth.kernel.id, 'gcc-ubuntu24-docker');
    assert.equal(auth.trust.trust, 'untrusted');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('PreviewPortMap rewrites container URLs via host map', () => {
  assert.deepEqual(normalizePublishPorts([8080, '3000', 8080, 'x']), [8080, 3000]);
  assert.equal(
    rewritePreviewUrl('http://0.0.0.0:8080/app', { 8080: 54321 }),
    'http://127.0.0.1:54321/app'
  );
  const meta = buildPreviewMeta('ready\nMULTILAB_PREVIEW_URL=http://127.0.0.1:5173/\n', { 5173: 19090 });
  assert.equal(meta.preview_url, 'http://127.0.0.1:19090/');
  assert.equal(meta.preview_advertised_url, 'http://127.0.0.1:5173/');
});

await test('Frontend messages catalog resolves keys', () => {
  assert.equal(t('trust.trusted'), '已信任');
  assert.equal(t('kernel.switched', { id: 'gcc' }), '已切换到 gcc');
  assert.ok(Object.keys(getCatalog().commands).length >= 5);
  assert.equal(t('missing.key.not.real'), 'missing.key.not.real');
});

await test('KernelRegistry picks net kernel when network/preview ports required', () => {
  const registry = createDefaultKernelRegistry({
    image: 'multilab/os:latest',
    workspaceDir: '/home/student/workspace',
  });
  assert.equal(packageNeedsNetwork({ security: { preview_ports: [8080] } }), true);
  const netPkg = {
    runtime_requirements: { platform: 'linux', capabilities: ['tty'], commands: { gcc: '>=13' } },
    security: { network_required: true },
  };
  const resolved = registry.resolveForPackage(netPkg);
  assert.equal(resolved.selected.id, 'gcc-ubuntu24-docker-net');
  assert.equal(resolved.network_required, true);
  assert.ok(resolved.selected.publish_ports.includes(8080));
  const offline = registry.resolveForPackage({
    recommended_kernel: 'gcc-ubuntu24-docker',
    runtime_requirements: netPkg.runtime_requirements,
    security: { network_required: false },
  });
  assert.equal(offline.selected.id, 'gcc-ubuntu24-docker');
});

console.log('\n--- WorkspaceService ---');

await test('Docker/default workspace strategy is runtime-internal fallback', () => {
  const provider = new RuntimeProvider({ id: 'test', kind: 'docker' });
  provider.workspaceDir = '/home/student/workspace';
  const strategy = provider.workspaceStrategy({ workspace: '/home/student/workspace' });
  assert.equal(strategy.kind, WORKSPACE_STRATEGY_KINDS.RUNTIME_INTERNAL);
  assert.equal(strategy.fallback, true);
  assert.equal(strategy.watch, 'find-polling');
  assert.equal(strategy.capabilities.hostBindMount, false);
  assert.equal(strategy.capabilities.nativeWatch, false);
  const described = describeRuntimeInternalStrategy({ location: '/home/student/workspace' });
  assert.equal(described.location, '/home/student/workspace');
  assert.equal(described.hostPath, null);
});

await test('WorkspaceService path validation stays inside workspace root', () => {
  const { session } = createMemoryWorkspaceSession();
  const workspaceService = new WorkspaceService({ runtimeSession: session });
  assert.equal(
    workspaceService.validatePath('/home/student/workspace/hello.c'),
    '/home/student/workspace/hello.c'
  );
  assert.equal(workspaceService.validatePath('hello.c'), '/home/student/workspace/hello.c');
  assert.throws(() => workspaceService.validatePath('/etc/passwd'), /Access denied/);
  assert.throws(() => workspaceService.validatePath('/home/student/workspace/../etc/passwd'), /Access denied/);
});

await test('WorkspaceService write/snapshot/list/read via memory session', async () => {
  const { session, files } = createMemoryWorkspaceSession();
  const workspaceService = new WorkspaceService({ runtimeSession: session });
  await workspaceService.syncFromFiles([{ name: 'hello.c', content: 'int main(){}\n' }]);
  assert.equal(files.get('hello.c'), 'int main(){}\n');
  const snapshot = await workspaceService.snapshot();
  assert.equal(snapshot[0].name, 'hello.c');
  assert.equal(snapshot[0].language, 'c');
  const listed = await workspaceService.listFiles();
  assert.deepEqual(listed.files, [{ name: 'hello.c', type: 'file' }]);
  const tree = await workspaceService.listTree({ depth: 2 });
  assert.equal(tree.tree, true);
  assert.equal(tree.entries[0].name, 'hello.c');
  const read = await workspaceService.readFile('/home/student/workspace/hello.c');
  assert.equal(read.content, 'int main(){}\n');
});

await test('WorkspaceService tree sort keeps dirs before files and parents first', () => {
  const entries = parseFindTreeOutput(
    'f\thello.c\nd\tsrc\nf\tsrc/main.c\nf\tnotes.txt\n',
    '/home/student/workspace',
    abs => abs
  );
  sortWorkspaceTreeEntries(entries);
  assert.deepEqual(entries.map(entry => entry.relative), ['src', 'src/main.c', 'hello.c', 'notes.txt']);
});

await test('FindPollingWatcher fires when find signature changes', async () => {
  let execCount = 0;
  const session = {
    workspaceDir: '/home/student/workspace',
    async exec() {
      execCount += 1;
      const stdout = execCount === 1 ? 'f\ta.c\n' : 'f\ta.c\nf\tb.c\n';
      return { stdout, stderr: '', exitCode: 0 };
    },
  };
  let fired = 0;
  const watcher = createFindPollingWatcher(session, () => { fired += 1; }, { intervalMs: 25 });
  await new Promise(resolve => setTimeout(resolve, 90));
  watcher.stop();
  assert.ok(execCount >= 2, `expected at least 2 polls, got ${execCount}`);
  assert.ok(fired >= 1, `expected onChange, got ${fired}`);
});

await test('SaveService.loadStepState template inherit syncs into workspace', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const { saveService, files } = createSaveService(tmp);
    const loaded = await saveService.loadStepState('hello-c', '01-first-program');
    assert.equal(loaded.inheritMode, 'template');
    assert.equal(loaded.hasOwnSave, true);
    assert.ok(loaded.files.some(file => file.name === 'hello.c'));
    assert.ok(files.has('hello.c'));
    assert.equal(loaded.progress.current_step, '01-first-program');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('SaveService.saveStepState snapshots workspace into save dir', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const { saveService, packageService, session } = createSaveService(tmp);
    await saveService.loadStepState('hello-c', '01-first-program');
    await session.writeFiles([{ name: 'hello.c', content: 'changed\n' }], { clear: false });
    await saveService.saveStepState('hello-c', '01-first-program');
    const cfg = await packageService.loadTutorial('hello-c');
    const saved = await fs.readFile(
      path.join(saveService.saveDir(cfg, '01-first-program'), 'hello.c'),
      'utf8'
    );
    assert.equal(saved, 'changed\n');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('SaveService.applySaveBundle rejects unknown package digest', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const { saveService } = createSaveService(tmp);
    await assert.rejects(
      () => saveService.applySaveBundle({
        metadata: {
          package: {
            id: 'hello-c',
            version: '1.0.0',
            digest: `sha256:${'f'.repeat(64)}`,
          },
          current_step: '01-first-program',
          visited: ['01-first-program'],
          test_passed: {},
        },
        files: new Map(),
      }),
      (error) => error.code === 'package_missing' && error.statusCode === 404
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

console.log('\n--- frontend progress.js (pure helpers) ---');
await test('normalizeProgress: null/undefined → empty shape', () => {
  const p = normalizeProgress(null);
  assert.deepEqual(p, { current_step: null, visited: [], test_passed: {}, updated_at: null });
  assert.deepEqual(normalizeProgress(undefined), p);
});
await test('normalizeProgress: shallow-copies visited & test_passed', () => {
  const src = { current_step: 's2', visited: ['s1'], test_passed: { s1: true }, updated_at: 123 };
  const p = normalizeProgress(src);
  assert.equal(p.current_step, 's2');
  assert.equal(p.updated_at, 123);
  assert.deepEqual(p.visited, ['s1']);
  assert.deepEqual(p.test_passed, { s1: true });
  // mutation of source must not leak into normalized copy
  src.visited.push('s2');
  src.test_passed.s2 = false;
  assert.deepEqual(p.visited, ['s1']);
  assert.deepEqual(p.test_passed, { s1: true });
});
await test('normalizeProgress: tolerates malformed fields', () => {
  const p = normalizeProgress({ visited: 'not-an-array', test_passed: 42 });
  assert.deepEqual(p.visited, []);
  assert.deepEqual(p.test_passed, {});
});
await test('stepIndexFromId: returns index or -1', () => {
  const tut = { steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] };
  assert.equal(stepIndexFromId(tut, 's2'), 1);
  assert.equal(stepIndexFromId(tut, 'missing'), -1);
  assert.equal(stepIndexFromId(tut, ''), -1);
  assert.equal(stepIndexFromId(null, 's1'), -1);
  assert.equal(stepIndexFromId({ steps: [] }, 's1'), -1);
});

console.log('');
console.log(`Smoke tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
