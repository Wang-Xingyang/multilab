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

// ---------- 2. Docker 容器管理 ----------
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
  let execStream = null;
  let currentExec = null;

  ws.send(JSON.stringify({ type: 'status', message: 'connected' }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ① 运行代码: 写文件 + exec
    if (msg.type === 'run') {
      try {
        const container = await ensureSessionContainer();

        // 把 Monaco 里的代码写入容器 /home/student/workspace/main.<ext>
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

        // 等写入完成 (简单起见用 setTimeout)
        await new Promise(r => setTimeout(r, 100));

        // 启动真正的执行 exec,真 TTY 模式
        const cmd = msg.cmd || `gcc ${filePath} -o /tmp/a.out && /tmp/a.out`;
        currentExec = await container.exec({
          Cmd: ['bash', '-c', cmd],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          User: 'student',
        });
        execStream = await currentExec.start({ hijack: true, stdin: true });

        // exec 输出 → ws
        execStream.on('data', (chunk) => {
          ws.send(JSON.stringify({ type: 'output', data: chunk.toString() }));
        });
        execStream.on('end', async () => {
          try {
            const info = await currentExec.inspect();
            ws.send(JSON.stringify({
              type: 'exit',
              code: info.ExitCode,
            }));
          } catch {}
          execStream = null;
          currentExec = null;
        });

        ws.send(JSON.stringify({
          type: 'status',
          message: `running: ${cmd}`,
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
      return;
    }

    // ② 终端输入: 直接走 stdin (支持 gdb 交互、Ctrl+C)
    if (msg.type === 'input') {
      if (execStream && msg.data) {
        execStream.write(msg.data);
      }
      return;
    }

    // ③ 终端尺寸变化
    if (msg.type === 'resize') {
      if (currentExec && msg.cols && msg.rows) {
        try {
          await currentExec.resize({ h: msg.rows, w: msg.cols });
        } catch {}
      }
      return;
    }

    // ④ Ctrl+C / 中断当前 exec
    if (msg.type === 'interrupt') {
      if (execStream) {
        execStream.destroy();
        execStream = null;
        currentExec = null;
        ws.send(JSON.stringify({ type: 'status', message: 'interrupted' }));
      }
      return;
    }
  });

  ws.on('close', () => {
    if (execStream) {
      execStream.destroy();
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
