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
import { PackageService, validateWorkspaceRelPath } from '../server/services/PackageService.js';
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
  describeBindMountStrategy,
  chooseDockerWorkspaceStrategy,
  SAVES_BIND_TARGET,
} from '../server/workspace/WorkspaceStrategy.js';
import { createHostFsWatcher } from '../server/workspace/HostFsWatcher.js';
import {
  readHostWorkspaceFiles,
  writeHostWorkspaceFiles,
  clearHostDirContents,
  wipeBindMountViaExec,
} from '../server/workspace/HostWorkspace.js';
import { RuntimeProvider, RuntimeSession } from '../server/runtime/RuntimeProvider.js';
import { WslRuntimeProvider } from '../server/runtime/WslRuntimeProvider.js';
import { displayLearnerPath, learnerShellEnv } from '../server/runtime/learnerShellEnv.js';
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
  const DIR = { type: 'dir' };
  const files = new Map();
  const rememberParents = (name) => {
    const parts = String(name).split('/');
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (!files.has(acc)) files.set(acc, DIR);
    }
  };
  for (const file of initialFiles) {
    if (file.type === 'dir') files.set(file.name, DIR);
    else {
      rememberParents(file.name);
      files.set(file.name, file.content || '');
    }
  }
  const session = {
    workspaceDir: '/home/student/workspace',
    async ensureWorkspace() {},
    async writeFiles(next, opts = {}) {
      if (opts.clear !== false) files.clear();
      for (const file of next || []) {
        if (file.type === 'dir') files.set(file.name, DIR);
        else {
          rememberParents(file.name);
          files.set(file.name, file.content || '');
        }
      }
    },
    async readFiles() {
      return [...files.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, content]) => (
          content && typeof content === 'object' && content.type === 'dir'
            ? { name, type: 'dir' }
            : { name, type: 'file', content }
        ));
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
          return {
            stdout: names.map(name => {
              const val = files.get(name);
              const kind = val && typeof val === 'object' && val.type === 'dir' ? 'd' : 'f';
              return `${kind}\t${name}\n`;
            }).join(''),
            stderr: '',
            exitCode: 0,
          };
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
  const wsl = registry.listKernels().find(kernel => kernel.id === 'wsl-system-gcc');
  assert.ok(wsl);
  assert.equal(wsl.implemented, false);
  const resolved = registry.resolveForPackage(pkg);
  assert.equal(resolved.selected.id, 'gcc-ubuntu24-docker');
  assert.equal(resolved.candidates.find(c => c.id === 'wsl-system-gcc')?.compatible, false);
});

await test('WslRuntimeProvider is a 501 placeholder', async () => {
  const provider = new WslRuntimeProvider({ hostSavesDir: '/tmp/saves' });
  assert.equal(provider.kind, 'wsl');
  await assert.rejects(
    () => provider.startSession(),
    (error) => error.code === 'provider_unimplemented' && error.statusCode === 501
  );
});

await test('RuntimeSession.tempScriptPath lives on the session', () => {
  const session = new RuntimeSession();
  assert.equal(session.tempScriptPath('01-first-program', 'test'), '/tmp/01-first-program.test.sh');
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

await test('chooseDockerWorkspaceStrategy bind-mounts linux ext4 and refuses slow mounts', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-ws-'));
  try {
    const forcedInternal = chooseDockerWorkspaceStrategy({
      location: '/home/student/workspace',
      hostPath: tmp,
      mode: 'runtime-internal',
      platform: 'linux',
    });
    assert.equal(forcedInternal.kind, WORKSPACE_STRATEGY_KINDS.RUNTIME_INTERNAL);
    assert.equal(forcedInternal.reason, 'forced');

    const windowsDrive = chooseDockerWorkspaceStrategy({
      location: '/home/student/workspace',
      hostPath: '/mnt/c/Users/someone/.multilab-state/workspaces/live',
      mode: 'auto',
      platform: 'linux',
    });
    assert.equal(windowsDrive.kind, WORKSPACE_STRATEGY_KINDS.RUNTIME_INTERNAL);
    assert.equal(windowsDrive.reason, 'windows-drive');

    const darwin = chooseDockerWorkspaceStrategy({
      location: '/home/student/workspace',
      hostPath: tmp,
      mode: 'auto',
      platform: 'darwin',
    });
    assert.equal(darwin.kind, WORKSPACE_STRATEGY_KINDS.RUNTIME_INTERNAL);

    const auto = chooseDockerWorkspaceStrategy({
      location: '/home/student/workspace',
      hostPath: tmp,
      mode: 'auto',
      platform: 'linux',
    });
    if (process.platform === 'linux') {
      assert.equal(auto.kind, WORKSPACE_STRATEGY_KINDS.BIND_MOUNT);
      assert.equal(auto.hostPath, tmp);
      assert.equal(auto.bindTarget, SAVES_BIND_TARGET);
      assert.equal(auto.capabilities.hostReadable, true);
      assert.equal(auto.watch, 'host-fs');
    } else {
      assert.equal(auto.kind, WORKSPACE_STRATEGY_KINDS.RUNTIME_INTERNAL);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('WorkspaceService bind-mount writes on host without session.exec', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-bind-'));
  try {
    const hostPath = path.join(tmp, 'live');
    const session = {
      workspaceDir: '/home/student/workspace',
      workspaceStrategy: describeBindMountStrategy({
        location: '/home/student/workspace',
        hostPath,
      }),
      async ensureWorkspace() {},
      async exec() { throw new Error('session.exec should not run for bind-mount IO'); },
      async writeFiles() { throw new Error('session.writeFiles should not run for bind-mount IO'); },
      async readFiles() { throw new Error('session.readFiles should not run for bind-mount IO'); },
    };
    const workspaceService = new WorkspaceService({ runtimeSession: session });
    await workspaceService.syncFromFiles([{ name: 'hello.c', content: 'int main(){}\n' }]);
    const onDisk = await fs.readFile(path.join(hostPath, 'hello.c'), 'utf8');
    assert.equal(onDisk, 'int main(){}\n');
    const snapshot = await workspaceService.snapshot();
    assert.equal(snapshot[0].name, 'hello.c');
    const listed = await workspaceService.listFiles();
    assert.deepEqual(listed.files, [{ name: 'hello.c', type: 'file' }]);
    const read = await workspaceService.readFile('/home/student/workspace/hello.c');
    assert.equal(read.content, 'int main(){}\n');
    await workspaceService.writeFile('/home/student/workspace/notes.txt', 'hi\n');
    const tree = await workspaceService.listTree({ depth: 2 });
    assert.ok(tree.entries.some(entry => entry.name === 'notes.txt'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('SaveService bind-mount load points workspace at the step save dir', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-save-bind-'));
  try {
    const saves = path.join(tmp, 'saves');
    const pointed = [];
    const session = {
      workspaceDir: '/home/student/workspace',
      workspaceStrategy: describeBindMountStrategy({
        location: '/home/student/workspace',
        hostPath: saves,
        bindTarget: SAVES_BIND_TARGET,
      }),
      async ensureWorkspace() {},
      async pointWorkspace(target) { pointed.push(target); },
      async exec() { throw new Error('session.exec should not run for bind-mount IO'); },
      async writeFiles() { throw new Error('session.writeFiles should not run for bind-mount IO'); },
      async readFiles() { throw new Error('session.readFiles should not run for bind-mount IO'); },
    };
    const workspaceService = new WorkspaceService({ runtimeSession: session });
    const packageService = new PackageService({ tutorialsDir: TUTORIALS_DIR });
    const saveService = new SaveService({
      runtimeStateDir: tmp,
      workspaceService,
      packageService,
    });
    const loaded = await saveService.loadStepState('hello-c', '01-first-program');
    const cfg = await packageService.loadTutorial('hello-c');
    const dest = saveService.saveDir(cfg, '01-first-program');
    assert.equal(workspaceService.describe().hostPath, dest);
    assert.equal(pointed.length, 1);
    assert.ok(pointed[0].startsWith(`${SAVES_BIND_TARGET}/`));
    assert.ok(pointed[0].endsWith('/steps/01-first-program/files'));
    assert.ok(loaded.files.some(file => file.name === 'hello.c'));
    const onDisk = await fs.readFile(path.join(dest, 'hello.c'), 'utf8');
    assert.ok(onDisk.includes('main') || onDisk.length > 0);

    await workspaceService.writeFiles([{ name: 'hello.c', content: 'changed\n' }], { clear: false });
    await saveService.saveStepState('hello-c', '01-first-program');
    assert.equal(await fs.readFile(path.join(dest, 'hello.c'), 'utf8'), 'changed\n');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('HostWorkspace chmod+rm clears a 0555 dir the host owns', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-perm-'));
  try {
    const hostPath = path.join(tmp, 'live');
    const strategy = describeBindMountStrategy({
      location: '/home/student/workspace',
      hostPath,
    });
    await writeHostWorkspaceFiles(strategy, [
      { name: 'keep.c', content: 'old\n' },
      { name: 'locked/x', content: 'secret\n' },
    ]);
    await fs.chmod(path.join(hostPath, 'locked'), 0o555);
    await clearHostDirContents(hostPath);
    await assert.rejects(() => fs.access(path.join(hostPath, 'locked')));
    await writeHostWorkspaceFiles(strategy, [{ name: 'hello.c', content: 'ok\n' }]);
    assert.equal(await fs.readFile(path.join(hostPath, 'hello.c'), 'utf8'), 'ok\n');
  } finally {
    await fs.chmod(path.join(tmp, 'live', 'locked'), 0o777).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('wipeBindMountViaExec chmods and rm as root', async () => {
  const calls = [];
  await wipeBindMountViaExec(async (cmd, opts) => {
    calls.push({ cmd, opts });
    return { stdout: '', stderr: '', exitCode: 0 };
  }, '/home/student/workspace');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.user, 'root');
  assert.ok(String(calls[0].cmd[2]).includes('chmod -R a+rwX'));
  assert.ok(String(calls[0].cmd[2]).includes('find'));
});

await test('HostFsWatcher fires on add, not on content-only edits', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-watch-'));
  try {
    const hostPath = path.join(tmp, 'live');
    await fs.mkdir(hostPath, { recursive: true });
    await fs.writeFile(path.join(hostPath, 'a.c'), 'a\n');
    const strategy = describeBindMountStrategy({
      location: '/home/student/workspace',
      hostPath,
    });
    let fired = 0;
    const watcher = createHostFsWatcher(strategy, () => { fired += 1; }, { debounceMs: 40 });
    await new Promise(resolve => setTimeout(resolve, 60));
    const beforeAdd = fired;
    await fs.writeFile(path.join(hostPath, 'b.c'), 'b\n');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.ok(fired > beforeAdd, `expected add to fire, before=${beforeAdd} after=${fired}`);
    const afterAdd = fired;
    await fs.writeFile(path.join(hostPath, 'a.c'), 'changed\n');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(fired, afterAdd, 'content-only edit must not fire');
    watcher.stop();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('HostFsWatcher on bind source fires for nested step files', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-watch-bind-'));
  try {
    const bindHostPath = path.join(tmp, 'saves');
    const hostPath = path.join(bindHostPath, 'hello-c', '1.0.0', 'digest', 'steps', '01', 'files');
    await fs.mkdir(hostPath, { recursive: true });
    await fs.writeFile(path.join(hostPath, 'a.c'), 'a\n');
    const strategy = {
      ...describeBindMountStrategy({
        location: '/home/student/workspace',
        hostPath,
        bindTarget: SAVES_BIND_TARGET,
      }),
      bindHostPath,
    };
    let fired = 0;
    const watcher = createHostFsWatcher(strategy, () => { fired += 1; }, { debounceMs: 40 });
    await new Promise(resolve => setTimeout(resolve, 80));
    const before = fired;
    await fs.mkdir(path.join(hostPath, 'nested'), { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.ok(fired > before, `expected nested mkdir to fire via bind source watch, before=${before} after=${fired}`);
    watcher.stop();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
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
  const cmds = [];
  const session = {
    workspaceDir: '/home/student/workspace',
    async exec(cmd) {
      cmds.push(cmd);
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
  assert.equal(cmds[0][0], 'find');
  assert.equal(cmds[0][1], '-H', 'find must follow a symlink workspace start path');
});

await test('displayLearnerPath hides the physical save tree', () => {
  const physical = '/home/student/.mlab-saves/hello-c/1.0.0/sha256-8468b2e6412650f97a3ad351eb73828fff25031abe4665938110d50f09c2e2c8/steps/01-first-program/files';
  assert.equal(displayLearnerPath(physical), '~/workspace');
  assert.equal(displayLearnerPath(`${physical}/test/c`), '~/workspace/test/c');
  assert.equal(displayLearnerPath('/home/student/workspace'), '~/workspace');
  assert.equal(displayLearnerPath('/home/student/workspace/src/main.c'), '~/workspace/src/main.c');
  const env = learnerShellEnv();
  const ps1 = env.find(item => item.startsWith('PS1='));
  assert.ok(ps1, 'learner shell must set PS1');
  assert.ok(!ps1.includes('\\w'), 'PS1 must not use \\w (it prints the physical save path)');
  assert.ok(ps1.includes('.mlab-saves'), 'PS1 must rewrite .mlab-saves paths');
});

await test('SaveService.loadStepState template inherit syncs into workspace', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const { saveService, files } = createSaveService(tmp);
    const loaded = await saveService.loadStepState('hello-c', '01-first-program');
    assert.equal(loaded.inheritMode, 'template');
    assert.equal(loaded.hasOwnSave, true);
    assert.ok(loaded.files.some(file => file.name === 'hello.c'));
    assert.equal(loaded.ui.active_file, 'hello.c');
    assert.deepEqual(loaded.ui.open_files, ['hello.c']);
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

await test('validateWorkspaceRelPath accepts nested paths and rejects escapes', () => {
  assert.equal(validateWorkspaceRelPath('src/foo.c'), 'src/foo.c');
  assert.throws(() => validateWorkspaceRelPath('../secret'), /Invalid/);
  assert.throws(() => validateWorkspaceRelPath('/abs'), /Invalid/);
  assert.throws(() => validateWorkspaceRelPath('a//b'), /Invalid/);
});

await test('HostWorkspace snapshot keeps nested files and empty dirs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-hostws-'));
  try {
    const strategy = describeBindMountStrategy({
      location: '/home/student/workspace',
      hostPath: tmp,
    });
    await writeHostWorkspaceFiles(strategy, [
      { name: 'src/main.c', content: 'int x;\n' },
      { name: 'notes', type: 'dir' },
    ]);
    const entries = await readHostWorkspaceFiles(strategy);
    assert.ok(entries.some(entry => entry.name === 'src' && entry.type === 'dir'));
    assert.ok(entries.some(entry => entry.name === 'src/main.c' && entry.content === 'int x;\n'));
    assert.ok(entries.some(entry => entry.name === 'notes' && entry.type === 'dir'));
    assert.ok((await fs.stat(path.join(tmp, 'notes'))).isDirectory());
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('SaveService snapshots nested files, empty dirs, and step UI', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const { saveService, packageService, session } = createSaveService(tmp);
    await saveService.loadStepState('hello-c', '01-first-program');
    await session.writeFiles([
      { name: 'hello.c', content: 'int main(){return 0;}\n' },
      { name: 'src/util.h', content: '#pragma once\n' },
      { name: 'empty', type: 'dir' },
    ], { clear: true });
    const saved = await saveService.saveStepState('hello-c', '01-first-program', null, {
      ui: {
        open_files: ['hello.c', 'src/util.h'],
        active_file: 'src/util.h',
        panes: [{ type: 'preview', id: 'web' }],
      },
    });
    assert.deepEqual(saved.ui.open_files, ['hello.c', 'src/util.h']);
    assert.equal(saved.ui.active_file, 'src/util.h');
    assert.deepEqual(saved.ui.panes, [{ type: 'preview', id: 'web' }]);

    const dest = saveService.saveDir(await packageService.loadTutorial('hello-c'), '01-first-program');
    assert.equal(await fs.readFile(path.join(dest, 'src', 'util.h'), 'utf8'), '#pragma once\n');
    assert.ok((await fs.stat(path.join(dest, 'empty'))).isDirectory());

    const loaded = await saveService.loadStepState('hello-c', '01-first-program');
    assert.ok(loaded.files.some(file => file.name === 'src/util.h'));
    assert.ok(loaded.files.some(file => file.name === 'empty' && file.type === 'dir'));
    assert.deepEqual(loaded.ui.open_files, ['hello.c', 'src/util.h']);
    assert.equal(loaded.ui.active_file, 'src/util.h');
    assert.deepEqual(loaded.ui.panes, [{ type: 'preview', id: 'web' }]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('Save archive roundtrip keeps nested files, empty dirs, and ui.json', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-smoke-'));
  try {
    const { saveService, packageService } = createSaveService(tmp);
    const archiveService = new MlabSaveArchiveService({ saveService });
    await saveService.loadStepState('hello-c', '01-first-program');
    await saveService.workspaceService.writeFiles([
      { name: 'hello.c', content: 'int main(){return 0;}\n' },
      { name: 'src/util.h', content: '#pragma once\n' },
      { name: 'empty', type: 'dir' },
    ], { clear: true });
    await saveService.saveStepState('hello-c', '01-first-program', null, {
      ui: { open_files: ['src/util.h'], active_file: 'src/util.h' },
    });

    const exportPath = path.join(tmp, 'nested.mlab-save');
    await archiveService.exportArchive('hello-c', exportPath);
    const cfg = await packageService.loadTutorial('hello-c');
    await fs.rm(saveService.packageSaveRoot(cfg), { recursive: true, force: true });
    const imported = await archiveService.importArchive(exportPath);
    assert.deepEqual(imported.steps, ['01-first-program']);

    const dest = saveService.saveDir(cfg, '01-first-program');
    assert.equal(await fs.readFile(path.join(dest, 'src', 'util.h'), 'utf8'), '#pragma once\n');
    assert.ok((await fs.stat(path.join(dest, 'empty'))).isDirectory());
    const ui = JSON.parse(await fs.readFile(saveService.stepUiPath(cfg, '01-first-program'), 'utf8'));
    assert.deepEqual(ui.open_files, ['src/util.h']);
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
