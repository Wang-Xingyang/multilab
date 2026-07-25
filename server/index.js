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
import { fileURLToPath } from 'url';
import { DockerRuntimeProvider } from './runtime/DockerRuntimeProvider.js';
import {
  PackageService,
  validateFileName,
} from './services/PackageService.js';
import { SaveService } from './services/SaveService.js';
import { CommandService } from './services/CommandService.js';
import { TrustStore } from './services/TrustStore.js';
import { createDefaultKernelRegistry } from './services/KernelRegistry.js';
import { MlabArchiveService } from './services/MlabArchiveService.js';
import { PackageLibrary } from './services/PackageLibrary.js';
import { SecurityPolicyService } from './services/SecurityPolicyService.js';

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

const runtimeProvider = new DockerRuntimeProvider({
  image: EXEC_IMAGE,
  containerName: CONTAINER_NAME,
  workspaceDir: WORKSPACE_DIR,
});
const runtimeSession = runtimeProvider.session;
const archiveService = new MlabArchiveService();
const packageLibrary = new PackageLibrary({
  libraryDir: PACKAGE_LIBRARY_DIR,
  archiveService,
});
const packageService = new PackageService({
  tutorialsDir: TUTORIALS_DIR,
  packageLibrary,
});
const saveService = new SaveService({
  runtimeStateDir: RUNTIME_STATE_DIR,
  runtimeSession,
  packageService,
});
const trustStore = new TrustStore({ runtimeStateDir: RUNTIME_STATE_DIR });
const kernelRegistry = createDefaultKernelRegistry({
  image: EXEC_IMAGE,
  workspaceDir: WORKSPACE_DIR,
});
const securityPolicyService = new SecurityPolicyService({
  packageService,
  trustStore,
  kernelRegistry,
});
const commandService = new CommandService({
  packageService,
  runtimeSession,
  securityPolicyService,
  saveService,
});

// ---------- 1. Express ----------
const app = express();
app.use(express.json());
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

app.get('/api/kernels/resolve', async (req, res) => {
  try {
    const tutorialId = req.query.tutorial;
    if (!tutorialId) return res.status(400).json({ error: 'tutorial required' });
    const tutorial = await packageService.loadTutorial(tutorialId);
    res.json(kernelRegistry.resolveForPackage(tutorial));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/packages', async (req, res) => {
  try {
    res.json({ packages: await packageLibrary.listPackages() });
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
    res.json({
      ...tutorial,
      trust: trust.trust,
      trust_default: trust.default,
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
  return runtimeSession.exec(cmdArray, opts);
}

// 列出工作区文件
app.get('/api/fs/ls', async (req, res) => {
  try {
    const dir = validateContainerPath(req.query.path || WORKSPACE_DIR);
    const r = await containerExec(['find', dir, '-maxdepth', '1', '-mindepth', '1', '-type', 'f', '-printf', '%f\n'], { cwd: '/' });
    if (r.exitCode !== 0) return res.status(500).json({ error: r.stderr || 'ls failed' });
    const files = r.stdout.trim().split('\n').filter(Boolean).map(name => {
      validateFileName(name);
      return { name, type: 'file' };
    });
    res.json({ path: dir, files });
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
    await runtimeSession.uploadScript(content, filePath);
    res.json({ path: filePath, saved: true });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});

// ---------- 2.5 Workspace export ----------

// 导出工作区为 tar.gz
app.get('/api/workspace/export', async (req, res) => {
  try {
    const buf = await runtimeSession.exportWorkspaceArchive();
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

  ws.send(JSON.stringify({ type: 'status', message: 'connected' }));

  (async () => {
    try {
      terminal = await runtimeSession.attachTerminal({
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
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
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
          await runtimeSession.resize(terminal, msg.cols, msg.rows);
        } catch {}
      }
      return;
    }

    // ④ Ctrl+C / 中断 —— 往 shell stdin 发 \x03,不杀常驻 shell
    if (msg.type === 'interrupt') {
      if (terminal) {
        await runtimeSession.interrupt(terminal);
        ws.send(JSON.stringify({ type: 'status', message: 'interrupted' }));
      }
      return;
    }
  });

  ws.on('close', () => {
    if (terminal) {
      terminal.close();
    }
  });
});

// ---------- 4. 启动 ----------
runtimeProvider.startSession()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`\n  MultiLab running at  http://localhost:${PORT}\n`);
      console.log(`  Container: ${CONTAINER_NAME} (${EXEC_IMAGE})`);
      console.log(`  Stop with Ctrl+C — container 会保留,下次启动复用\n`);
    });
  })
  .catch(e => {
    console.error('\n❌ 启动失败:\n');
    console.error(e.message);
    console.error('\n请先构建执行镜像:');
    console.error(`  docker build -t ${EXEC_IMAGE} -f docker/os.Dockerfile docker/\n`);
    process.exit(1);
  });
