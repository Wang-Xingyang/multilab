# 开发指南

## 开发环境要求

| 工具 | 版本 | 说明 |
|---|---|---|
| **Docker** | 20+ | 必须开启 WSL Integration（Windows 用户） |
| **Node.js** | 20+ | 推荐 LTS，用 [nvm](https://github.com/nvm-sh/nvm) 管理 |
| **Git** | 2.30+ | 任何近期版本即可 |

### Windows + WSL 用户（推荐配置）

MultiLab 涉及 Docker 容器和大量小文件（node_modules），**必须在 WSL ext4 文件系统内开发**，不要在 Windows 原生 NTFS 上。

**原因**：
- Docker Desktop 在 Windows 原生挂载走 9P 协议，gcc 编译慢 10x+
- node_modules 小文件密集，NTFS 拖累严重
- CRLF/权限位/大小写一致性坑多

**设置步骤**：

```bash
# 1. 在 WSL 内用 nvm 装 Node
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install --lts
nvm use --lts

# 2. 确认 Docker WSL Integration 已开启
#    Docker Desktop → Settings → Resources → WSL Integration → Ubuntu: ON
docker --version  # 在 WSL 内能跑通即可

# 3. 克隆项目到 WSL ext4
git clone <your-fork-url> ~/multilab-project/multilab
cd ~/multilab-project/multilab

# 4. 用 VS Code Remote-WSL 打开
code .
```

### macOS / Linux 用户

直接克隆、装 Docker、装 Node 即可，无需特殊配置。

## 双层目录约定

```
~/multilab-project/           ← 外层工作区（不入 git）
├── multilab/                 ← 内层 git 仓库
│   ├── docker/
│   ├── server/
│   ├── public/
│   └── ...
├── drafts/                   ← 和 agent 对话的草稿、笔记
├── notes/                    ← 个人学习笔记
└── scratch/                  ← 实验性代码、临时文件
```

**理由**：保持 git 仓库干净，对话草稿/笔记不污染版本控制。外层目录随意用，内层 `multilab/` 严格走 git workflow。

## 本地启动

```bash
# 1. 构建执行镜像（首次或 Dockerfile 变更时）
cd ~/multilab-project/multilab
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/

# 2. 安装后端依赖
cd server && npm install

# 3. 启动开发模式（文件变更自动重启）
npm run dev
# 或
npm start

# 4. 浏览器访问 http://localhost:3000
```

### 常用端口

| 服务 | 端口 | 说明 |
|---|---|---|
| MultiLab 后端 | 3000 | 默认端口，可通过 `PORT` 环境变量修改 |

如果 3000 被占用：

```bash
# 查看占用
lsof -i:3000

# 或改端口启动
PORT=3001 npm start
```

## Git 工作流

### 分支模型

- `main` —— 主分支，永远可运行，受保护
- `feature/xxx` —— 新功能分支
- `fix/xxx` —— 修 bug 分支
- `docs/xxx` —— 文档分支

### 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

<body 可选>

<footer 可选>
```

**type 取值**：

| type | 用途 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat(tutorial): add pointers tutorial` |
| `fix` | 修 bug | `fix: terminal not connecting on reload` |
| `docs` | 文档 | `docs: add architecture overview` |
| `refactor` | 重构 | `refactor: extract container management` |
| `chore` | 杂务 | `chore: update dependencies` |
| `test` | 测试 | `test: add tutorial loader tests` |

**scope** 可选，表示影响的模块（`tutorial` / `server` / `frontend` / `docker` 等）。

### PR 流程

```bash
# 1. 从 main 切分支
git checkout main
git pull
git checkout -b feature/my-feature

# 2. 开发 + 提交（可以多个 commit）
git add -A
git commit -m "feat: add something"

# 3. 推送到自己的 fork
git push origin feature/my-feature

# 4. 在 GitHub 上开 PR，target 是上游 main

# 5. 审核通过后，squash merge 到 main
#    GitHub 上选 "Squash and merge"
#    最终 main 上每个 PR 是一个 commit
```

### 不要做的事

- ❌ 不要直接 push 到 `main`（走 PR）
- ❌ 不要在 commit message 加 `Co-Authored-By` 或 `Generated with ...`
- ❌ 不要提交 `node_modules/`、`workspace/`、`sessions/`、`.env`
- ❌ 不要 amend 已经 push 的 commit（除非只有你自己用这个分支）

## 项目结构详解

```
multilab/
├── docker/
│   └── os.Dockerfile          # 执行容器镜像定义
├── server/
│   ├── package.json           # 后端依赖 (express, ws, dockerode)
│   ├── index.js               # 后端核心 (~230 行)
│   ├── Dockerfile             # 后端容器镜像（部署用，开发不需要）
│   └── node_modules/          # gitignore
├── public/
│   └── index.html             # 前端单页（CDN 引入所有依赖）
├── tutorials/
│   └── hello-c/
│       └── tutorial.json      # 教程定义
├── docs/                      # 本文档目录
├── docker-compose.yml         # 一键部署配置
├── .gitignore
└── README.md
```

### 各目录职责

| 目录 | 职责 | 改动频率 |
|---|---|---|
| `docker/` | 执行容器镜像定义 | 加新语言时改 |
| `server/` | 后端代码 | 核心稳定后少改 |
| `public/` | 前端代码 | 加功能时改 |
| `tutorials/` | 教程内容 | 经常加新教程 |
| `docs/` | 项目文档 | 持续更新 |

## 调试技巧

### 后端调试

```bash
# 加 console.log
console.log('[debug] container:', container.id);

# 用 node --inspect
node --inspect index.js
# 然后 Chrome 打开 chrome://inspect
```

### 前端调试

```bash
# 浏览器 F12 打开开发者工具
# - Console 看 JS 错误
# - Network 看 /api/ 和 ws 请求
# - Sources 断点调试
```

### Docker 调试

```bash
# 看容器状态
docker ps -a | grep multilab

# 进容器手动操作
docker exec -it multilab-session bash

# 看容器日志
docker logs multilab-session

# 清理重来
docker rm -f multilab-session
```

## 添加新依赖

### 后端

```bash
cd server
npm install <package-name>
# package.json 和 package-lock.json 会自动更新
git add package.json package-lock.json
git commit -m "chore: add <package-name>"
```

### 前端

前端用 CDN，在 `public/index.html` 的 `<head>` 里加：

```html
<script src="https://cdn.jsdelivr.net/npm/<package>@<version>/..."></script>
```

**注意版本兼容性**：有些包高版本改成纯 ESM，`<script>` 标签加载不暴露全局变量。装完后在 Console 检查 `typeof <PackageName>` 是否为 `'object'` 或 `'function'`。

## 测试

当前没有自动化测试。手动验证清单：

- [ ] 启动后端，浏览器能打开页面
- [ ] 教程列表能加载（下拉框有内容）
- [ ] 选教程后左侧显示 Markdown 内容
- [ ] 编辑器有初始代码
- [ ] 终端显示"已连接"
- [ ] 点运行，代码编译执行，终端有输出
- [ ] 终端能输入（试 `gdb /tmp/a.out`）
- [ ] Ctrl+C 能中断
- [ ] 步骤导航（上一步/下一步）正常
- [ ] 主题切换正常

## 贡献

1. Fork 仓库
2. 创建 feature 分支
3. 提交符合 Conventional Commits 规范的 commit
4. 开 PR，描述清楚改了什么、为什么改
5. 等待审核

PR 审核标准：
- 代码能跑通（手动验证清单）
- 没有引入新依赖的副作用
- commit message 规范
- 文档同步更新（如果改了行为）
