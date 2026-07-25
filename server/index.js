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
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { DockerRuntimeProvider } from './runtime/DockerRuntimeProvider.js';

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

const runtimeProvider = new DockerRuntimeProvider({
  image: EXEC_IMAGE,
  containerName: CONTAINER_NAME,
  workspaceDir: WORKSPACE_DIR,
});
const runtimeSession = runtimeProvider.session;

// ---------- 1. Express ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// 教程列表
app.get('/api/tutorials', async (req, res) => {
  try {
    const dir = TUTORIALS_DIR;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const tutorials = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const { cfg, packageFormat, sourceFile, packageDigest } = await loadTutorialConfig(entry.name);
        tutorials.push({
          id: entry.name,
          title: cfg.title,
          description: cfg.description,
          language: cfg.language,
          version: cfg.version || '0.0.0',
          package_digest: packageDigest,
          schema_version: cfg.schema_version || 0,
          package_format: packageFormat,
          source_file: sourceFile,
          steps: (cfg.steps || []).length,
        });
      } catch (e) {
        // 跳过格式错误的教程
      }
    }
    res.json({ tutorials, expectedDir: TUTORIALS_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 1.5 MultiLab package loading ----------
// multilab.json is the package manifest. Instructions, starter files, and
// command scripts live as real files under each step directory.

const LANG_BY_EXT = {
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
  '.sh': 'bash', '.rs': 'rust', '.go': 'go', '.java': 'java',
};

const MANIFEST_FILE = 'multilab.json';
const VALID_INHERIT_MODES = new Set(['template', 'previous_save', 'overlay_template']);

// ---- input validation helpers ----
function validateId(id) {
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(id)) {
    throw Object.assign(new Error('Invalid identifier'), { statusCode: 400 });
  }
}

function validateSafePath(id) {
  validateId(id);
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw Object.assign(new Error('Invalid path'), { statusCode: 400 });
  }
  return id;
}

function validateContainerPath(filePath) {
  const input = filePath.startsWith('/') ? filePath : path.posix.join(WORKSPACE_DIR, filePath);
  const resolved = path.posix.resolve(input);
  if (resolved !== WORKSPACE_DIR && !resolved.startsWith(WORKSPACE_DIR + '/')) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  }
  return resolved;
}

function validateFileName(name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw Object.assign(new Error('Invalid file name'), { statusCode: 400 });
  }
  return name;
}

function validatePackageRelativePath(relPath) {
  if (!relPath || path.isAbsolute(relPath)) {
    throw Object.assign(new Error('Invalid package path'), { statusCode: 400 });
  }
  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    throw Object.assign(new Error('Invalid package path'), { statusCode: 400 });
  }
  return normalized;
}

function resolvePackagePath(tutorialDir, relPath) {
  const safeRel = validatePackageRelativePath(relPath);
  const resolved = path.resolve(tutorialDir, safeRel);
  if (resolved !== tutorialDir && !resolved.startsWith(tutorialDir + path.sep)) {
    throw Object.assign(new Error('Package path escapes tutorial directory'), { statusCode: 403 });
  }
  return resolved;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function listPackageFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listPackageFiles(rootDir, absPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, absPath).split(path.sep).join('/'));
    }
  }
  return files;
}

async function computePackageDigest(tutorialDir) {
  const hash = crypto.createHash('sha256');
  const files = await listPackageFiles(tutorialDir);
  for (const relPath of files) {
    const content = await fs.readFile(path.join(tutorialDir, relPath));
    hash.update('file\0');
    hash.update(relPath);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function digestPathSegment(digest) {
  const segment = String(digest || '').replace(/^sha256:/, 'sha256-');
  if (!/^[a-zA-Z0-9_.-]+$/.test(segment)) {
    throw Object.assign(new Error('Invalid package digest'), { statusCode: 400 });
  }
  return segment;
}

function validateStorageSegment(value, fieldName) {
  const segment = String(value || '');
  if (!segment || segment.includes('..') || !/^[a-zA-Z0-9_.+-]+$/.test(segment)) {
    throw Object.assign(new Error(`Invalid ${fieldName}`), { statusCode: 400 });
  }
  return segment;
}

async function loadTutorialConfig(tutorialId) {
  validateSafePath(tutorialId);
  const tutorialDir = path.join(TUTORIALS_DIR, tutorialId);
  const manifestPath = path.join(tutorialDir, MANIFEST_FILE);
  const cfg = await readJsonFile(manifestPath);
  cfg.id = cfg.id || tutorialId;
  const packageDigest = await computePackageDigest(tutorialDir);
  return { cfg, tutorialDir, packageFormat: 'multilab', sourceFile: MANIFEST_FILE, packageDigest };
}

function stepInheritMode(step) {
  const explicit = step.inherit_mode;
  if (explicit && VALID_INHERIT_MODES.has(explicit)) return explicit;
  return step.chain ? 'previous_save' : 'template';
}

function commandForType(step, type) {
  return (step.commands || []).find(cmd => cmd && (cmd.type === type || cmd.id === type));
}

function commandScriptPath(tutorialDir, step, type) {
  const command = commandForType(step, type);
  if (!command?.script) return null;
  return resolvePackagePath(tutorialDir, command.script);
}

async function getStepCommandScript(tutorialId, stepId, commandIdOrType) {
  const { cfg, tutorialDir } = await loadTutorialConfig(tutorialId);
  const step = findStep(cfg, stepId);
  const command = commandForType(step, commandIdOrType);
  if (!command) {
    throw Object.assign(new Error(`command not found: ${commandIdOrType}`), { statusCode: 404 });
  }
  const scriptPath = commandScriptPath(tutorialDir, step, commandIdOrType);
  if (!scriptPath || !(await pathExists(scriptPath))) {
    throw Object.assign(new Error(`command script not found: ${commandIdOrType}`), { statusCode: 404 });
  }
  return {
    cfg,
    step,
    command,
    script: await fs.readFile(scriptPath, 'utf8'),
  };
}

async function ensureRuntimeDirs() {
  await fs.mkdir(path.join(RUNTIME_STATE_DIR, 'saves'), { recursive: true });
  await ensureWorkspaceDir();
}

async function ensureWorkspaceDir() {
  await runtimeSession.ensureWorkspace();
}

function packageSaveRoot(cfg) {
  const packageId = validateSafePath(cfg.id);
  const version = validateStorageSegment(cfg.version || '0.0.0', 'package version');
  const digest = digestPathSegment(cfg.package_digest);
  return path.join(RUNTIME_STATE_DIR, 'saves', packageId, version, digest);
}

function saveDir(cfg, stepId) {
  return path.join(packageSaveRoot(cfg), 'steps', validateSafePath(stepId), 'files');
}

function stepChain(step) {
  return step.chain || step.id;
}

function findStep(cfg, stepId) {
  const step = (cfg.steps || []).find(s => s.id === stepId);
  if (!step) throw Object.assign(new Error(`step not found: ${stepId}`), { statusCode: 404 });
  return step;
}

function findChainFirstStep(cfg, chain) {
  return (cfg.steps || []).find(s => stepChain(s) === chain);
}

async function dirExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function clearHostDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function writeStepTemplateToDir(step, destDir) {
  await clearHostDir(destDir);
  for (const f of step.files || []) {
    const name = validateFileName(f.name || 'untitled');
    await fs.writeFile(path.join(destDir, name), f.content || '', 'utf8');
  }
}

async function readHostFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    validateFileName(name);
    const ext = path.extname(name).toLowerCase();
    files.push({
      name,
      content: await fs.readFile(path.join(dir, name), 'utf8'),
      language: LANG_BY_EXT[ext] || 'plaintext',
    });
  }
  return files;
}

async function loadWorkspaceFiles() {
  const files = await runtimeSession.readFiles();
  return files.map(file => {
    const name = validateFileName(file.name);
    const ext = path.extname(name).toLowerCase();
    return {
      name,
      content: file.content,
      language: LANG_BY_EXT[ext] || 'plaintext',
    };
  });
}

async function writeHostFiles(dir, files) {
  await clearHostDir(dir);
  for (const f of files || []) {
    const name = validateFileName(f.name || 'untitled');
    await fs.writeFile(path.join(dir, name), f.content || '', 'utf8');
  }
}

async function writeFilesToWorkspace(files, opts = {}) {
  const normalizedFiles = (files || []).map(f => {
    const name = validateFileName(f.name || 'untitled');
    return { name, content: f.content || '' };
  });
  await runtimeSession.writeFiles(normalizedFiles, opts);
}

async function loadStepState(tutorialId, stepId) {
  validateSafePath(tutorialId);
  validateSafePath(stepId);
  await ensureRuntimeDirs();
  const cfg = await loadTutorial(tutorialId);
  const step = findStep(cfg, stepId);
  const ownSaveDir = saveDir(cfg, step.id);
  const mode = stepInheritMode(step);
  let sourceStep = step.id;
  let hasOwnSave = await dirExists(ownSaveDir);
  let files;

  if (hasOwnSave) {
    files = await readHostFiles(ownSaveDir);
  } else if (mode === 'template') {
    await writeStepTemplateToDir(step, ownSaveDir);
    files = await readHostFiles(ownSaveDir);
    hasOwnSave = true;
  } else {
    const chain = stepChain(step);
    const steps = cfg.steps || [];
    const idx = steps.findIndex(s => s.id === step.id);
    let sourceDir = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (stepChain(steps[i]) !== chain) continue;
      const prevSaveDir = saveDir(cfg, steps[i].id);
      if (await dirExists(prevSaveDir)) {
        sourceDir = prevSaveDir;
        sourceStep = steps[i].id;
        break;
      }
    }
    if (!sourceDir) {
      const first = findChainFirstStep(cfg, chain) || step;
      sourceDir = saveDir(cfg, first.id);
      sourceStep = first.id;
      if (!(await dirExists(sourceDir))) {
        await writeStepTemplateToDir(first, sourceDir);
      }
      hasOwnSave = first.id === step.id;
    }

    files = await readHostFiles(sourceDir);

    if (mode === 'overlay_template') {
      const byName = new Map(files.map(f => [f.name, f]));
      for (const templateFile of step.files || []) {
        // Conservative first implementation: only add missing template files.
        // Explicit overwrite semantics can be added later without risking learner edits.
        if (!byName.has(templateFile.name)) byName.set(templateFile.name, templateFile);
      }
      files = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  await writeFilesToWorkspace(files);
  return {
    tutorial: tutorialId,
    step: step.id,
    sourceStep,
    hasOwnSave,
    inheritMode: mode,
    files,
  };
}

async function saveStepState(tutorialId, stepId, files) {
  validateSafePath(tutorialId);
  validateSafePath(stepId);
  await ensureRuntimeDirs();
  const cfg = await loadTutorial(tutorialId);
  const step = findStep(cfg, stepId);
  const dest = saveDir(cfg, step.id);
  const providedFiles = Array.isArray(files) ? files : null;
  const normalizedFiles = (providedFiles || []).map(f => ({
    name: validateFileName(f.name || 'untitled'),
    content: f.content || '',
  }));
  if (providedFiles) await writeFilesToWorkspace(normalizedFiles, { clear: false });
  const workspaceFiles = await loadWorkspaceFiles();
  await writeHostFiles(dest, workspaceFiles);
  return { tutorial: tutorialId, step: step.id, hasOwnSave: true };
}

async function resetStepState(tutorialId, stepId) {
  validateSafePath(tutorialId);
  validateSafePath(stepId);
  await ensureRuntimeDirs();
  const cfg = await loadTutorial(tutorialId);
  const step = findStep(cfg, stepId);
  const dest = saveDir(cfg, step.id);
  await writeStepTemplateToDir(step, dest);
  const files = await readHostFiles(dest);
  await writeFilesToWorkspace(files);
  return {
    tutorial: tutorialId,
    step: step.id,
    hasOwnSave: true,
    files,
  };
}

async function loadTutorial(tutorialId) {
  const { cfg, tutorialDir, packageFormat, sourceFile, packageDigest } = await loadTutorialConfig(tutorialId);
  cfg.package_format = packageFormat;
  cfg.source_file = sourceFile;
  cfg.package_digest = packageDigest;
  cfg.schema_version = cfg.schema_version || 0;
  cfg.version = cfg.version || '0.0.0';

  // 逐 step 组装文件化内容
  for (const step of cfg.steps || []) {
    validateSafePath(step.id);
    const stepDir = path.join(tutorialDir, 'steps', step.id);
    step.inherit_mode = stepInheritMode(step);

    // 1) instructions.md → step.instructions
    try {
      step.instructions = await fs.readFile(path.join(stepDir, 'instructions.md'), 'utf8');
    } catch {
      step.instructions = '';  // 没有说明文件就空着
    }

    // 2) files/ 下所有文件 → step.files [{name, content, language}]
    step.files = [];
    const filesDir = path.join(stepDir, 'files');
    try {
      const entries = await fs.readdir(filesDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        validateFileName(e.name);
        const content = await fs.readFile(path.join(filesDir, e.name), 'utf8');
        const ext = path.extname(e.name).toLowerCase();
        step.files.push({
          name: e.name,
          content,
          language: LANG_BY_EXT[ext] || cfg.language || 'plaintext',
        });
      }
    } catch {
      // files/ 目录不存在或空,step.files 保持原样 (可为空数组)
    }

    // 3) commands are first-class manifest objects. Do not inline script content
    //    into the API response; execution endpoints read scripts from disk.
    step.commands = await Promise.all((step.commands || []).map(async command => {
      const scriptPath = command?.script ? resolvePackagePath(tutorialDir, command.script) : null;
      return {
        id: command.id,
        type: command.type,
        label: command.label || command.id || command.type,
        terminal: command.terminal || (command.type === 'run' ? 'interactive' : 'captured'),
        timeout_sec: command.timeout_sec,
        available: Boolean(scriptPath && await pathExists(scriptPath)),
      };
    }));
  }
  return cfg;
}

// 单个教程详情 — 返回组装后的完整内容
app.get('/api/tutorials/:id', async (req, res) => {
  try {
    res.json(await loadTutorial(req.params.id));
  } catch (e) {
    res.status(404).json({ error: `tutorial not found: ${req.params.id}` });
  }
});

// 加载 step 的运行时 save 到 workspace
app.post('/api/steps/load', async (req, res) => {
  try {
    const { tutorial, step } = req.body;
    if (!tutorial || !step) return res.status(400).json({ error: 'tutorial and step required' });
    res.json(await loadStepState(tutorial, step));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// 保存当前 workspace 为 step 的唯一逻辑 save
app.post('/api/steps/save', async (req, res) => {
  try {
    const { tutorial, step, files } = req.body;
    if (!tutorial || !step) return res.status(400).json({ error: 'tutorial and step required' });
    res.json(await saveStepState(tutorial, step, files));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Reset current step: template(step) → save(step) → workspace
app.post('/api/steps/reset', async (req, res) => {
  try {
    const { tutorial, step } = req.body;
    if (!tutorial || !step) return res.status(400).json({ error: 'tutorial and step required' });
    res.json(await resetStepState(tutorial, step));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

async function writeScriptToContainer(script, remotePath) {
  await runtimeSession.uploadScript(script, remotePath);
}

function remoteCommandPath(stepId, commandId) {
  return `/tmp/${validateSafePath(stepId)}.${validateSafePath(commandId)}.sh`;
}

// Execute a captured command declared in multilab.json.
// body: { tutorial, step, command } → { exitCode, passed, output }
app.post('/api/commands/run', async (req, res) => {
  try {
    const { tutorial, step, command } = req.body;
    if (!tutorial || !step || !command) {
      return res.status(400).json({ error: 'tutorial, step and command required' });
    }
    validateSafePath(tutorial);
    validateSafePath(step);
    validateSafePath(command);

    const commandSpec = await getStepCommandScript(tutorial, step, command);
    if (commandSpec.command.terminal === 'interactive') {
      return res.status(400).json({ error: 'interactive command must run through WebSocket terminal' });
    }

    const remoteScript = remoteCommandPath(step, command);
    await writeScriptToContainer(commandSpec.script, remoteScript);
    const r = await runtimeSession.runCaptured(remoteScript);
    res.json({
      command,
      exitCode: r.exitCode,
      passed: r.exitCode === 0,
      output: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim(),
    });
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
        const commandSpec = await getStepCommandScript(tutorial, step, command);
        if (commandSpec.command.terminal === 'captured') {
          ws.send(JSON.stringify({ type: 'error', message: 'captured command must run through /api/commands/run' }));
          return;
        }

        const remoteScript = remoteCommandPath(step, command);
        await writeScriptToContainer(commandSpec.script, remoteScript);
        terminal.runScript(remoteScript);
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
