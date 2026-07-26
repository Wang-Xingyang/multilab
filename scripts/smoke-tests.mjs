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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TUTORIALS_DIR = path.resolve(ROOT, '../tutorials');

let passed = 0;
let failed = 0;

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
    const packageService = new PackageService({ tutorialsDir: TUTORIALS_DIR });
    const saveService = new SaveService({
      runtimeStateDir: path.join(tmp, 'state'),
      runtimeSession: {
        async ensureWorkspace() {},
        async readFiles() { return []; },
        async writeFiles() {},
      },
      packageService,
    });
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

console.log('');
console.log(`Smoke tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
