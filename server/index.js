// MultiLab 后端核心
// 职责:
//   1. 静态服务前端 (public/)
//   2. 提供 /api/tutorials 列表 + 详情
//   3. 通过 WebSocket 把用户代码/命令转发到 Docker 容器内的 exec 会话
//      exec.start({tty:true}) 返回双向流,支持交互式 gdb / REPL

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import Docker from 'dockerode';
import { PassThrough } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const EXEC_IMAGE = process.env.EXEC_IMAGE || 'multilab/os:latest';
const CONTAINER_NAME = process.env.CONTAINER_NAME || 'multilab-session';

const docker = new Docker();

// ---------- 1. Express ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// 教程列表
app.get('/api/tutorials', async (req, res) => {
  try {
    const dir = path.join(ROOT, 'tutorials');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const tutorials = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jsonPath = path.join(dir, entry.name, 'tutorial.json');
      try {
        const raw = await fs.readFile(jsonPath, 'utf8');
        const cfg = JSON.parse(raw);
        tutorials.push({
          id: entry.name,
          title: cfg.title,
          description: cfg.description,
          language: cfg.language,
          steps: (cfg.steps || []).length,
        });
      } catch (e) {
        // 跳过格式错误的教程
      }
    }
    res.json({ tutorials });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 单个教程详情
app.get('/api/tutorials/:id', async (req, res) => {
  try {
    const jsonPath = path.join(ROOT, 'tutorials', req.params.id, 'tutorial.json');
    const raw = await fs.readFile(jsonPath, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(404).json({ error: `tutorial not found: ${req.params.id}` });
  }
});

// ---------- 2. 容器文件系统 API ----------
// 在容器中执行短命令并返回 stdout (非 TTY,非交互)
async function containerExec(cmdArray, opts = {}) {
  const container = await ensureSessionContainer();
  const exec = await container.exec({
    Cmd: cmdArray,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: opts.user || 'student',
    WorkingDir: opts.cwd || '/home/student/workspace',
    Env: ['LANG=C.UTF-8'],
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const stdoutPipe = new PassThrough();
    const stderrPipe = new PassThrough();
    container.modem.demuxStream(stream, stdoutPipe, stderrPipe);
    stdoutPipe.on('data', d => stdout += d.toString('utf8'));
    stderrPipe.on('data', d => stderr += d.toString('utf8'));
    stream.on('end', async () => {
      try {
        const info = await exec.inspect();
        resolve({ stdout, stderr, exitCode: info.ExitCode });
      } catch { resolve({ stdout, stderr, exitCode: -1 }); }
    });
    stream.on('error', reject);
  });
}

// 列出工作区文件
app.get('/api/fs/ls', async (req, res) => {
  try {
    const dir = req.query.path || '/home/student/workspace';
    const r = await containerExec(['ls', '-1A', '--group-directories-first', dir]);
    if (r.exitCode !== 0) return res.status(500).json({ error: r.stderr || 'ls failed' });
    const files = r.stdout.trim().split('\n').filter(Boolean).map(name => {
      // 简单判断: 以 / 结尾的是目录 (ls -1A 没有 -F 所以不做这个判断)
      // 用 stat 判断太贵了,先简单返回所有条目
      return { name, type: 'file' };
    });
    res.json({ path: dir, files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 读取文件
app.post('/api/fs/read', async (req, res) => {
  try {
    const filePath = req.body.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    // 用 od+sed 确保二进制安全,或直接用 cat (非 TTY 模式)
    const r = await containerExec(['cat', filePath]);
    if (r.exitCode !== 0) return res.status(500).json({ error: r.stderr || 'read failed' });
    res.json({ path: filePath, content: r.stdout });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 保存文件
app.post('/api/fs/write', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const container = await ensureSessionContainer();
    const writeExec = await container.exec({
      Cmd: ['tee', filePath],
      AttachStdin: true,
      AttachStdout: false,
      AttachStderr: true,
      Tty: false,
    });
    const writeStream = await writeExec.start({ hijack: true, stdin: true });
    writeStream.write(content);
    writeStream.end();
    // 短暂等待写入完成
    await new Promise(r => setTimeout(r, 80));
    res.json({ path: filePath, saved: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 3. Docker 容器管理 ----------
// 启动时确保有一个长期运行的会话容器
async function ensureSessionContainer() {
  // 检查镜像是否已构建
  const images = await docker.listImages();
  const exists = images.some(img =>
    (img.RepoTags || []).includes(EXEC_IMAGE)
  );
  if (!exists) {
    throw new Error(
      `执行镜像 ${EXEC_IMAGE} 未构建。请先运行:\n` +
      `  docker build -t ${EXEC_IMAGE} -f docker/os.Dockerfile docker/`
    );
  }

  // 检查容器是否已存在
  const containers = await docker.listContainers({ all: true });
  const existing = containers.find(c => c.Names.includes('/' + CONTAINER_NAME));

  if (existing) {
    if (existing.State !== 'running') {
      console.log(`[docker] 启动已存在的容器 ${CONTAINER_NAME}`);
      await docker.getContainer(existing.Id).start();
    } else {
      console.log(`[docker] 容器 ${CONTAINER_NAME} 已在运行`);
    }
    return docker.getContainer(existing.Id);
  }

  console.log(`[docker] 创建并启动新容器 ${CONTAINER_NAME}`);
  const container = await docker.createContainer({
    name: CONTAINER_NAME,
    Hostname: 'tutorial',
    Image: EXEC_IMAGE,
    Cmd: ['sleep', 'infinity'],
    Tty: true,
    OpenStdin: true,
    HostConfig: {
      // 不挂载宿主目录 — 代码通过 exec 写入容器
      AutoRemove: false,
    },
  });
  await container.start();
  return container;
}

// ---------- 3. WebSocket: 转发到 exec 流 ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // 常驻交互式 shell —— 连接建立即启动,贯穿整个会话。
  // 平时它就是一个真 bash (有 PS1 提示符),用户可随时敲 ls/gcc/gdb 等任意命令;
  // 点 ▶ 运行 = 先 tee 写文件,再把 run_cmd 作为一条命令注入 shell stdin,
  // shell 自己回显命令、执行、回到提示符。Ctrl+C = 往 stdin 发 \x03。
  let shellStream = null;
  let shellExec = null;

  ws.send(JSON.stringify({ type: 'status', message: 'connected' }));

  (async () => {
    try {
      const container = await ensureSessionContainer();
      shellExec = await container.exec({
        Cmd: ['bash', '--login', '-i'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        User: 'student',
        WorkingDir: '/home/student/workspace',
        Env: [
          // 彩色 PS1: 绿色 user@host : 蓝色 路径 $
          'PS1=\\[\\e[01;32m\\]\\u@\\h\\[\\e[00m\\]:\\[\\e[01;34m\\]\\w\\[\\e[00m\\]$ ',
          'TERM=xterm-256color',
          'LANG=C.UTF-8',
          'LC_ALL=C.UTF-8',
        ],
      });
      shellStream = await shellExec.start({ hijack: true, stdin: true });

      // ===== 关键修复: 使用 dockerode 内置 demuxStream 解复用 =====
      //
      // Docker exec hijack mode 返回的是 multiplexed 流,每个帧格式为:
      //   [streamType: 1B][padding: 3B][dataLength: 4B BE][payload]
      //   streamType: 0=stdin, 1=stdout, 2=stderr
      //
      // dockerodemodem 提供的 container.modem.demuxStream() 会正确解析
      // 这个 8 字节帧头,将干净的 stdout/stderr 数据分发到对应的 PassThrough 流。
      // 这是处理 Docker hijack 流的官方规范方式 —— 不应手动 hack 剥离字节。
      const stdoutPipe = new PassThrough();
      const stderrPipe = new PassThrough();

      container.modem.demuxStream(shellStream, stdoutPipe, stderrPipe);

      stdoutPipe.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf8') }));
        }
      });

      stderrPipe.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf8') }));
        }
      });

      shellStream.on('end', () => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'status', message: 'shell exited' }));
        }
        shellStream = null;
        shellExec = null;
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

    // ① 运行代码: 写文件 + 往常驻 shell 注入命令
    if (msg.type === 'run') {
      try {
        if (!shellStream) {
          ws.send(JSON.stringify({ type: 'error', message: 'shell 尚未就绪,请稍候' }));
          return;
        }
        const container = await ensureSessionContainer();

        // 把 Monaco 里的代码写入容器 (独立的一次性 tee exec,非 TTY)
        const filePath = msg.filePath || '/home/student/workspace/main.c';
        const writeExec = await container.exec({
          Cmd: ['tee', filePath],
          AttachStdin: true,
          AttachStdout: false,
          AttachStderr: false,
          Tty: false,
        });
        const writeStream = await writeExec.start({ hijack: true, stdin: true });
        writeStream.write(msg.code);
        writeStream.end();
        await new Promise(r => setTimeout(r, 100));

        // 往常驻 shell 注入命令 —— shell 会自己回显命令 + 执行 + 回到 PS1
        const cmd = msg.cmd || `gcc ${filePath} -o /tmp/a.out && /tmp/a.out`;
        shellStream.write(cmd + '\n');
        ws.send(JSON.stringify({ type: 'status', message: `running: ${cmd}` }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
      return;
    }

    // ② 终端输入: 直接走 shell stdin (支持 gdb 交互、任意 REPL)
    if (msg.type === 'input') {
      if (shellStream && msg.data) {
        shellStream.write(msg.data);
      }
      return;
    }

    // ③ 终端尺寸变化
    if (msg.type === 'resize') {
      if (shellExec && msg.cols && msg.rows) {
        try {
          await shellExec.resize({ h: msg.rows, w: msg.cols });
        } catch {}
      }
      return;
    }

    // ④ Ctrl+C / 中断 —— 往 shell stdin 发 \x03,不杀常驻 shell
    if (msg.type === 'interrupt') {
      if (shellStream) {
        shellStream.write('\x03');
        ws.send(JSON.stringify({ type: 'status', message: 'interrupted' }));
      }
      return;
    }
  });

  ws.on('close', () => {
    if (shellStream) {
      shellStream.destroy();
    }
  });
});

// ---------- 4. 启动 ----------
ensureSessionContainer()
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
