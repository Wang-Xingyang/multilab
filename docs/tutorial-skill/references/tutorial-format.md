# MultiLab Tutorial JSON Format Reference

Complete field reference for `tutorial.json` files.

## Top-Level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Tutorial unique identifier. Use kebab-case, match the directory name. |
| `title` | string | yes | Display title. Shows in the dropdown selector and page title. |
| `description` | string | yes | One-sentence summary of what the learner will learn. |
| `language` | string | yes | Primary language. Must be one of: `c`, `cpp`, `javascript`, `python`, `shell`, `rust`, `go`. Determines Monaco default syntax highlighting and default `run_cmd` inference. |
| `steps` | array | yes | Array of step objects. At least 1 step. |

### Example

```json
{
  "id": "c-pointers",
  "title": "C 指针入门",
  "description": "从变量地址到指针运算,理解 C 指针的核心概念",
  "language": "c",
  "steps": [ ... ]
}
```

## Step Object Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Step name. Shows in the bottom navigation bar. |
| `instructions` | string | yes | Markdown content. Rendered to the left panel via marked.js. |
| `files` | array | no | Initial code files. Loaded into the editor as tabs. If omitted, editor starts empty. |
| `run_cmd` | string | no | Custom run command. If omitted, inferred from tutorial `language`. |

### Example

```json
{
  "title": "变量的地址",
  "instructions": "# 变量的地址\n\n用 `&` 运算符取变量的地址:\n\n```c\nint x = 42;\nprintf(\"%p\", &x);\n```\n\n## 任务\n\n运行代码,观察输出的地址格式。",
  "files": [
    {
      "name": "address.c",
      "language": "c",
      "content": "#include <stdio.h>\n\nint main(void) {\n    int x = 42;\n    printf(\"x = %d\\n\", x);\n    printf(\"&x = %p\\n\", (void*)&x);\n    return 0;\n}\n"
    }
  ],
  "run_cmd": "gcc /home/student/workspace/address.c -o /tmp/a.out -Wall && /tmp/a.out"
}
```

## File Object Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Filename. Determines container path `/home/student/workspace/<name>`. Use semantic names: `hello.c`, not `main1.c`. |
| `language` | string | no | Monaco language ID. If omitted, inherits from tutorial's `language`. |
| `content` | string | yes | Initial file content. Must be properly JSON-escaped. |

### Multi-file Example

```json
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
```

## Markdown Syntax (instructions field)

Rendered by [marked.js v9](https://marked.js.org/). Supported syntax:

| Element | Syntax |
|---|---|
| Heading H1 | `# Title` |
| Heading H2 | `## Section` |
| Heading H3 | `### Subsection` |
| Bold | `**bold**` |
| Italic | `*italic*` |
| Inline code | `` `code` `` |
| Code block | ` ```c ... ``` ` (specify language for highlighting) |
| Unordered list | `- item` |
| Ordered list | `1. item` |
| Blockquote | `> note` |
| Link | `[text](url)` |

**Not supported**: HTML tags, LaTeX math, mermaid diagrams. Keep instructions as pure Markdown.

## run_cmd Inference

When `run_cmd` is omitted, MultiLab uses this mapping based on tutorial `language`:

| language | inferred command |
|---|---|
| `c` | `gcc /home/student/workspace/<files[0].name> -o /tmp/a.out -Wall && /tmp/a.out` |
| `cpp` | `g++ /home/student/workspace/<files[0].name> -o /tmp/a.out -Wall && /tmp/a.out` |
| `javascript` | `node /home/student/workspace/<files[0].name>` |
| `python` | `python3 /home/student/workspace/<files[0].name>` |
| `shell` | `bash /home/student/workspace/<files[0].name>` |
| `rust` | (no default — always specify `run_cmd`) |
| `go` | (no default — always specify `run_cmd`) |

**Always specify `run_cmd` explicitly when**:
- Compiling multiple files (`gcc main.c utils.c -o /tmp/a.out`)
- Passing arguments (`/tmp/a.out foo bar`)
- Need debug symbols (`-g` for gdb)
- Running a non-default interpreter or compiler flag
- Adding a post-run message (`&& echo '...'`)

## JSON Escaping Cheat Sheet

Code in the `content` field must be JSON-escaped:

| Code character | JSON escape |
|---|---|
| `"` (double quote) | `\"` |
| `\` (backslash) | `\\` |
| newline | `\n` |
| tab | `\t` |
| carriage return | `\r` |

### Example

C code:
```c
printf("Hello\n");
```

In JSON:
```json
"content": "printf(\"Hello\\n\");\n"
```

## Container Environment

Learner code runs in a Docker container with:

| Property | Value |
|---|---|
| User | `student` (non-root) |
| Working directory | `/home/student/workspace` |
| OS | Ubuntu 24.04 |
| Shell | bash (interactive, with PS1) |
| Compiler (C) | gcc |
| Debugger | gdb |
| Tools | make, valgrind, strace, ltrace, vim, less, tree |
| Locale | `C.UTF-8` |

The terminal is a real TTY — supports interactive tools (gdb, REPL, scanf, etc.).

## Step Switching Behavior

When the learner navigates between steps:
- Editor tabs are replaced with the new step's `files`
- Files created by the learner via the "+" button in the previous step are NOT carried over
- The terminal session persists (state like `cd`, environment variables, running processes survive)
- `/tmp/` files persist across steps (useful for building on previous step's binary)

## Validation Checklist

Before delivering a tutorial, verify:

- [ ] JSON parses without error
- [ ] `id` matches the directory name
- [ ] `language` is one of the valid enum values
- [ ] Every step has `title`, `instructions`, and `files` (at least one file)
- [ ] Every file has `name` and `content`
- [ ] `run_cmd` (if present) references correct file paths (`/home/student/workspace/<name>`)
- [ ] Code strings are properly escaped (`\n` → `\\n`, `"` → `\"`)
- [ ] No emoji in `instructions` or code comments
- [ ] Each step teaches one concept
- [ ] Code includes TODO markers for learner interaction
- [ ] Output binaries use `/tmp/` not workspace
