# MultiLab 后端容器镜像
# 部署用: 把 Node 后端打包成 Docker 镜像
# 开发时不需要用这个,直接 cd server && npm run dev

FROM node:24-slim

WORKDIR /app

# 先拷 package.json,利用 Docker 层缓存
COPY server/package.json ./
RUN npm install --omit=dev

# 拷代码
COPY server/index.js ./

# 拷静态资源 + 教程 (compose 里会用 volume 覆盖)
COPY public ../public
COPY tutorials ../tutorials

EXPOSE 3000
CMD ["node", "index.js"]
