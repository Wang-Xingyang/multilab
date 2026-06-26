# 教程编写指南

MultiLab 的教程就是一个 JSON 文件，放在 `tutorials/<教程名>/tutorial.json`。刷新页面后自动出现在顶部下拉框。

本指南也适用于 AI agent 自动生成教程——见末尾 [给 AI agent 的编写指引](#给-ai-agent-的编写指引)。

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
| `id` | string | 是 | 教程唯一标识，建议和目录名一致 |
| `title` | string | 是 | 显示在下拉框和页面标题 |
| `description` | string | 是 | 简短描述，一句话说明学什么 |
| `language` | string | 是 | 主语言，决定 Monaco 默认高亮：`c` / `cpp` / `javascript` / `python` / `shell` / `rust` / `go` |
| `steps` | array | 是 | 步骤数组，至少 1 个 |

### step 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | 是 | 步骤名，显示在底部导航栏 |
| `instructions` | string | 是 | Markdown 内容，渲染到左侧面板 |
| `files` | array | 否 | 初始代码文件，加载到编辑器（支持多个，见下） |
| `run_cmd` | string | 否 | 自定义运行命令；不填则用默认（根据 `language` 推断） |

### file 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 文件名，决定容器内路径 `/home/student/workspace/<name>` |
| `language` | string | 否 | Monaco 语言 ID，不填则用教程的 `language` |
| `content` | string | 是 | 初始代码内容（注意 JSON 转义） |

## 多文件支持

一个 step 的 `files` 数组可以放多个文件，它们会以标签栏形式显示在编辑器上方，学员可以切换。

```json
{
  "title": "多文件项目",
  "instructions": "# 多文件项目\n\n左侧是 main.c，点击标签切换到 utils.c。",
  "files": [
    {
      "name": "main.c",
      "language": "c",
      "content": "#include <stdio.h>\n\nint add(int a, int b);\n\nint main(void) {\n    printf(\"3 + 4 = %d\\n\", add(3, 4));\n    return 0;\n}\n"
    },
    {
      "name": "utils.c",
      "language": "c",
      "content": "int add(int a, int b) {\n    return a + b;\n}\n"
    }
  ],
  "run_cmd": "gcc /home/student/workspace/main.c /home/student/workspace/utils.c -o /tmp/a.out && /tmp/a.out"
}
```

**注意**：`run_cmd` 需要显式列出所有要编译的文件（或用 `*.c` 通配）。MultiLab 不会自动推断多文件编译命令。

切换 step 时，编辑器会用新 step 的 `files` 替换当前标签栏。学员在某个 step 里新建的文件（通过编辑器的"+"按钮）不会跨 step 保留。

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

如果 `step` 不填 `run_cmd`，前端根据 `language` 推断：

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

每个 step 切换时，编辑器会加载该 step 的 `files`，替换当前的标签栏。

## 学员可用的编辑器功能

学员在编辑器里可以：

- **切换文件标签**：点击标签栏的文件名切换
- **新建文件**：点标签栏左侧的文件夹图标，从容器工作区打开已有文件
- **保存到容器**：点顶部保存按钮或 `Ctrl+S`，内容写入 `/home/student/workspace/<name>`
- **恢复初始内容**：点顶部恢复按钮，把当前文件重置为教程定义的 `content`
- **修改标记**：编辑过的文件标签会显示圆点，保存后消失

这些功能学员都能直接用，教程作者不需要额外配置。

## 添加新语言

### 1. 写 Dockerfile

`docker/python.Dockerfile`：

```dockerfile
FROM python:3.12-slim

RUN pip install --no-cache-dir numpy matplotlib ipython

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
"run_cmd": "gcc /home/student/workspace/hello.c -o /tmp/a.out && /tmp/a.out && echo '\n如果看到这行，说明编译运行都成功了'"
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

不要 `main.c` `main2.c` `main3.c`，用 `hello.c` `args.c` `buggy.c`。学员在终端里能清楚知道自己在操作哪个文件。

### 7. 引导终端交互

MultiLab 的终端是真 TTY，支持 gdb、python REPL 等交互式工具。在 instructions 里引导学员使用：

```markdown
## 试试这个

1. 点运行编译程序
2. 在终端里输入:
   ```
   gdb /tmp/a.out
   ```
3. 进入 gdb 后输入 `break main` 设断点
```

## 常见问题

### Q: 能在一个 step 里放多个文件吗？

可以。`files` 数组支持多个文件，会以标签栏形式显示。`run_cmd` 需要显式编译所有需要的文件。

### Q: 怎么让学员在终端里交互？

直接在 instructions 里引导（见上面的"引导终端交互"）。终端是真 TTY，支持任意交互式工具。

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

## 给 AI agent 的编写指引

如果你是 AI agent，被要求为 MultiLab 编写教程，请遵循以下规范：

### 输出格式

输出一个完整的 JSON 文件，路径为 `tutorials/<id>/tutorial.json`。不要输出多个文件，所有内容（包括代码）都内联在 JSON 的 `content` 字段里。

### 必须遵守的规则

1. **JSON 合法性**：所有字符串必须正确转义。代码里的换行是 `\n`，引号是 `\"`，反斜杠是 `\\`。用 `python3 -c "import json; json.load(open('path'))"` 验证。

2. **文件路径**：代码在容器内的路径是 `/home/student/workspace/<filename>`。`run_cmd` 里引用文件必须用这个完整路径。

3. **language 取值**：必须是 `c` / `cpp` / `javascript` / `python` / `shell` / `rust` / `go` 之一（小写）。`file.language` 可以省略，默认用教程的 `language`。

4. **instructions 是 Markdown**：用 `#` `##` 分段，用代码块展示示例代码，用列表给步骤。不要在 Markdown 里用 HTML 标签。

5. **每步聚焦一个概念**：不要把多个不相关的知识点塞进一个 step。

6. **代码要有引导性**：用 `// TODO:` 注释标记需要学员修改的地方，而不是直接给完整答案。

7. **run_cmd 要可运行**：命令必须能在容器的 `student` 用户下执行。C 代码用 `gcc ... -o /tmp/a.out && /tmp/a.out`，输出文件放 `/tmp/` 避免污染工作区。

8. **不要用 emoji**：instructions 和代码注释里不要用 emoji 或 unicode 表情符号。

### 模板

```json
{
  "id": "<kebab-case-id>",
  "title": "<简短标题>",
  "description": "<一句话描述>",
  "language": "c",
  "steps": [
    {
      "title": "<步骤标题>",
      "instructions": "# <标题>\n\n<引导文字>\n\n## 任务\n\n<具体任务描述>\n",
      "files": [
        {
          "name": "<filename>.c",
          "language": "c",
          "content": "#include <stdio.h>\n\nint main(void) {\n    // TODO: <任务说明>\n    return 0;\n}\n"
        }
      ],
      "run_cmd": "gcc /home/student/workspace/<filename>.c -o /tmp/a.out -Wall && /tmp/a.out"
    }
  ]
}
```

### 验证清单

写完后检查：

- [ ] JSON 能被 `python3 -c "import json; json.load(...)"` 解析
- [ ] `id` 和目录名一致
- [ ] 每个 step 都有 `title`、`instructions`、`files`（至少一个文件）
- [ ] `run_cmd` 里的文件路径和 `files[0].name` 对应
- [ ] 代码里的 `\n` `\"` `\\` 转义正确
- [ ] instructions 里没有 emoji
- [ ] 每个 step 只教一个概念
- [ ] 代码里有 TODO 引导学员动手
