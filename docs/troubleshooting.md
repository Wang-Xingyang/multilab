# 故障排除

记录了开发过程中踩过的所有坑，按问题类型分类。

## 启动失败

### `Error: listen EADDRINUSE: address already in use :::3000`

**原因**：3000 端口被占用。

**排查**：

```bash
# 看谁在用
lsof -i:3000
# 或
ss -tlnp | grep 3000
```

**解决**：

```bash
# 方案 A：杀掉占用进程
kill -9 <PID>

# 方案 B：换个端口
PORT=3001 npm start
```

### `执行镜像 multilab/os:latest 未构建`

**原因**：还没构建执行容器镜像。

**解决**：

```bash
cd ~/multilab-project/multilab
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/
```

构建一次约 5-10 分钟（取决于网速），之后会缓存。

### `Cannot connect to the Docker daemon`

**原因**：Docker 没启动，或 WSL Integration 没开。

**解决**：

```bash
# 1. 确认 Docker Desktop 在运行
docker version

# 2. 如果报 "Cannot connect"，启动 Docker Desktop
#    Windows 用户：开始菜单 → Docker Desktop

# 3. WSL 用户：确认 WSL Integration 已开
#    Docker Desktop → Settings → Resources → WSL Integration → 你的发行版: ON

# 4. 验证
docker ps
```

## Docker 镜像拉取

### `fork/exec /usr/bin/docker-credential-desktop.exe: exec format error`

**原因**：Docker Desktop 在 Windows 侧写入了 `~/.docker/config.json`，但 WSL 内无法执行 `.exe`。

**解决**：编辑 WSL 内的 `~/.docker/config.json`：

```json
{
  "credsStore": ""
}
```

把 `credsStore` 的值清空即可。

### 拉取超时 / `registry-1.docker.io` 不可达

**原因**：国内网络访问 Docker Hub 不稳定。

**解决**：

**方案 A：配代理**

如果你有代理，确保 Docker daemon 也走代理：

```bash
# Docker Desktop → Settings → Resources → Proxies
# 填入你的代理地址，如 http://127.0.0.1:7890
```

注意：TUN 模式的代理有时不会被 Docker daemon 继承，需要显式配置。

**方案 B：用国内镜像源**

Docker Desktop → Settings → Docker Engine，编辑 JSON：

```json
{
  "registry-mirrors": [
    "https://docker.mirrors.ustc.edu.cn",
    "https://hub-mirror.c.163.com"
  ]
}
```

应用后重启 Docker。

**方案 C：重启大法**

有时候就是网络抖动，重启代理 + Docker Desktop 往往能解决：

```bash
# 1. 重启你的代理软件
# 2. Docker Desktop → Restart
# 3. 重试
docker pull hello-world
```

## 前端问题

### 页面空白 / 卡在 "正在加载教程..."

**原因**：很可能是 JS 报错。按 F12 打开开发者工具看 Console。

**常见子原因**：

#### 子原因 1：`marked is not defined`

**根因**：`marked@12+` 改成纯 ESM 模块，`<script>` 标签加载不再暴露全局变量 `marked`。

**解决**：降级到 `marked@9.x`。编辑 `public/index.html`：

```html
<!-- 错误：v12+ 不暴露全局变量 -->
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>

<!-- 正确：v9.x 最后一个支持 UMD 的版本 -->
<script src="https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js"></script>
```

#### 子原因 2：CDN 加载失败

**症状**：Console 报 `Failed to load resource` 或 `net::ERR_*`。

**解决**：

```bash
# 测试 CDN 是否可达
curl -I https://cdn.jsdelivr.net/npm/monaco-editor@0.50.0/min/vs/loader.js

# 如果不通，换 CDN
# jsdelivr → unpkg
# https://unpkg.com/monaco-editor@0.50.0/min/vs/loader.js
```

#### 子原因 3：浏览器缓存

**症状**：改了代码但页面没变。

**解决**：

```
Ctrl+Shift+R  (Windows/Linux)
Cmd+Shift+R   (Mac)
```

或开 DevTools → Network → 勾选 "Disable cache"。

### 终端显示 "连接断开,3 秒后重连"

**原因**：WebSocket 连不上。

**排查**：

```bash
# 1. 确认后端在跑
curl http://localhost:3000/api/tutorials

# 2. 测试 WebSocket（需要 wscat）
npm install -g wscat
wscat -c ws://localhost:3000/ws
# 应该看到 {"type":"status","message":"connected"}

# 3. 看后端日志有没有报错
```

### 点运行没反应

**排查**：

1. 确认 WebSocket 已连接（终端应该显示"已连接"）
2. F12 → Network → WS，看有没有发出 `{"type":"run",...}` 消息
3. 看后端日志有没有报错
4. 手动进容器测试：

```bash
docker exec -it multilab-session bash
# 容器内手动跑一遍 run_cmd
gcc /home/student/workspace/hello.c -o /tmp/a.out && /tmp/a.out
```

## WSL 特定问题

### `wsl bash -c "node --version"` 报 node not found

**原因**：非交互式 shell 不加载 `~/.bashrc`，nvm 初始化脚本不执行。

**解决**：用 `bash -lic`（login + interactive + command）：

```bash
# 不行
wsl bash -c "node --version"

# 可以
wsl bash -lic "node --version"
```

**永久解决**：把 nvm 初始化加到 `~/.profile` 或 `~/.bash_profile`（login shell 会读）。

### 在 Windows 原生开发，Docker 编译巨慢

**原因**：Docker Desktop 在 Windows 原生挂载走 9P 协议，跨文件系统性能差。

**解决**：把项目移到 WSL ext4 内：

```bash
# 在 WSL 内
mv /mnt/c/Users/you/multilab ~/multilab-project/multilab
cd ~/multilab-project/multilab

# 用 VS Code Remote-WSL 打开
code .
```

## 容器问题

### `docker exec` 报 `container not running`

**原因**：`multilab-session` 容器停了。

**解决**：

```bash
# 看容器状态
docker ps -a | grep multilab

# 重启容器
docker start multilab-session

# 或删了重建
docker rm -f multilab-session
# 然后重启后端，会自动创建新容器
```

### 容器内编译报 `permission denied`

**原因**：可能是以 root 写了文件，但 exec 以 `student` 用户执行。

**排查**：

```bash
docker exec -it multilab-session ls -la /home/student/workspace/
# 如果文件 owner 是 root，就是这个问题
```

**解决**：后端 `container.exec` 时显式指定 `User: 'student'`（已在 `server/index.js` 里配了）。如果还出现，手动修：

```bash
docker exec -u root multilab-session chown -R student:student /home/student/workspace/
```

### 容器越用越大

**原因**：容器内的 `/tmp` 和 apt 缓存会累积。

**解决**：

```bash
# 定期清理
docker exec multilab-session bash -c "rm -rf /tmp/* /var/cache/apt/*"

# 或直接重建
docker rm -f multilab-session
# 重启后端会自动建新的
```

## Git 问题

### commit author 是 `wangxy <wangxy@multilab.local>`

**原因**：之前误用了 `git config --local` 覆盖了 author。

**解决**：

```bash
# 删除 local 覆盖，继承 global
git config --unset --local user.email
git config --unset --local user.name

# 修正上一个 commit 的 author
git commit --amend --reset-author --no-edit

# 验证
git log -1 --format='%an <%ae>'
# 应该是你的 global config
```

### commit 里有 `Co-Authored-By`

**解决**：amend 去掉：

```bash
git commit --amend -m "$(git log -1 --format='%B' | sed '/^Co-Authored-By:/d')"
```

## 还没解决的问题

如果以上都没覆盖到，请：

1. 按 F12 看 Console 报错
2. 看后端日志（`npm start` 的终端输出）
3. `docker logs multilab-session` 看容器日志
4. 开 issue，附上报错信息和复现步骤
