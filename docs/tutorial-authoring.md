# 教程编写指南

MultiLab 的教程就是一个 JSON 文件，放在 `tutorials/<教程名>/tutorial.json`。刷新页面后自动出现在顶部下拉框。

## 最小示例

`tutorials/my-tutorial/tutorial.json`：

```json
{
  "id": "my-tutorial",
  "title": "我的教程",
  "description": "学什么",
  "language": "c",
  "steps": [
    {
      "title": "第一步",
      "instructions": "# 你好\n\n这是 **Markdown** 内容。",
      "files": [
        {
          "name": "main.c",
          "language": "c",
          "content": "#include <stdio.h>\n\nint main(void) {\n    printf(\"Hello\\n\");\n    return 0;\n}\n"
        }
      ],
      "run_cmd": "gcc /home/student/workspace/main.c -o /tmp/a.out && /tmp/a.out"
    }
  ]
}
```

## 字段说明

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 教程唯一标识，建议和目录名一致 |
| `title` | string | ✅ | 显示在下拉框和页面标题 |
| `description` | string | ✅ | 简短描述，一句话说明学什么 |
| `language` | string | ✅ | 主语言，决定 Monaco 默认高亮：`c` / `cpp` / `javascript` / `python` / `shell` / `rust` / `go` |
| `steps` | array | ✅ | 步骤数组，至少 1 个 |

### step 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | ✅ | 步骤名，显示在底部导航栏 |
| `instructions` | string | ✅ | Markdown 内容，渲染到左侧面板 |
| `files` | array | ❌ | 初始代码文件，加载到编辑器 |
| `run_cmd` | string | ❌ | 自定义运行命令；不填则用默认（根据 `language` 推断） |

### file 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 文件名，决定容器内路径 `/home/student/workspace/<name>` |
| `language` | string | ❌ | Monaco 语言 ID，不填则用教程的 `language` |
| `content` | string | ✅ | 初始代码内容（注意 JSON 转义） |

## Markdown 语法

`instructions` 字段支持完整 Markdown，用 [marked](https://marked.js.org/) 渲染：

```markdown
# 大标题

## 小标题

正文段落，支持 **粗体**、*斜体*、`行内代码`。

### 代码块

​```c
int main(void) {
    return 0;
}
​```

### 列表

- 无序项 1
- 无序项 2

1. 有序项 1
2. 有序项 2

### 引用

> 提示：这是引用块，常用于注意事项。

### 链接

[Markdown 语法](https://www.markdownguide.org/)
```

## run_cmd 的默认行为

如果 `step` 不填 `run_cmd`，后端根据 `language` 推断：

| language | 默认命令 |
|---|---|
| `c` | `gcc /home/student/workspace/<file> -o /tmp/a.out -Wall && /tmp/a.out` |
| `cpp` | `g++ /home/student/workspace/<file> -o /tmp/a.out -Wall && /tmp/a.out` |
| `javascript` / `node` | `node /home/student/workspace/<file>` |
| `python` | `python3 /home/student/workspace/<file>` |
| `shell` | `bash /home/student/workspace/<file>` |

**自定义 run_cmd 的场景**：

```json
// 带命令行参数
"run_cmd": "gcc /home/student/workspace/args.c -o /tmp/a.out && /tmp/a.out foo bar baz"

// 带调试符号，方便 gdb
"run_cmd": "gcc /home/student/workspace/buggy.c -o /tmp/a.out -Wall -g && /tmp/a.out"

// 编译多文件
"run_cmd": "gcc /home/student/workspace/*.c -o /tmp/a.out && /tmp/a.out"

// 运行后给提示
"run_cmd": "gcc /home/student/workspace/hello.c -o /tmp/a.out && /tmp/a.out && echo '--- 现在试 gdb /tmp/a.out ---'"
```

## 多步骤教程

```json
{
  "id": "pointers",
  "title": "C 指针入门",
  "description": "从变量地址到指针运算",
  "language": "c",
  "steps": [
    {
      "title": "变量的地址",
      "instructions": "# 变量的地址\n\n用 `&` 取地址...",
      "files": [{ "name": "step1.c", "language": "c", "content": "..." }],
      "run_cmd": "gcc /home/student/workspace/step1.c -o /tmp/a.out && /tmp/a.out"
    },
    {
      "title": "指针变量",
      "instructions": "# 指针变量\n\n指针存的是地址...",
      "files": [{ "name": "step2.c", "language": "c", "content": "..." }],
      "run_cmd": "gcc /home/student/workspace/step2.c -o /tmp/a.out && /tmp/a.out"
    },
    {
      "title": "指针运算",
      "instructions": "# 指针运算\n\n指针可以加减...",
      "files": [{ "name": "step3.c", "language": "c", "content": "..." }],
      "run_cmd": "gcc /home/student/workspace/step3.c -o /tmp/a.out && /tmp/a.out"
    }
  ]
}
```

每个 step 切换时，编辑器会加载该 step 的 `files[0]` 内容。

## 添加新语言

### 1. 写 Dockerfile

`docker/python.Dockerfile`：

```dockerfile
FROM python:3.12-slim

# 装教学常用包
RUN pip install --no-cache-dir \
    numpy \
    matplotlib \
    ipython

# 非 root 用户
RUN useradd -m -s /bin/bash student
USER student
WORKDIR /home/student/workspace

CMD ["python3"]
```

### 2. 构建镜像

```bash
docker build -t multilab/python:latest -f docker/python.Dockerfile docker/
```

### 3. 切换镜像

**方式 A：环境变量（临时）**

```bash
EXEC_IMAGE=multilab/python:latest npm start
```

**方式 B：改配置（持久）**

编辑 `server/index.js`：

```javascript
const EXEC_IMAGE = process.env.EXEC_IMAGE || 'multilab/python:latest';
```

### 4. 写教程

`tutorials/hello-python/tutorial.json`：

```json
{
  "id": "hello-python",
  "title": "Hello, Python",
  "description": "Python 入门",
  "language": "python",
  "steps": [
    {
      "title": "第一个 Python 程序",
      "instructions": "# Hello, Python\n\n点运行看看。",
      "files": [
        {
          "name": "hello.py",
          "language": "python",
          "content": "print('Hello, Python!')\n"
        }
      ],
      "run_cmd": "python3 /home/student/workspace/hello.py"
    }
  ]
}
```

### 5. 验证

```bash
# 重启后端（如果改了 index.js）
cd server && npm start

# 浏览器刷新，下拉框应该能看到新教程
```

## 教程编写最佳实践

### 1. instructions 要短

左侧面板宽度有限，避免长段落。多用标题、列表、代码块分段。

### 2. 每步只教一个概念

不要在一个 step 里塞 "变量 + 循环 + 函数"。拆成 3 个 step，每个聚焦一个点。

### 3. 代码要有 TODO

```c
int main(void) {
    int x = 10;
    // TODO: 把 x 改成你想要的值
    printf("x = %d\n", x);
    return 0;
}
```

让学员动手改，而不是只点运行看结果。

### 4. 用 run_cmd 给提示

```json
"run_cmd": "gcc /home/student/workspace/hello.c -o /tmp/a.out && /tmp/a.out && echo '\n✅ 如果看到这行，说明编译运行都成功了'"
```

### 5. 故意埋 bug 教调试

```c
int main(void) {
    int sum;  // BUG: 没初始化
    for (int i = 1; i <= 10; i++) {
        sum += i;
    }
    printf("sum = %d\n", sum);  // 会是垃圾值
    return 0;
}
```

然后在 instructions 里引导用 gdb 单步调试。

### 6. 文件名要语义化

❌ `main.c` `main2.c` `main3.c`
✅ `hello.c` `args.c` `buggy.c`

学员在终端里能清楚知道自己在操作哪个文件。

## 常见问题

### Q: 能在一个 step 里放多个文件吗？

当前实现只加载 `files[0]` 到编辑器。多文件支持是计划中的功能。临时方案：用 `run_cmd` 编译多个文件：

```json
"files": [{ "name": "main.c", "content": "..." }],
"run_cmd": "echo '其他文件内容' > /home/student/workspace/helper.c && gcc /home/student/workspace/*.c -o /tmp/a.out && /tmp/a.out"
```

### Q: 怎么让学员在终端里交互？

直接在 instructions 里引导：

```markdown
## 试试这个

1. 点运行编译程序
2. 在终端里输入:
   ```
   gdb /tmp/a.out
   ```
3. 进入 gdb 后输入 `break main` 设断点
```

终端是真 TTY，支持任意交互式工具。

### Q: 教程内容能动态生成吗？

当前 `tutorial.json` 是静态的。如果需要动态内容（比如随机测试用例），可以在 `run_cmd` 里用 shell 脚本生成：

```json
"run_cmd": "python3 -c \"import random; print(random.randint(1,100))\" > /tmp/seed.txt && gcc /home/student/workspace/guess.c -o /tmp/a.out && /tmp/a.out < /tmp/seed.txt"
```

### Q: 怎么测试我写的教程？

```bash
# 1. 确认 JSON 合法
python3 -c "import json; json.load(open('tutorials/my-tutorial/tutorial.json'))"

# 2. 重启后端（教程是启动时扫描的）
cd server && npm start

# 3. 浏览器刷新，下拉框选你的教程

# 4. 逐 step 走一遍，确认编辑器内容、运行命令、终端输出都符合预期
```
