---
name: multilab-tutorial-generator
description: Generate MultiLab tutorials using the current multilab.json manifest format. Use when asked to create, write, convert, or add a MultiLab tutorial. Output a tutorial directory with multilab.json, steps/<id>/instructions.md, steps/<id>/files/, and command scripts referenced by manifest commands.
agent_created: true
---

# MultiLab Tutorial Generator

Generate a complete MultiLab tutorial directory using the current package standard.

Do not generate `tutorial.json`.

## Output Structure

```text
tutorials/<id>/
  multilab.json
  assets/
  steps/
    01-<slug>/
      instructions.md
      files/
        <editable files>
      commands/
        run.sh
        test.sh
```

Command scripts may live directly under the step directory only when editing an existing tutorial that already does so. New tutorials should use `commands/`.

## Workflow

1. Identify the learning goal, target language, step count, and whether terminal interaction is required.
2. Design the step sequence before writing files.
3. Choose `inherit_mode` for each step:
   - `template` for independent exercises.
   - `previous_save` for continuous projects.
   - `overlay_template` when a later project step adds new files.
4. Write `multilab.json`.
5. Write `instructions.md`, starter files, and command scripts.
6. Run:

```bash
python3 docs/tutorial-skill/scripts/validate_tutorial.py <tutorial-dir>
```

7. Fix all errors before delivering.

## Manifest Requirements

`multilab.json` must include:

- `schema_version`
- `id`
- `version`
- `title`
- `description`
- `language`
- `runtime_requirements`
- `steps`

Each step must include:

- `id`
- `title`
- `inherit_mode`
- `commands`

Each command should include:

- `id`
- `type`
- `label`
- `script`
- `terminal`
- `timeout_sec`

Supported command types:

- `setup`
- `run`
- `test`
- `check`
- `preview`
- `cleanup`

## Command Rules

Use `terminal: "interactive"` for commands that should run in the persistent terminal, usually `run`.

Use `terminal: "captured"` for commands that should return structured output, usually `test` or `check`.

For C/C++ run commands, reference workspace files with absolute container paths:

```bash
gcc /home/student/workspace/main.c -o /tmp/a.out -Wall && /tmp/a.out
```

For test commands, relative paths are acceptable because tests execute with cwd:

```text
/home/student/workspace
```

Put compiled binaries and temporary files under `/tmp`.

## Authoring Rules

- Do not create `tutorial.json`.
- Do not inline instructions, source files, or scripts in `multilab.json`.
- Use real Markdown in `instructions.md`.
- Put diagrams in `assets/` or beside `instructions.md`; use package-relative `png`/`jpeg`/`gif`/`webp`/`bmp`/`svg` paths (`![alt](assets/flow.svg)`). Do not paste inline `<svg>` into Markdown HTML.
- Tag copyable shell examples as `bash` fences.
- Use real editable files under `files/`.
- Use command scripts referenced from `commands[]`.
- Keep each step focused.
- Add TODO markers where learners should edit.
- Use semantic step ids, for example `01-first-program`.
- Avoid emoji and decorative Unicode.
- Prefer short instructions that fit the left panel.

## Reference Files

- `references/tutorial-format.md`: concise schema reference.
- `assets/tutorial-template/`: copyable starter tutorial.
- `scripts/validate_tutorial.py`: validator.
