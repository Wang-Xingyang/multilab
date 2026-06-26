# MultiLab

本地交互式学习环境 —— 左侧文字教程 + 右侧 Monaco 编辑器 + 真终端,通过 Docker 容器执行代码。

灵感来自 [SEBook](https://tobiasduerschmid.github.io/SEBook/),但用 Docker 替代 WebAssembly 后端,本地化部署、零云端成本、原生性能。

## 当前支持

| 语言 | 镜像 | 状态 |
|---|---|---|
| C / Shell (OS 课) | `multilab/os:latest` | ✅ 已含 gcc/gdb/make/valgrind/manpages |
| Node.js | (待添加) | 🔜 |
| Python | (待添加) | 🔜 |
| Rust / Go | (待添加) | 🔜 |

## 快速开始

### 前置要求

- **Docker**(已开启 WSL Integration,WSL 内可直接 `docker` 命令)
- **Node 20+**(推荐用 nvm 管理)

### 三步启动

```bash
# 1. 构建执行镜像(只需一次,后续教程复用)
cd ~/multilab-project/multilab
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/

# 2. 安装后端依赖
cd server && npm install

# 3. 启动
npm start
```

打开浏览器访问 **http://localhost:3000**

## 工作流

1. 左侧面板渲染 Markdown 教程,提供步骤导航
2. 右侧上方是 Monaco 编辑器(VS Code 同款),写代码
3. 右侧下方是真终端(xterm.js + Docker exec),支持交互式 gdb / REPL
4. 点 **▶ 运行** 或按 `Ctrl+Enter`,代码写入容器、编译执行、stdout 实时回显

## 架构

```
浏览器 (localhost:3000)
  ├─ 左侧: marked.js 渲染 tutorial.json
  └─ 右侧上: Monaco Editor
     右侧下: xterm.js 终端
            ↓ WebSocket
Node.js 后端 (Express + ws + dockerode)
            ↓ docker.exec({Tty: true})
Docker 容器 (multilab/os:latest)
  └─ gcc / gdb / bash / valgrind ...
```

关键点: `docker.exec.start({tty:true})` 返回双向流,既支持 stdout 流回终端,也支持 stdin 注入,因此 gdb 这种交互式工具能完整工作。

## 目录结构

```
multilab/
├── docker/
│   └── os.Dockerfile        # OS 课镜像
├── server/
│   ├── package.json
│   └── index.js             # 后端核心(~200 行)
├── public/
│   └── index.html           # 前端单页(CDN 引 Monaco + xterm + marked)
├── tutorials/
│   └── hello-c/
│       └── tutorial.json    # 教程定义
├── docker-compose.yml       # 部署用
└── README.md
```

## 添加新教程

在 `tutorials/` 下新建目录,放一个 `tutorial.json`:

```json
{
  "id": "my-tutorial",
  "title": "我的教程",
  "description": "学什么",
  "language": "c",
  "steps": [
    {
      "title": "第一步",
      "instructions": "# Markdown 内容",
      "files": [{ "name": "main.c", "language": "c", "content": "..." }],
      "run_cmd": "gcc /home/student/workspace/main.c -o /tmp/a.out && /tmp/a.out"
    }
  ]
}
```

刷新页面,新教程自动出现在顶部下拉框。

## 添加新语言

1. 在 `docker/` 下新建 `xxx.Dockerfile`
2. `docker build -t multilab/xxx:latest -f docker/xxx.Dockerfile docker/`
3. 在 `server/index.js` 顶部修改 `EXEC_IMAGE`,或通过环境变量切换

## 部署给别人

```bash
docker-compose up --build
```

别人只需有 Docker,不需要装 Node。详见 `docker-compose.yml`。

## 开发约定

- 主分支 `main` 永远可运行
- 改动走 feature branch + PR + squash merge
- commit message 用 [Conventional Commits](https://www.conventionalcommits.org/):`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`
- `node_modules/` `workspace/` `sessions/` 已在 `.gitignore` 中

## License

MIT
