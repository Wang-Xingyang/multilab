# MultiLab

> 本地交互式学习环境 —— 左侧 Markdown 教程，右侧 Monaco 编辑器 + 真终端，代码通过 Docker 容器执行。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/docker-%3E%3D20-blue)](https://www.docker.com/)

灵感来自 UCLA 的 [SEBook](https://tobiasduerschmid.github.io/SEBook/)，但用 **Docker 容器** 替代 WebAssembly 后端 —— 本地化部署、零云端成本、原生性能、完整工具链。

## 为什么用 MultiLab

| | SEBook (Wasm) | MultiLab (Docker) |
|---|---|---|
| 执行后端 | v86 / Pyodide / WebContainer | 真正的 Linux 容器 |
| 性能 | 模拟器开销 | 原生性能 |
| 工具链 | 受限于 Wasm 移植 | 任意 apt 可装 |
| 交互式调试 | 受限 | 完整 gdb / strace / ltrace |
| 离线 | ✅ | ✅ |
| 后端成本 | 零 | 零（本地 Docker） |
| 部署难度 | 静态站 | `docker-compose up` |

## 当前支持

| 语言场景 | 镜像 | 状态 |
|---|---|---|
| **C / Shell (OS 课)** | `multilab/os:latest` | 已支持：gcc / gdb / make / valgrind / strace / manpages |
| Node.js | `multilab/node:latest` | 计划中 |
| Python | `multilab/python:latest` | 计划中 |
| Rust / Go | — | 计划中 |

## 快速开始

### 前置要求

- **Docker 20+**（WSL 用户请开启 WSL Integration）
- **Node.js 20+**（推荐用 [nvm](https://github.com/nvm-sh/nvm) 管理）

### 三步启动

```bash
# 1. 克隆
git clone <your-fork-url> ~/multilab-project/multilab
cd ~/multilab-project/multilab

# 2. 构建执行镜像 + 安装后端依赖
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/
cd server && npm install && cd ..

# 3. 启动
cd server && npm start
```

浏览器访问 **http://localhost:3000**

> **不想装 Node？** 直接 `docker-compose up --build`，连后端都容器化。详见 [部署指南](docs/deployment.md)。

## 工作流

```
┌────────────────────┬─────────────────────────┐
│  教程 (Markdown)    │  Monaco Editor          │
│                    │  (VS Code 同款)          │
│  - 步骤导航         ├─────────────────────────┤
│  - 代码示例         │  Terminal (xterm.js)     │
│  - 任务说明         │  真 TTY → Docker exec    │
│                    │  支持 gdb / 交互式 REPL  │
└────────────────────┴─────────────────────────┘
```

1. 左侧渲染 Markdown 教程，提供步骤导航
2. 右侧上方是 Monaco 编辑器，写代码
3. 右侧下方是真终端，支持交互式 gdb / REPL
4. 点 **▶ 运行** 或 `Ctrl+Enter`，代码写入容器、编译执行、stdout 实时回显

## 目录速览

```
multilab/
├── docker/
│   └── os.Dockerfile          # OS 课执行镜像
├── server/
│   ├── package.json
│   ├── index.js               # 后端核心 (~230 行)
│   └── Dockerfile             # 后端容器镜像（部署用）
├── public/
│   └── index.html             # 前端单页 (CDN 引 Monaco + xterm + marked)
├── tutorials/
│   └── hello-c/
│       └── tutorial.json      # 教程定义
├── docs/                      # 详细文档
├── docker-compose.yml         # 一键部署
└── README.md
```

## 文档

- [架构设计](docs/architecture.md) —— 技术选型、数据流、与 SEBook 对比
- [开发指南](docs/development.md) —— 开发环境、Git 工作流、贡献流程
- [教程编写指南](docs/tutorial-authoring.md) —— 如何添加新教程和新语言
- [故障排除](docs/troubleshooting.md) —— 常见问题与已知坑
- [部署指南](docs/deployment.md) —— Docker Compose 部署、生产环境配置

## 开发约定

- 主分支 `main` 永远可运行
- 改动走 **feature branch + PR + squash merge**
- commit message 用 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`
- 详见 [开发指南](docs/development.md)

## License

MIT
