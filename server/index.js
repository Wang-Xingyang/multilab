// MultiLab 后端核心
// 职责:
//   1. 静态服务前端 (public/)
//   2. 提供 /api/tutorials 列表 + 详情
//   3. 通过 WebSocket 把用户代码/命令转发到 Docker 容器内的 exec 会话
//      exec.start({tty:true}) 返回双向流,支持交互式 gdb / REPL

import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { DockerRuntimeProvider } from './runtime/DockerRuntimeProvider.js';
import { RuntimeManager } from './runtime/RuntimeManager.js';
import {
  PackageService,
  validateFileName,
} from './services/PackageService.js';
import { SaveService } from './services/SaveService.js';
import { CommandService } from './services/CommandService.js';
import { TrustStore } from './services/TrustStore.js';
import { createDefaultKernelRegistry } from './services/KernelRegistry.js';
import { KernelSelectionStore } from './services/KernelSelectionStore.js';
import { MlabArchiveService } from './services/MlabArchiveService.js';
import { MlabSaveArchiveService } from './services/MlabSaveArchiveService.js';
import { PackageLibrary } from './services/PackageLibrary.js';
import { SecurityPolicyService } from './services/SecurityPolicyService.js';
import { UPLOAD_LIMIT, withUploadedArchive } from './services/TempArchiveUpload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const EXEC_IMAGE = process.env.EXEC_IMAGE || 'multilab/os:latest';
const CONTAINER_NAME = process.env.CONTAINER_NAME || 'multilab-session';
// tutorials 目录:默认 multilab/tutorials/ (repo 内),可通过 .env 指向外部独立 repo
// .env 中设置为 ../../tutorials (从 server/ 向上两级到 multilab-project/tutorials/)
const TUTORIALS_DIR = process.env.TUTORIALS_DIR
  ? path.resolve(__dirname, process.env.TUTORIALS_DIR)
  : path.join(ROOT, 'tutorials');
const WORKSPACE_DIR = '/home/student/workspace';
const RUNTIME_STATE_DIR = process.env.RUNTIME_STATE_DIR
  ? path.resolve(__dirname, process.env.RUNTIME_STATE_DIR)
  : path.join(ROOT, '.multilab-state');
const PACKAGE_LIBRARY_DIR = process.env.PACKAGE_LIBRARY_DIR
  ? path.resolve(__dirname, process.env.PACKAGE_LIBRARY_DIR)
  : path.join(RUNTIME_STATE_DIR, 'packages');

const dockerRuntimeProvider = new DockerRuntimeProvider({
  image: EXEC_IMAGE,
  containerName: CONTAINER_NAME,
  workspaceDir: WORKSPACE_DIR,
});
const archiveService = new MlabArchiveService();
const packageLibrary = new PackageLibrary({
  libraryDir: PACKAGE_LIBRARY_DIR,
  archiveService,
});
const packageService = new PackageService({
  tutorialsDir: TUTORIALS_DIR,
  packageLibrary,
});
const kernelRegistry = createDefaultKernelRegistry({
  image: EXEC_IMAGE,
  workspaceDir: WORKSPACE_DIR,
});
const kernelSelectionStore = new KernelSelectionStore({ runtimeStateDir: RUNTIME_STATE_DIR });
const runtimeManager = new RuntimeManager({
  providers: { docker: dockerRuntimeProvider },
  kernelRegistry,
  packageService,
  kernelSelectionStore,
});
const saveService = new SaveService({
  runtimeStateDir: RUNTIME_STATE_DIR,
  runtimeManager,
  packageService,
});
const saveArchiveService = new MlabSaveArchiveService({ saveService });
const trustStore = new TrustStore({ runtimeStateDir: RUNTIME_STATE_DIR });
const securityPolicyService = new SecurityPolicyService({
  packageService,
  trustStore,
  kernelRegistry,
  kernelSelectionStore,
});
const commandService = new CommandService({
  packageService,
  runtimeManager,
  securityPolicyService,
  saveService,
});

function getRuntimeSession() {
  return runtimeManager.getSession();
}

// ---------- 1. Express ----------
const app = express();
app.use(express.json());
// 本地 vendor 资源: 把 monaco/xterm/marked/dompurify 装进 server 依赖,
// 通过 /vendor/* 暴露,避免浏览器拉 CDN (jsDelivr) chunk 时卡在「正在加载编辑器...」。
// 路径避开 "@" 段以兼容更多浏览器/代理。
const NODE_MODULES = path.join(__dirname, 'node_modules');
app.use('/vendor/monaco-editor', express.static(path.join(NODE_MODULES, 'monaco-editor')));
app.use('/vendor/xterm', express.static(path.join(NODE_MODULES, '@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(NODE_MODULES, '@xterm/addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(NODE_MODULES, '@xterm/addon-web-links')));
app.use('/vendor/marked', express.static(path.join(NODE_MODULES, 'marked')));
app.use('/vendor/dompurify', express.static(path.join(NODE_MODULES, 'dompurify')));
app.use(express.static(path.join(ROOT, 'public')));

// 教程列表
app.get('/api/tutorials', async (req, res) => {
  try {
    const tutorials = await Promise.all(
      (await packageService.listTutorialSummaries()).map(tutorial => trustStore.annotatePackage(tutorial))
    );
    res.json({ tutorials, expectedDir: TUTORIALS_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trust', async (req, res) => {
  try {
    const packageDigest = req.query.package_digest;
    if (!packageDigest) return res.status(400).json({ error: 'package_digest required' });
    res.json(await trustStore.getPackageTrust(packageDigest));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/trust', async (req, res) => {
  try {
    const { package_digest: packageDigest, trust } = req.body;
    if (!packageDigest || !trust) return res.status(400).json({ error: 'package_digest and trust required' });
    res.json(await trustStore.setPackageTrust(packageDigest, trust));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/kernels', async (req, res) => {
  try {
    res.json({ kernels: kernelRegistry.listKernels() });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Aggregate host-side diagnostics for the diagnostics panel (no Docker logs).
app.get('/api/diagnostics', async (req, res) => {
  try {
    const tutorialId = req.query.tutorial;
    if (!tutorialId) return res.status(400).json({ error: 'tutorial required' });
    const tutorial = await packageService.loadTutorial(tutorialId);
    const trust = await trustStore.getPackageTrust(tutorial.package_digest);
    const preferredKernelId = await kernelSelectionStore.getPreferredKernel(tutorial.package_digest);
    const resolution = kernelRegistry.resolveForPackage(tutorial, { preferredKernelId });
    let runtimePlan = null;
    if (resolution.selected) {
      const provider = runtimeManager.getProviderForKernel(resolution.selected);
      runtimePlan = provider.planKernelSession
        ? provider.planKernelSession(resolution.selected)
        : null;
    }
    let portMap = {};
    let sessionReady = false;
    try {
      const session = runtimeManager.getSession();
      sessionReady = Boolean(session);
      portMap = typeof session.getPortMap === 'function' ? session.getPortMap() : {};
    } catch {
      sessionReady = false;
    }
    const active = runtimeManager.getActiveKernel();
    res.json({
      package: {
        id: tutorial.id,
        version: tutorial.version,
        digest: tutorial.package_digest,
        source_key: tutorial.source_key,
        source_type: tutorial.source_type,
        security: tutorial.security || {},
      },
      trust,
      preferred_kernel_id: preferredKernelId,
      resolution: {
        selected: resolution.selected,
        network_required: resolution.network_required,
        candidates: resolution.candidates,
        requirements: resolution.requirements,
      },
      runtime: {
        provider: resolution.selected?.provider || null,
        network_mode: runtimePlan?.networkMode || null,
        sandbox_preset: runtimePlan?.sandboxPreset || null,
        publish_ports: runtimePlan?.publishPorts || [],
        image: runtimePlan?.image || resolution.selected?.image || null,
        active_kernel_id: active?.id || null,
        active_fingerprint: runtimeManager.activeFingerprint,
        session_ready: sessionReady,
        port_map: portMap,
      },
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/kernels/resolve', async (req, res) => {
  try {
    const tutorialId = req.query.tutorial;
    if (!tutorialId) return res.status(400).json({ error: 'tutorial required' });
    const tutorial = await packageService.loadTutorial(tutorialId);
    const preferredKernelId = await kernelSelectionStore.getPreferredKernel(tutorial.package_digest);
    const resolution = kernelRegistry.resolveForPackage(tutorial, { preferredKernelId });
    let runtime = null;
    if (resolution.selected) {
      const provider = runtimeManager.getProviderForKernel(resolution.selected);
      const plan = provider.planKernelSession
        ? provider.planKernelSession(resolution.selected)
        : null;
      const active = runtimeManager.getActiveKernel();
      runtime = {
        provider: resolution.selected.provider,
        network_mode: plan?.networkMode || null,
        sandbox_preset: plan?.sandboxPreset || null,
        publish_ports: plan?.publishPorts || [],
        image: plan?.image || resolution.selected.image || null,
        active: Boolean(active && active.id === resolution.selected.id),
        active_kernel_id: active?.id || null,
      };
    }
    res.json({ ...resolution, runtime });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/runtime', async (req, res) => {
  try {
    const active = runtimeManager.getActiveKernel();
    let portMap = {};
    let sessionReady = false;
    try {
      const session = runtimeManager.getSession();
      sessionReady = Boolean(session);
      portMap = typeof session.getPortMap === 'function' ? session.getPortMap() : {};
    } catch {
      sessionReady = false;
    }
    res.json({
      providers: runtimeManager.listProviders(),
      active_kernel: active,
      active_fingerprint: runtimeManager.activeFingerprint,
      session_ready: sessionReady,
      port_map: portMap,
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/runtime/select', async (req, res) => {
  try {
    const { tutorial, kernel_id: kernelId } = req.body;
    if (!tutorial || !kernelId) {
      return res.status(400).json({ error: 'tutorial and kernel_id required' });
    }
    const selected = await runtimeManager.selectKernelForTutorial(tutorial, kernelId);
    const provider = runtimeManager.getProviderForKernel(selected.kernel);
    const plan = provider.planKernelSession
      ? provider.planKernelSession(selected.kernel)
      : selected.plan;
    res.json({
      tutorial,
      package_digest: selected.package_digest,
      kernel: selected.kernel,
      replaced: selected.replaced,
      preferred_applied: selected.resolution.preferred_applied,
      runtime: {
        provider: selected.kernel.provider,
        network_mode: plan?.networkMode || null,
        sandbox_preset: plan?.sandboxPreset || null,
        publish_ports: plan?.publishPorts || [],
        image: plan?.image || selected.kernel.image || null,
        active: true,
        active_kernel_id: selected.kernel.id,
      },
      candidates: selected.resolution.candidates,
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message, code: e.code });
  }
});

app.get('/api/packages', async (req, res) => {
  try {
    res.json({ packages: await packageLibrary.listPackages() });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/packages/item', async (req, res) => {
  try {
    const { id, version, digest } = req.query;
    if (!id || !digest) return res.status(400).json({ error: 'id and digest required' });
    res.json(await packageLibrary.getPackage({ id, version, digest }));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.delete('/api/packages/item', async (req, res) => {
  try {
    const id = req.query.id || req.body?.id;
    const version = req.query.version || req.body?.version;
    const digest = req.query.digest || req.body?.digest;
    if (!id || !digest) return res.status(400).json({ error: 'id and digest required' });
    res.json(await packageLibrary.deletePackage({ id, version, digest }));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/packages/import', async (req, res) => {
  try {
    const { path: packagePath } = req.body;
    if (!packagePath) return res.status(400).json({ error: 'path required' });
    res.json(await packageLibrary.importArchive(packagePath));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Browser upload: raw .mlab body. Imports into the library and returns the package record.
app.post(
  '/api/packages/upload',
  express.raw({ type: () => true, limit: UPLOAD_LIMIT }),
  async (req, res) => {
    try {
      const filename = req.get('x-filename') || 'package.mlab';
      const record = await withUploadedArchive(req.body, filename, '.mlab', async (tempPath, safeName) => (
        packageLibrary.importArchive(tempPath, { source: `upload:${safeName}` })
      ));
      res.json(record);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  }
);

app.post('/api/saves/export', async (req, res) => {
  try {
    const { tutorial, path: outputPath } = req.body;
    if (!tutorial) return res.status(400).json({ error: 'tutorial required' });
    if (!outputPath) return res.status(400).json({ error: 'path required; use /api/saves/download for browser download' });
    res.json(await saveArchiveService.exportArchive(tutorial, outputPath));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message, code: e.code, package: e.package });
  }
});

// Browser download: returns .mlab-save bytes for the current tutorial save.
app.post('/api/saves/download', async (req, res) => {
  let temporaryDir = null;
  try {
    const { tutorial } = req.body;
    if (!tutorial) return res.status(400).json({ error: 'tutorial required' });
    const exported = await saveArchiveService.exportArchive(tutorial, null);
    temporaryDir = exported.temporary_dir;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    res.sendFile(exported.path, async err => {
      if (temporaryDir) await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
      if (err && !res.headersSent) {
        res.status(err.statusCode || 500).json({ error: err.message });
      }
    });
  } catch (e) {
    if (temporaryDir) await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    res.status(e.statusCode || 500).json({ error: e.message, code: e.code, package: e.package });
  }
});

app.post('/api/saves/import', async (req, res) => {
  try {
    const { path: archivePath } = req.body;
    if (!archivePath) return res.status(400).json({ error: 'path required' });
    res.json(await saveArchiveService.importArchive(archivePath));
  } catch (e) {
    res.status(e.statusCode || 500).json({
      error: e.message,
      code: e.code || undefined,
      package: e.package || undefined,
    });
  }
});

// Browser upload: raw .mlab-save body.
app.post(
  '/api/saves/upload',
  express.raw({ type: () => true, limit: UPLOAD_LIMIT }),
  async (req, res) => {
    try {
      const filename = req.get('x-filename') || 'progress.mlab-save';
      const result = await withUploadedArchive(req.body, filename, '.mlab-save', async tempPath => (
        saveArchiveService.importArchive(tempPath)
      ));
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({
        error: e.message,
        code: e.code || undefined,
        package: e.package || undefined,
      });
    }
  }
);

function validateContainerPath(filePath) {
  const input = filePath.startsWith('/') ? filePath : path.posix.join(WORKSPACE_DIR, filePath);
  const resolved = path.posix.resolve(input);
  if (resolved !== WORKSPACE_DIR && !resolved.startsWith(WORKSPACE_DIR + '/')) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  }
  return resolved;
}

// 单个教程详情 — 返回组装后的完整内容
app.get('/api/tutorials/:id', async (req, res) => {
  try {
    const tutorial = await packageService.loadTutorial(req.params.id);
    const trust = await trustStore.getPackageTrust(tutorial.package_digest);
    // 只读 progress,不记录 visit,不覆盖 current_step。前端据此 resume。
    const progress = await saveService.getProgress(tutorial);
    res.json({
      ...tutorial,
      trust: trust.trust,
      trust_default: trust.default,
      progress,
    });
  } catch (e) {
    res.status(404).json({ error: `tutorial not found: ${req.params.id}` });
  }
});

// 加载 step 的运行时 save 到 workspace
app.post('/api/steps/load', async (req, res) => {
  try {
    const { tutorial, step } = req.body;
    if (!tutorial || !step) return res.status(400).json({ error: 'tutorial and step required' });
    res.json(await saveService.loadStepState(tutorial, step));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// 保存当前 workspace 为 step 的唯一逻辑 save
app.post('/api/steps/save', async (req, res) => {
  try {
    const { tutorial, step, files } = req.body;
    if (!tutorial || !step) return res.status(400).json({ error: 'tutorial and step required' });
    res.json(await saveService.saveStepState(tutorial, step, files));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Reset current step: template(step) → save(step) → workspace
app.post('/api/steps/reset', async (req, res) => {
  try {
    const { tutorial, step } = req.body;
    if (!tutorial || !step) return res.status(400).json({ error: 'tutorial and step required' });
    res.json(await saveService.resetStepState(tutorial, step));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Execute a captured command declared in multilab.json.
// body: { tutorial, step, command } → { exitCode, passed, output }
app.post('/api/commands/run', async (req, res) => {
  try {
    const { tutorial, step, command } = req.body;
    if (!tutorial || !step || !command) {
      return res.status(400).json({ error: 'tutorial, step and command required' });
    }
    res.json(await commandService.runCapturedCommand({ tutorial, step, command }));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ---------- 2. 容器文件系统 API ----------
// 在容器中执行短命令并返回 stdout (非 TTY,非交互)
async function containerExec(cmdArray, opts = {}) {
  return getRuntimeSession().exec(cmdArray, opts);
}

// 列出工作区文件（默认扁平文件；tree=1 时返回有限深度目录树）
app.get('/api/fs/ls', async (req, res) => {
  try {
    const dir = validateContainerPath(req.query.path || WORKSPACE_DIR);
    const wantTree = req.query.tree === '1' || req.query.tree === 'true';
    if (!wantTree) {
      const r = await containerExec(
        ['find', dir, '-maxdepth', '1', '-mindepth', '1', '-type', 'f', '-printf', '%f\n'],
        { cwd: '/' }
      );
      if (r.exitCode !== 0) return res.status(500).json({ error: r.stderr || 'ls failed' });
      const files = r.stdout.trim().split('\n').filter(Boolean).map(name => {
        validateFileName(name);
        return { name, type: 'file' };
      });
      return res.json({ path: dir, files });
    }

    const maxDepth = Math.min(6, Math.max(1, Number(req.query.depth) || 4));
    const r = await containerExec(
      [
        'find', dir, '-maxdepth', String(maxDepth), '-mindepth', '1',
        '(', '-type', 'f', '-o', '-type', 'd', ')',
        '-printf', '%y\t%P\n',
      ],
      { cwd: '/' }
    );
    if (r.exitCode !== 0) return res.status(500).json({ error: r.stderr || 'ls tree failed' });
    const entries = [];
    for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const kind = line.slice(0, tab);
      const rel = line.slice(tab + 1);
      if (!rel || rel.includes('\0') || rel.split('/').some(part => part === '..')) continue;
      const abs = path.posix.join(dir, rel);
      validateContainerPath(abs);
      entries.push({
        name: path.posix.basename(rel),
        path: abs,
        relative: rel,
        type: kind === 'd' ? 'dir' : 'file',
      });
    }
    // Tree-aware sort: children 紧跟父目录, 同级目录优先于文件, 同类按名字。
    // 逐级比较路径组件;分叉处查该级路径是否为目录(dir 优先);父子关系父在前。
    const dirRels = new Set(entries.filter(e => e.type === 'dir').map(e => e.relative));
    entries.sort((a, b) => {
      const pa = a.relative.split('/');
      const pb = b.relative.split('/');
      const len = Math.min(pa.length, pb.length);
      for (let i = 0; i < len; i++) {
        if (pa[i] !== pb[i]) {
          const aIsDir = dirRels.has(pa.slice(0, i + 1).join('/'));
          const bIsDir = dirRels.has(pb.slice(0, i + 1).join('/'));
          if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
          return pa[i].localeCompare(pb[i]);
        }
      }
      return pa.length - pb.length; // 父(短路径)在前
    });
    res.json({ path: dir, tree: true, depth: maxDepth, entries });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});

// 读取文件
app.post('/api/fs/read', async (req, res) => {
  try {
    const filePath = req.body.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    validateContainerPath(filePath);
    // 用 od+sed 确保二进制安全,或直接用 cat (非 TTY 模式)
    const r = await containerExec(['cat', filePath]);
    if (r.exitCode !== 0) return res.status(500).json({ error: r.stderr || 'read failed' });
    res.json({ path: filePath, content: r.stdout });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});

// 保存文件
app.post('/api/fs/write', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    validateContainerPath(filePath);
    await getRuntimeSession().uploadScript(content, filePath);
    res.json({ path: filePath, saved: true });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});

// ---------- 2.5 Workspace export ----------

// 导出工作区为 tar.gz
app.get('/api/workspace/export', async (req, res) => {
  try {
    const buf = await getRuntimeSession().exportWorkspaceArchive();
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="workspace.tar.gz"');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 3. WebSocket: 转发到 exec 流 ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // 常驻交互式 shell —— 连接建立即启动,贯穿整个会话。
  // 平时它就是一个真 bash (有 PS1 提示符),用户可随时敲 ls/gcc/gdb 等任意命令;
  // 点 ▶ 运行 = 先保存 workspace,再把 manifest command script 注入 shell stdin,
  // shell 自己回显命令、执行、回到提示符。Ctrl+C = 往 stdin 发 \x03。
  let terminal = null;
  let fsWatcher = null;

  ws.send(JSON.stringify({ type: 'status', message: 'connected' }));

  (async () => {
    try {
      terminal = await getRuntimeSession().attachTerminal({
        onOutput(data) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data }));
          }
        },
        onExit() {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'status', message: 'shell exited' }));
          }
          terminal = null;
        },
      });

      // Host-side filesystem watcher: polls `find` in the kernel (~1s) and
      // pushes a 'fs_change' notification over this same /ws when the set of
      // file/dir paths changes. docker/WSL/SSH all work with zero extra deps
      // (find ships with coreutils). Lifecycle is bound to this connection.
      fsWatcher = getRuntimeSession().watchFilesystem(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'fs_change' }));
        }
      });

      ws.send(JSON.stringify({ type: 'ready' }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  })();

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ① 交互式 command: 读取 manifest command script,写入容器 /tmp,再注入常驻 shell 执行。
    if (msg.type === 'command') {
      try {
        if (!terminal) {
          ws.send(JSON.stringify({ type: 'error', message: 'shell 尚未就绪,请稍候' }));
          return;
        }
        const { tutorial, step, command } = msg;
        if (!tutorial || !step || !command) {
          ws.send(JSON.stringify({ type: 'error', message: 'tutorial, step and command required' }));
          return;
        }
        await commandService.runInteractiveCommand({ tutorial, step, command, terminal });
        ws.send(JSON.stringify({ type: 'status', message: `running command: ${command}` }));
      } catch (e) {
        ws.send(JSON.stringify({
          type: 'error',
          message: e.message,
          code: e.code || undefined,
        }));
      }
      return;
    }

    // ② 终端输入: 直接走 shell stdin (支持 gdb 交互、任意 REPL)
    if (msg.type === 'input') {
      if (terminal && msg.data) {
        terminal.write(msg.data);
      }
      return;
    }

    // ③ 终端尺寸变化
    if (msg.type === 'resize') {
      if (terminal && msg.cols && msg.rows) {
        try {
          await getRuntimeSession().resize(terminal, msg.cols, msg.rows);
        } catch {}
      }
      return;
    }

    // ④ Ctrl+C / 中断 —— 往 shell stdin 发 \x03,不杀常驻 shell
    if (msg.type === 'interrupt') {
      if (terminal) {
        await getRuntimeSession().interrupt(terminal);
        ws.send(JSON.stringify({ type: 'status', message: 'interrupted' }));
      }
      return;
    }
  });

  ws.on('close', () => {
    if (terminal) {
      terminal.close();
    }
    if (fsWatcher) {
      fsWatcher.stop();
      fsWatcher = null;
    }
  });
});

// ---------- 4. 启动 ----------
runtimeManager.ensureDefaultSession()
  .then(ensured => {
    server.listen(PORT, () => {
      const kernel = ensured.kernel;
      console.log(`\n  MultiLab running at  http://localhost:${PORT}\n`);
      console.log(`  Kernel: ${kernel.id} (${kernel.provider})`);
      console.log(`  Container: ${CONTAINER_NAME} (${kernel.image || EXEC_IMAGE})`);
      console.log(`  Network: ${ensured.plan?.networkMode || 'n/a'}  Sandbox: ${ensured.plan?.sandboxPreset || 'n/a'}`);
      console.log(`  Stop with Ctrl+C — container 会保留,策略变化时按 kernel 重建\n`);
    });
  })
  .catch(e => {
    console.error('\n❌ 启动失败:\n');
    console.error(e.message);
    console.error('\n请先构建执行镜像:');
    console.error(`  docker build -t ${EXEC_IMAGE} -f docker/os.Dockerfile docker/\n`);
    process.exit(1);
  });
