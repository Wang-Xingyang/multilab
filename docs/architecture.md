# 架构设计

## 设计目标

MultiLab 的核心目标：**让本地学习系统编程像在 IDE 里写代码一样流畅**。

具体要求：
1. **真终端** —— 必须支持交互式 gdb、REPL、信号（Ctrl+C），不能是简单的 stdout 管道
2. **零云端成本** —— 全部本地运行，不依赖任何远程服务
3. **原生性能** —— 编译、运行、调试都要快，不能有模拟器开销
4. **离线可用** —— 一次构建镜像后，断网也能用
5. **可扩展** —— 加新语言/工具链只是加新 Docker 镜像，不动核心代码

## 三层架构

```
┌──────────────────────────────────────────────────────────┐
│  浏览器 (localhost:3000)                                  │
│                                                          │
│  ┌─────────────────┐  ┌──────────────────────────────┐  │
│  │  教程面板        │  │  工作区                       │  │
│  │  (marked.js)    │  │  ┌────────────────────────┐  │  │
│  │                 │  │  │  Monaco Editor         │  │  │
│  │  Markdown →     │  │  │  (VS Code 同款引擎)     │  │  │
│  │  HTML 渲染      │  │  └────────────────────────┘  │  │
│  │                 │  │  ┌────────────────────────┐  │  │
│  │  步骤导航        │  │  │  xterm.js 终端         │  │  │
│  │                 │  │  │  (真 TTY)              │  │  │
│  └─────────────────┘  │  └──────────┬─────────────┘  │  │
│                       └─────────────┼────────────────┘  │
└──────────────────────────────────────┼───────────────────┘
                                       │ WebSocket (ws://)
                                       ▼
┌──────────────────────────────────────────────────────────┐
│  Node.js 后端 (Express + ws + dockerode)                  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Express       │  │ WebSocket    │  │ dockerode      │ │
│  │ - 静态服务    │  │ - exec 桥接   │  │ - 容器管理     │ │
│  │ - /api/...    │  │ - stdin/stdout│  │ - exec({Tty})  │ │
│  └──────────────┘  └──────────────┘  └───────┬────────┘ │
└────────────────────────────────────────┼──────┘
                                         │ docker exec
                                         ▼
┌──────────────────────────────────────────────────────────┐
│  Docker 容器 (multilab/os:latest)                         │
│                                                          │
│  Ubuntu 24.04 + gcc + gdb + make + valgrind + strace     │
│  非 root 用户: student                                    │
│  工作目录: /home/student/workspace                        │
└──────────────────────────────────────────────────────────┘
```

## 技术选型理由

### 为什么用 Docker 而不是 WebAssembly？

SEBook 用 WebAssembly（v86 / Pyodide / WebContainer）在浏览器里跑代码，优点是零部署、纯前端。但有几个硬伤：

| 维度 | WebAssembly 方案 | Docker 方案 |
|---|---|---|
| **性能** | v86 是 x86 模拟器，编译慢 5-10x | 原生性能，gcc 全速 |
| **工具链** | 只能用移植到 Wasm 的工具 | 任意 apt 可装，包括 gdb/valgrind/strace |
| **交互式调试** | 受限，v86 的 gdb 非常慢 | 完整 gdb，原生体验 |
| **镜像大小** | v86 + Linux 镜像 ~50MB（但每次 boot） | 镜像 213MB，但容器常驻 |
| **首次加载** | 浏览器要下载整个 Wasm + 镜像 | 本地构建一次，秒级启动 |
| **离线** | 首次必须联网 | 构建后完全离线 |

**结论**：对于 OS 课这种需要 gcc/gdb/valgrind/strace 的场景，Docker 方案完胜。Wasm 方案更适合轻量级脚本语言（Python/JS）教学。

### 为什么用 dockerode + exec，而不是 docker-compose 起容器？

```javascript
// 核心代码 (server/index.js)

// 1. 启动时创建常驻容器
const container = await docker.createContainer({
  name: 'multilab-session',
  Image: 'multilab/os:latest',
  Cmd: ['sleep', 'infinity'],
  Tty: true,           // 关键：真 TTY
  OpenStdin: true,
  Hostname: 'tutorial',
});

// 2. WebSocket 连接时启动常驻交互式 shell
const shellExec = await container.exec({
  Cmd: ['bash', '--login', '-i'],
  AttachStdin: true,
  AttachStdout: true,
  AttachStderr: true,
  Tty: true,           // 让 exec 也走 TTY
  User: 'student',
  WorkingDir: '/home/student/workspace',
});
const shellStream = await shellExec.start({ hijack: true, stdin: true });

// 3. 用 demuxStream 解复用 hijack 流 (分离 stdout/stderr)
const stdoutPipe = new PassThrough();
const stderrPipe = new PassThrough();
container.modem.demuxStream(shellStream, stdoutPipe, stderrPipe);

// stream 是双向的：
//   shell 输出 → stdoutPipe 'data' → ws.send → term.write
//   term 输入 → ws.on('input') → shellStream.write → shell stdin
stdoutPipe.on('data', chunk => ws.send(JSON.stringify({ type: 'output', data: chunk.toString() })));
```

**关键点**：

1. **常驻 shell**：连接建立时就启动 `bash --login -i`，贯穿整个会话。学员随时能敲 `ls`/`gcc`/`gdb`，不需要点运行才有终端。
2. **`exec.start({hijack: true, Tty: true})` 返回双向流**，既能流回 stdout，也能注入 stdin。这让 gdb 这种交互式工具完整工作。
3. **`demuxStream`**：Docker hijack 流是多路复用的（8 字节帧头），`container.modem.demuxStream()` 是官方提供的解复用方法，正确分离 stdout/stderr。
4. **运行 = 注入命令**：点运行时，先把代码写入容器文件，再把 `run_cmd` 作为一行命令注入 shell stdin，shell 自己回显+执行+回 PS1。

如果用 `docker run` 每次起新容器，会有几秒延迟，且无法保持状态。用常驻容器 + exec 是最优解。

### 为什么用 Monaco + xterm.js？

这两个分别是 VS Code 和 Hyper 的同款引擎，理由：
- **Monaco**：语法高亮、智能提示、多语言支持开箱即用，VS Code 用户零学习成本
- **xterm.js**：真终端模拟器，支持 ANSI 颜色、光标控制、鼠标事件、resize，比 `<textarea>` 强一个量级

### 为什么前端用 CDN 而不是打包？

- 单文件 `public/index.html`，零构建步骤，改完刷新即生效
- CDN 引入 Monaco/xterm/marked，首次加载后浏览器缓存
- 适合教学场景：学员能直接读源码理解前端怎么工作

**踩过的坑**：`marked@12+` 改成纯 ESM，`<script>` 标签加载不暴露全局变量。必须用 `marked@9.x`。详见 [troubleshooting.md](troubleshooting.md)。

## 数据流

### 运行代码的完整流程

当前实现使用**常驻交互式 shell**（不是每次 run 起新 exec）：

```
用户点 "▶ 运行" (Ctrl+Enter)
    │
    ▼
前端 runCode()
    │ - 从 Monaco 读 code
    │ - 从 tutorial.json 读 run_cmd
    │ - 先调 /api/fs/write 把代码写入容器 (独立 tee exec)
    │ - ws.send({ type:'run', code, filePath, cmd })
    ▼
后端 wss.on('message')
    │ type === 'run'
    ▼
ensureSessionContainer()
    │ - 检查 multilab-session 容器是否存在
    │ - 不存在则创建 (sleep infinity, Tty:true)
    ▼
container.exec({ Cmd: ['tee', filePath] })  ← 写代码到容器文件系统
    │ - start({ hijack:true, stdin:true })
    │ - stream.write(code); stream.end()
    │ - await sleep(100ms)  // 等写入完成
    ▼
shellStream.write(cmd + '\n')  ← 往常驻 shell 注入命令
    │ - shell 是连接建立时就启动的 bash --login -i
    │ - shell 自己回显命令、执行、回到 PS1 提示符
    ▼
stdoutPipe.on('data') → ws.send({ type:'output', data })
    │ - demuxStream 解复用后的干净 stdout
    ▼
前端 ws.on('message')
    │ type === 'output' → term.write(data)
```

### 终端输入的流程（交互式 gdb）

常驻 shell 的 stdin 始终活跃，学员可以随时敲命令：

```
用户在终端输入 "break main\n"
    │
    ▼
xterm term.onData(data)
    │ - ws.send({ type:'input', data })
    ▼
后端 type === 'input'
    │ - shellStream.write(data)  ← 直接注入到常驻 shell 的 stdin
    ▼
gdb 收到 "break main\n"，输出响应
    │ - stdoutPipe 'data' 事件
    │ - ws.send({ type:'output', data })
    ▼
term.write(响应)
```

### 中断的流程（Ctrl+C）

```
用户点中断按钮或按 Ctrl+C
    │
    ▼
ws.send({ type:'interrupt' })
    │
    ▼
后端 shellStream.write('\x03')  ← 发 ETX 字符，不杀常驻 shell
    │ - shell 里运行的进程收到 SIGINT
    │ - shell 本身存活，回到 PS1 提示符
```

## 容器管理策略

### 单容器复用（当前实现）

```
启动时：ensureSessionContainer() 创建/复用 multilab-session
运行时：所有用户共享这一个容器，通过 exec 执行命令
关闭时：容器保留，下次启动复用
```

**优点**：启动快、资源占用低、状态保持
**缺点**：多用户并发会互相干扰（不适合生产环境）

### 未来扩展：每会话独立容器

如果要支持多用户，改成：

```javascript
// 每个 WebSocket 连接创建独立容器
wss.on('connection', (ws) => {
  const sessionId = generateId();
  const container = await docker.createContainer({
    name: `multilab-${sessionId}`,
    Image: EXEC_IMAGE,
    // ...
  });
  await container.start();

  ws.on('close', async () => {
    await container.remove({ force: true });  // 断开即清理
  });
});
```

## 与 SEBook 的对比

| 维度 | SEBook | MultiLab |
|---|---|---|
| **定位** | 在线教材（公开访问） | 本地学习环境（个人/小团队） |
| **执行后端** | WebAssembly（v86/Pyodide/WebContainer） | Docker 容器 |
| **部署** | GitHub Pages 静态站 | 本地 Node.js 或 docker-compose |
| **COI Service Worker** | 需要（SharedArrayBuffer） | 不需要 |
| **离线** | 首次需联网 | 构建镜像后完全离线 |
| **工具链** | 受限于 Wasm 移植 | 任意 apt 可装 |
| **教程格式** | HTML + JSON config | JSON + Markdown |
| **多语言扩展** | 每个语言要写 Wasm 后端 | 加个 Dockerfile 即可 |

## 性能特征

- **首次启动**：~2s（容器创建 + 镜像检查）
- **代码运行**：<100ms（exec 开销）+ 编译时间（gcc 原生速度）
- **终端延迟**：<10ms（WebSocket + Docker stream）
- **内存占用**：~50MB（Node 后端）+ ~30MB（容器空闲时）

## 局限性

1. **依赖 Docker** —— 用户必须装 Docker，门槛比纯前端高
2. **单机** —— 当前实现不支持远程访问（可加 nginx 反代解决）
3. **单容器** —— 多用户会互相干扰（未来扩展见上）
4. **代码不跨容器持久化** —— 容器删除后代码丢失（容器存活时可用保存按钮持久化到容器内；未来可加 volume 挂载到宿主）

## 相关文件

- [server/index.js](../server/index.js) —— 后端核心
- [public/index.html](../public/index.html) —— 前端单页
- [docker/os.Dockerfile](../docker/os.Dockerfile) —— 执行镜像
