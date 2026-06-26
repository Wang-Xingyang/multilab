---
name: multilab-tutorial-generator
description: Generate MultiLab interactive tutorial JSON files. This skill should be used when the user asks to create, write, or generate a tutorial for MultiLab (e.g., "帮我写一个 C 指针教程", "生成一个 Python 列表教程", "给 MultiLab 写个 gdb 调试教程"). Also triggers on requests to add new tutorials to a MultiLab project, or when converting teaching material into MultiLab tutorial format. Outputs a valid tutorial.json file under tutorials/{id}/.
agent_created: true
---

# MultiLab Tutorial Generator

## Overview

Generate MultiLab interactive tutorial JSON files. MultiLab is a local interactive learning environment where the left panel shows Markdown instructions, the right panel has a Monaco code editor with file tabs, and a real TTY terminal connected to a Docker container running Linux. Tutorials are static JSON files that define steps, each with Markdown instructions, initial code files, and a run command.

## When to Use

Trigger this skill when the user asks to:
- Create or write a new MultiLab tutorial (e.g., "写一个 C 数组教程")
- Generate a tutorial from a topic or learning objective
- Convert teaching material (lecture notes, exercises) into MultiLab format
- Add a new tutorial to an existing MultiLab project

## Output Specification

The final output is always a single JSON file at `tutorials/<id>/tutorial.json` inside the MultiLab project repository. All tutorial content (instructions, code, run commands) is inlined in this JSON — no external code files.

## Workflow

### 1. Gather Requirements

If the user's request is vague, ask clarifying questions (one at a time, max 2-3 total):
- Target language (C / Python / Shell / etc.)
- Number of steps and learning objectives
- Whether it needs interactive terminal features (gdb, REPL)
- Target audience level (beginner / intermediate / advanced)

If the request is specific enough (e.g., "写个 C 指针入门教程, 3 步"), skip clarification and proceed.

### 2. Design the Tutorial Structure

Plan the step sequence before writing JSON. Each step must teach exactly one concept. A good progression:

1. **Introduce** — show a minimal working example, let learner run it
2. **Practice** — give a TODO for learner to modify the code
3. **Challenge** — give a debugging exercise or open-ended task

Sketch the steps on paper (or in the response) before encoding to JSON.

### 3. Generate the JSON File

Write the tutorial to `tutorials/<id>/tutorial.json`. Follow the format spec in `references/tutorial-format.md` exactly. Use the template in `assets/tutorial-template.json` as the starting point.

Key encoding rules:
- All strings must be valid JSON (escape `\n` as `\\n`, `"` as `\\"`, `\` as `\\\\`)
- Code goes in the `content` field of each file object, NOT in a separate file
- File paths in `run_cmd` must be the full container path: `/home/student/workspace/<filename>`
- Output binaries go to `/tmp/` (e.g., `/tmp/a.out`) to avoid polluting the workspace

### 4. Validate

After writing, run the validation script to catch common errors:

```bash
python docs/tutorial-skill/scripts/validate_tutorial.py "<path-to-tutorial.json>"
```

The script checks: JSON syntax, required fields, file path consistency, language enum, and common encoding mistakes. Fix any errors reported before delivering to the user.

### 5. Manual Sanity Check

Mentally walk through each step:
- Does the `run_cmd` actually compile/run the file in `files[0].name`?
- Are there TODO comments guiding the learner to modify code?
- Is the Markdown instruction concise (fits in left panel)?
- Does each step build on the previous one?

## Authoring Rules (Mandatory)

1. **JSON must be valid** — verify with `python3 -c "import json; json.load(open('path'))"`.
2. **File paths** — code lives at `/home/student/workspace/<filename>`. `run_cmd` must reference this full path.
3. **language enum** — top-level `language` must be one of: `c`, `cpp`, `javascript`, `python`, `shell`, `rust`, `go` (lowercase). File-level `language` can be omitted (inherits from tutorial).
4. **instructions is Markdown** — use `#`/`##` for headings, fenced code blocks for examples, lists for steps. Do NOT use HTML tags.
5. **One concept per step** — never combine unrelated topics in a single step.
6. **Code has TODOs** — mark places where the learner should modify with `// TODO:` (C/C++/JS) or `# TODO:` (Python/Shell). Don't give complete answers.
7. **run_cmd must be runnable** — commands execute as `student` user in the container. C: `gcc ... -o /tmp/a.out && /tmp/a.out`. Python: `python3 <path>`. Shell: `bash <path>`.
8. **No emoji** — do not use emoji or unicode symbols in `instructions` or code comments. Use plain text.
9. **Multi-file support** — `files` array can contain multiple files. They appear as tabs in the editor. `run_cmd` must explicitly reference all files needed for compilation (e.g., `gcc main.c utils.c -o /tmp/a.out`).
10. **Semantic filenames** — use `hello.c`, `args.c`, `buggy.c`, not `main1.c`, `main2.c`.

## run_cmd Defaults

If a step omits `run_cmd`, MultiLab infers from the tutorial's `language`:

| language | default command |
|---|---|
| `c` | `gcc /home/student/workspace/<file> -o /tmp/a.out -Wall && /tmp/a.out` |
| `cpp` | `g++ /home/student/workspace/<file> -o /tmp/a.out -Wall && /tmp/a.out` |
| `javascript` | `node /home/student/workspace/<file>` |
| `python` | `python3 /home/student/workspace/<file>` |
| `shell` | `bash /home/student/workspace/<file>` |

Only set `run_cmd` explicitly when:
- Passing command-line arguments (`./a.out foo bar`)
- Need debug symbols (`-g` for gdb)
- Compiling multiple files
- Adding a post-run hint (`&& echo '...'`)

## Interactive Terminal Guidance

MultiLab's terminal is a real TTY running a persistent bash shell. Learners can type `ls`, `gcc`, `gdb`, etc. at any time. Use this in instructions:

```markdown
## 试试这个

1. 点运行编译程序
2. 在终端里输入:
   ```
   gdb /tmp/a.out
   ```
3. 进入 gdb 后输入 `break main` 设断点
4. 输入 `run` 启动程序
5. 输入 `next` 单步执行
```

This works for: gdb, python REPL, interactive scripts (scanf, input()), less, vim, etc.

## Resources

### references/tutorial-format.md

Complete field reference for the tutorial JSON schema. Load this when unsure about field types, required vs optional, or valid values. Contains the full schema with examples.

### assets/tutorial-template.json

A copy-paste starting template. Has the correct structure with placeholder content — replace the placeholders with actual tutorial content.

### scripts/validate_tutorial.py

Validation script. Run after writing the JSON to catch:
- JSON syntax errors
- Missing required fields
- `run_cmd` file path mismatches
- Invalid `language` values
- Common escape errors

Usage:
```bash
python docs/tutorial-skill/scripts/validate_tutorial.py "<path-to-tutorial.json>"
```

## Example Output

A minimal valid tutorial (single step, single file):

```json
{
  "id": "hello-c",
  "title": "Hello, C",
  "description": "第一个 C 程序",
  "language": "c",
  "steps": [
    {
      "title": "Hello World",
      "instructions": "# Hello, C\n\n点右上角的运行按钮,看看会发生什么。\n\n## 任务\n\n把 `name` 变量改成你的名字,再运行一次。",
      "files": [
        {
          "name": "hello.c",
          "language": "c",
          "content": "#include <stdio.h>\n\nint main(void) {\n    const char *name = \"Student\";\n    printf(\"Hello, %s!\\n\", name);\n    return 0;\n}\n"
        }
      ],
      "run_cmd": "gcc /home/student/workspace/hello.c -o /tmp/a.out -Wall && /tmp/a.out"
    }
  ]
}
```

## Common Mistakes to Avoid

1. **Forgetting JSON escaping** — code with `printf("Hello\n")` must be written as `"printf(\"Hello\\n\")"` in the JSON.
2. **Wrong file path in run_cmd** — using `hello.c` instead of `/home/student/workspace/hello.c`.
3. **Overly long instructions** — left panel is narrow; keep each step's instructions under ~200 words.
4. **No TODOs** — giving complete code with no place for learner to modify defeats the purpose.
5. **Multiple concepts per step** — splitting "variables + loops + functions" into one step; split into three steps instead.
6. **Emoji in instructions** — keep it plain text, no emoji or unicode symbols.
7. **Output binary in workspace** — using `gcc hello.c -o hello` pollutes the workspace; use `-o /tmp/a.out` instead.
