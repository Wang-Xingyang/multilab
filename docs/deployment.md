# 部署指南

## 场景一：本地开发部署

最简单的方式，适合自己用或开发调试。

### 前置要求

- Docker 20+
- Node.js 20+

### 步骤

```bash
# 1. 克隆
git clone <repo-url> ~/multilab-project/multilab
cd ~/multilab-project/multilab

# 2. 构建执行镜像
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/

# 3. 装后端依赖
cd server && npm install

# 4. 启动
npm start
```

访问 http://localhost:3000

## 场景二：Docker Compose 一键部署

适合给别人用，不需要装 Node。

### 前置要求

- Docker 20+
- Docker Compose v2（Docker Desktop 自带）

### 步骤

```bash
git clone <repo-url>
cd multilab
docker-compose up --build
```

就这样。`docker-compose.yml` 会：

1. 构建执行镜像 `multilab/os:latest`（init 容器，跑一次）
2. 构建后端镜像并启动，端口映射 3000:3000
3. 挂载 `/var/run/docker.sock`，让后端能管理执行容器

### docker-compose.yml 详解

```yaml
services:
  multilab-server:
    build:
      context: .
      dockerfile: server/Dockerfile
    ports:
      - "3000:3000"
    volumes:
      # 关键：让后端能用 dockerode 管理执行容器
      - /var/run/docker.sock:/var/run/docker.sock
      # 教程和 Dockerfile 只读挂载
      - ./tutorials:/app/tutorials:ro
      - ./docker:/app/docker:ro
    environment:
      - NODE_ENV=production
      - PORT=3000
      - EXEC_IMAGE=multilab/os:latest
      - CONTAINER_NAME=multilab-session
    restart: unless-stopped
    depends_on:
      build-exec-image:
        condition: service_completed_successfully

  # 构建执行镜像的初始化容器，只跑一次
  build-exec-image:
    image: docker:cli
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./docker:/docker:ro
    command: docker build -t multilab/os:latest -f /docker/os.Dockerfile /docker
    restart: "no"
```

**关键点**：

1. **`/var/run/docker.sock` 挂载**：让后端容器内的 dockerode 能和宿主 Docker daemon 通信。这是 Docker-in-Docker 管理的标准做法。
2. **`build-exec-image` init 容器**：用 `docker:cli` 镜像在宿主上构建执行镜像，`service_completed_successfully` 保证后端等镜像构建完才启动。
3. **tutorials 只读挂载**：教程内容挂载到后端容器，方便更新教程不用重新构建后端镜像。

## 场景三：生产环境部署

如果要部署到服务器供多人访问，需要额外考虑。

### 反向代理（nginx）

```nginx
server {
    listen 80;
    server_name multilab.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket 支持
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

### HTTPS（Let's Encrypt）

```bash
# 用 certbot
sudo certbot --nginx -d multilab.example.com
```

证书装好后，nginx 配置会自动加 443 监听和重定向。

### 多用户隔离（未来功能）

当前实现是单容器复用，多用户会互相干扰。如果要支持多用户，需要改后端：

```javascript
// 每个 WebSocket 连接创建独立容器
wss.on('connection', async (ws) => {
  const sessionId = crypto.randomUUID();
  const container = await docker.createContainer({
    name: `multilab-${sessionId}`,
    Image: EXEC_IMAGE,
    Cmd: ['sleep', 'infinity'],
    Tty: true,
    OpenStdin: true,
    HostConfig: { AutoRemove: true },
  });
  await container.start();

  ws.on('close', async () => {
    await container.remove({ force: true });
  });
});
```

注意：这会显著增加资源占用。每个容器空闲时约 30MB 内存。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 后端监听端口 |
| `EXEC_IMAGE` | `multilab/os:latest` | 执行容器镜像 |
| `CONTAINER_NAME` | `multilab-session` | 会话容器名 |
| `NODE_ENV` | `development` | Node 环境，生产用 `production` |

使用示例：

```bash
PORT=8080 EXEC_IMAGE=multilab/python:latest npm start
```

## 升级

```bash
# 1. 拉最新代码
git pull

# 2. 如果 Dockerfile 变了，重建执行镜像
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/

# 3. 如果后端依赖变了
cd server && npm install

# 4. 重启后端
# Ctrl+C 停掉旧的，然后
npm start

# 或 Docker Compose 部署的：
docker-compose up --build -d
```

## 备份

### 教程内容

教程在 `tutorials/` 目录，已经纳入 git，push 到远程就是备份。

### 学员代码

当前学员代码在容器内 `/home/student/workspace/`，**容器删除即丢失**。

如果要持久化，挂载 volume：

```yaml
# docker-compose.yml
services:
  multilab-server:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./tutorials:/app/tutorials:ro
      - ./docker:/app/docker:ro
      - ./student-work:/app/student-work  # 新增
    environment:
      - WORKSPACE_HOST_PATH=./student-work  # 告诉后端宿主路径
```

然后改后端，把 `WORKSPACE_HOST_PATH` 挂载到执行容器：

```javascript
// server/index.js
const workspaceHost = process.env.WORKSPACE_HOST_PATH;
const container = await docker.createContainer({
  // ...
  HostConfig: {
    Binds: workspaceHost ? [`${workspaceHost}:/home/student/workspace`] : [],
  },
});
```

这样学员代码会存在宿主的 `student-work/` 目录，容器删除也不丢。

## 监控

### 健康检查

```bash
# 简单的 curl 检查
curl -f http://localhost:3000/api/tutorials || echo "服务挂了"
```

### 日志

```bash
# 后端日志（直接看终端输出）
# 或重定向到文件
npm start > /var/log/multilab.log 2>&1 &

# 容器日志
docker logs multilab-session

# Docker Compose 部署的
docker-compose logs -f multilab-server
```

### 资源占用

```bash
# 看容器资源
docker stats multilab-session

# 看后端进程
ps aux | grep node
```
