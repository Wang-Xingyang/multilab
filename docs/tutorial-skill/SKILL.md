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
2. Design the step sequence before writing files. Decide which windows each step needs (`default_panels` plus optional per-step `panels`).
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
- `inherit_mode` (`template` / `previous_save` / `overlay_template`)
- `needs_edit` (default true; `false` for lecture/demo, which never get an archive)
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

Use `terminal: "interactive"` for commands that should run in a dedicated command PTY, usually `run`. The player ends that PTY when the process exits; a finite `gcc && ./a.out` does not need Ctrl+C. Keep stdin-holding programs (gdb, servers, REPLs) only when the step is actually interactive. When a step is not editable, the persistent bash accepts no stdin. Lecture/demo Preview still works; exercise Run / Test / Preview stay disabled until every previous tutorial step is currently complete.

Use `terminal: "captured"` for commands that should return structured output, usually `test` or `check`. Captured stdout/stderr appears in the 检查结果 editor tab, not the persistent terminal. Pass/fail is a toast; do not assume learners will see `echo PASS` in xterm.

For C/C++ run commands, reference workspace files with absolute container paths:

```bash
gcc /home/student/workspace/main.c -o /tmp/a.out -Wall && /tmp/a.out
```

For test commands, relative paths are acceptable because tests execute with cwd:

```text
/home/student/workspace
```

Put compiled binaries and other temp files under `/tmp` so they stay out of the workspace file tree and step archive. The player also uploads command scripts to `/tmp/<step>.<cmd>.sh`; never mention that path in `instructions.md`. If a step tells the learner to run gdb on the run product, the path in the Markdown must match `run.sh` (hello-c uses `gdb /tmp/a.out`). Compiling to `./a.out` in the workspace is allowed, but the binary will show in the file tree and be saved (the completeness hash still ignores `a.out`).

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
- Declare `default_panels` as the windows this tutorial needs (`tutorial`, `editor`, `terminal`, `web-preview`, `file-tree`, `test-results`). Do not encode layout geometry; the player places tutorial left, editor | preview as peer columns, terminal at the bottom, and file-tree on the right of the editor (not as a third workspace column).
- Optional per-step `panels` replaces that default for one step (same type names, or strings like `["tutorial", "web-preview"]`). Omit it to inherit the package set. Logs and diagnostics are host chrome, not step windows.

## Preview

Two captured-preview shapes:

1. **HTML** (prefer for visualizations): `terminal: "captured"`. The script prints `MULTILAB_PREVIEW_HTML` then a self-contained HTML document. The player shows it in a sandboxed iframe (`allow-scripts` only).
2. **Live URL** (React/Vite and similar): the lab process prints `MULTILAB_PREVIEW_URL=http://...` and the package declares network / `preview_ports`.

Algorithm walkthroughs belong in that HTML page. Put 单步 / 播放 / 重置 **inside the iframe**. The player has no host stepper and does not talk to the preview with `postMessage`. Ship `viz.html` in the step `files/` and `cat` it from `preview.sh`, or generate HTML from a trace your script produces. Keep CSS/JS inline; package `assets/` are for tutorial Markdown images, not for the lab filesystem.

Example lecture step:

```json
{
  "id": "01-trace",
  "title": "Watch Dijkstra",
  "inherit_mode": "template",
  "panels": ["tutorial", "web-preview"],
  "commands": [
    {
      "id": "preview",
      "type": "preview",
      "label": "Preview",
      "script": "steps/01-trace/commands/preview.sh",
      "terminal": "captured",
      "timeout_sec": 10
    }
  ]
}
```

A later coding step can omit `web-preview` and list `tutorial`, `editor`, and `terminal` instead.

## Reference Files

- `references/tutorial-format.md`: concise schema reference.
- `assets/tutorial-template/`: copyable starter tutorial.
- `scripts/validate_tutorial.py`: validator.
