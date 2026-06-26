# MultiLab OS 课镜像 — 系统编程环境
# 用途: 学员在此容器内编译运行 C 代码、调试 gdb、练习 shell
FROM ubuntu:24.04

# 避免安装时交互卡住
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# 系统编程课标配工具链
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    gdb \
    valgrind \
    strace \
    ltrace \
    binutils \
    libc6-dev \
    manpages-dev \
    manpages-posix-dev \
    vim \
    less \
    tree \
    rlwrap \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 非 root 用户,匹配 OS 课评分环境
RUN useradd -m -s /bin/bash student
USER student
WORKDIR /home/student/workspace

# 默认进 bash,支持交互式 gdb / REPL
CMD ["bash"]
