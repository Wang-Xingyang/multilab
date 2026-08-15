#!/usr/bin/env node
/**
 * Workspace IO latency check (host bind-mount path vs Docker exec fallback).
 *
 * Usage:
 *   node scripts/workspace-latency.mjs
 */

import assert from 'assert/strict';
import { createRequire } from 'module';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describeBindMountStrategy } from '../server/workspace/WorkspaceStrategy.js';
import { createHostFsWatcher } from '../server/workspace/HostFsWatcher.js';
import {
  listHostWorkspaceTree,
  writeHostWorkspaceFiles,
} from '../server/workspace/HostWorkspace.js';
import { DockerRuntimeProvider } from '../server/runtime/DockerRuntimeProvider.js';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/package.json'));
const Docker = require('dockerode');

function ms(start) {
  return Math.round((performance.now() - start) * 10) / 10;
}

const files = Array.from({ length: 20 }, (_, i) => ({
  name: `f${String(i).padStart(2, '0')}.c`,
  content: `int x${i};\n`,
}));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ml-ws-latency-'));
const hostPath = path.join(tmp, 'live');
const strategy = describeBindMountStrategy({
  location: '/home/student/workspace',
  hostPath,
});

let t0 = performance.now();
await writeHostWorkspaceFiles(strategy, files);
const hostWriteMs = ms(t0);

t0 = performance.now();
const tree = await listHostWorkspaceTree(strategy, { depth: 4 });
const hostListMs = ms(t0);
assert.equal(tree.entries.length, 20);

let watchMs = null;
{
  const extra = path.join(hostPath, 'watch-new.c');
  const started = performance.now();
  const notified = new Promise((resolve, reject) => {
    const watcher = createHostFsWatcher(strategy, () => {
      watcher.stop();
      resolve(ms(started));
    }, { debounceMs: 40 });
    setTimeout(() => {
      watcher.stop();
      reject(new Error('host watch timeout'));
    }, 1500);
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  await fs.writeFile(extra, 'int w;\n');
  watchMs = await notified;
}

console.log('Host bind-mount path (no container):');
console.log(`  write 20 small files: ${hostWriteMs} ms`);
console.log(`  listTree depth 4:     ${hostListMs} ms`);
console.log(`  host-fs watch notify: ${watchMs} ms`);

let dockerWriteMs = null;
let dockerFindMs = null;
let dockerBindVisibleMs = null;
try {
  const docker = new Docker();
  const images = await docker.listImages();
  const hasImage = images.some(img => (img.RepoTags || []).includes('multilab/os:latest'));
  if (!hasImage) {
    console.log('\nDocker image multilab/os:latest missing; skipped container comparison.');
  } else {
    const bindDir = path.join(tmp, 'docker-saves');
    const provider = new DockerRuntimeProvider({
      image: 'multilab/os:latest',
      containerName: 'multilab-ws-latency',
      hostSavesDir: bindDir,
      workspaceStrategyMode: 'bind-mount',
      docker,
    });
    const kernel = {
      id: 'latency',
      provider: 'docker',
      image: 'multilab/os:latest',
      workspace: '/home/student/workspace',
      network_default: 'none',
      capabilities: ['sandbox'],
      sandbox_presets: ['standard'],
    };
    await provider.applyKernel(kernel);
    const session = await provider.startSession();
    await session.ensureWorkspace();
    await session.pointWorkspace('/mlab/saves');

    t0 = performance.now();
    await writeHostWorkspaceFiles(session.workspaceStrategy, files);
    const visible = await session.exec(['test', '-f', '/home/student/workspace/f00.c']);
    dockerBindVisibleMs = ms(t0);
    assert.equal(visible.exitCode, 0, 'bind-mounted file not visible in container');

    const internalProvider = new DockerRuntimeProvider({
      image: 'multilab/os:latest',
      containerName: 'multilab-ws-latency-internal',
      hostWorkspaceDir: path.join(tmp, 'unused-internal'),
      workspaceStrategyMode: 'copy',
      docker,
    });
    await internalProvider.applyKernel(kernel);
    const internal = await internalProvider.startSession();
    await internal.ensureWorkspace();
    t0 = performance.now();
    await internal.writeFiles(files);
    dockerWriteMs = ms(t0);
    t0 = performance.now();
    await internal.exec([
      'find', '/home/student/workspace', '-maxdepth', '4', '-mindepth', '1',
      '(', '-type', 'f', '-o', '-type', 'd', ')', '-printf', '%y\t%P\n',
    ], { cwd: '/' });
    dockerFindMs = ms(t0);

    console.log('\nDocker comparison:');
    console.log(`  bind-mount host write + container sees file: ${dockerBindVisibleMs} ms`);
    console.log(`  copy writeFiles (exec copy):                 ${dockerWriteMs} ms`);
    console.log(`  copy find tree:                              ${dockerFindMs} ms`);

    for (const name of ['multilab-ws-latency', 'multilab-ws-latency-internal']) {
      try {
        const container = docker.getContainer(name);
        await container.stop({ t: 2 }).catch(() => {});
        await container.remove({ force: true }).catch(() => {});
      } catch {
        // already gone
      }
    }
  }
} catch (error) {
  console.log(`\nDocker comparison skipped: ${error.message}`);
}

await fs.rm(tmp, { recursive: true, force: true });

const ok = hostWriteMs < 50 && hostListMs < 20 && watchMs < 400
  && (dockerBindVisibleMs == null || dockerBindVisibleMs < 200);
console.log(ok ? '\nLatency check: OK' : '\nLatency check: slower than expected (not a hard fail)');
process.exit(0);
