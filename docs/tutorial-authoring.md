# Tutorial Authoring Guide

MultiLab tutorials are authored as directories and must contain a `multilab.json` manifest.

There is no supported `tutorial.json` format.

## Directory Structure

```text
tutorials/<id>/
  multilab.json
  assets/                 # optional diagrams/screenshots (png/jpeg/gif/webp/bmp/svg)
  steps/
    01-<slug>/
      instructions.md
      files/
        <editable files>
      commands/
        run.sh
        test.sh
```

Existing tutorials may keep command scripts directly under the step directory, but new tutorials should use `commands/`.

## Minimal Manifest

```json
{
  "schema_version": 1,
  "id": "hello-c",
  "version": "1.0.0",
  "title": "Hello, C",
  "description": "Compile and run your first C program.",
  "language": "c",
  "runtime_requirements": {
    "platform": "linux",
    "commands": {
      "gcc": ">=13",
      "bash": ">=5"
    },
    "capabilities": ["tty", "compile"]
  },
  "recommended_kernel": "gcc-ubuntu24-docker",
  "security": {
    "sandbox_required": true,
    "network_required": false,
    "trust": "local-authored"
  },
  "steps": [
    {
      "id": "01-hello",
      "title": "Hello World",
      "inherit_mode": "template",
      "entry_file": "hello.c",
      "commands": [
        {
          "id": "run",
          "type": "run",
          "label": "Run",
          "script": "steps/01-hello/commands/run.sh",
          "terminal": "interactive",
          "timeout_sec": 10
        },
        {
          "id": "test",
          "type": "test",
          "label": "Check",
          "script": "steps/01-hello/commands/test.sh",
          "terminal": "captured",
          "timeout_sec": 10
        }
      ]
    }
  ]
}
```

## Required Top-Level Fields

- `schema_version`: currently `1`.
- `id`: directory id, lowercase kebab-case.
- `version`: package version.
- `title`: display title.
- `description`: short description.
- `language`: primary language for editor defaults.
- `steps`: ordered step list.

Strongly recommended:

- `runtime_requirements`
- `recommended_kernel`
- `security`

## Step Fields

Required:

- `id`: must match `steps/<id>/`.
- `title`: display title.
- `inherit_mode`: one of `template`, `previous_save`, `overlay_template`.
- `commands`: command declarations.

Optional:

- `chain`: group id for continuous projects.
- `entry_file`: default editor tab when this step has no saved UI state. The player does not open every workspace file.

## `inherit_mode`

`inherit_mode` controls how a step initializes on first entry.

```text
template
  Use this step's own files.
  Good for independent exercises.

previous_save
  Use the nearest previous save in the same chain.
  Good for continuous projects.

overlay_template
  Use previous save, then add missing files from this step's template.
  Good when a later project step introduces new assets.
```

Current implementation does not overwrite learner files during `overlay_template`.

Package template files are read-only learning material. Learner edits live in the workspace and persist into the save. Command scripts still run against the runtime workspace path (currently `/home/student/workspace` for Docker kernels).

## Markdown And Assets

`instructions.md` is rendered in the left tutorial panel. `default_panels` declares which primitives this package needs; a step may set `panels` to show a different subset. The player chooses the layout. Do not try to encode window geometry in the manifest.

Supported content:

- GFM Markdown (headings, lists, tables, quotes, emphasis, links, images, fenced code).
- Restricted HTML through the player's sanitizer. Do not rely on `<script>`, `<iframe>`, `<form>`, inline `<svg>`, or event-handler attributes; they are stripped.
- Package-relative images: `png`, `jpeg`, `gif`, `webp`, `bmp`, `svg`. Use `![alt](assets/flow.svg)`. Do not paste inline `<svg>` into Markdown HTML.

Image paths are resolved relative to the step directory first, then the package root:

```text
![Diagram](diagram.png)           # steps/<id>/diagram.png
![Overview](assets/overview.png)  # <package>/assets/overview.png
![Flow](assets/flow.svg)          # SVG via <img>, not inline <svg> HTML
```

Remote `http(s)` images are not loaded. Put screenshots in the package so the tutorial stays local-first.

Fenced code blocks are copyable. A `bash` fence is still useful so authors and tools know it is a shell example; the player does not show the language name:

```bash
gcc /home/student/workspace/hello.c -o /tmp/a.out -Wall && /tmp/a.out
```

External `http(s)` and `mailto:` links open in a new tab. Do not use relative links to other package files as navigation; they are shown as text.

The validator warns when Markdown images are missing, escape the package, use an unsupported type, or point at a remote URL.

## Commands

Commands are declared in `multilab.json`; scripts live in real files.

Supported command types:

- `setup`
- `run`
- `test`
- `check`
- `preview`
- `cleanup`

Execution modes:

```text
interactive
  Runs through the persistent terminal shell.

captured
  Runs through /api/commands/run and returns stdout/stderr/exitCode.
```

Example run command:

```json
{
  "id": "run",
  "type": "run",
  "label": "Run",
  "script": "steps/01-hello/commands/run.sh",
  "terminal": "interactive",
  "timeout_sec": 10
}
```

Example `run.sh`:

```bash
gcc /home/student/workspace/hello.c -o /tmp/a.out -Wall && /tmp/a.out
```

Example test command:

```json
{
  "id": "test",
  "type": "test",
  "label": "Check",
  "script": "steps/01-hello/commands/test.sh",
  "terminal": "captured",
  "timeout_sec": 10
}
```

Example `test.sh`:

```bash
#!/bin/bash
set -e
gcc hello.c -o /tmp/test.out -Wall
output=$(/tmp/test.out)
echo "$output" | grep -q "Hello"
```

Captured test commands pass when exit code is `0`.

## Preview

The preview column is an isolated iframe, not a React/algorithm engine.

**HTML (prefer for visualizations).** Use `type: "preview"` with `terminal: "captured"`. Print `MULTILAB_PREVIEW_HTML` then a complete HTML document (inline CSS/JS). The player loads it with `sandbox="allow-scripts"`. For Dijkstra-style walkthroughs, put 单步 / 播放 / 重置 **in that page**. The player has no host stepper.

The lab only sees workspace files. Put `viz.html` in the step `files/` and cat it:

```bash
#!/bin/bash
echo MULTILAB_PREVIEW_HTML
cat /home/student/workspace/viz.html
```

Or have the script run the learner program, emit a trace, and wrap it in HTML.

**Live URL.** Print `MULTILAB_PREVIEW_URL=http://127.0.0.1:5173/` from a lab dev server. Declare `security.network_required` or `security.preview_ports` so the kernel can publish the port. Use this for student React apps, not for simple animations.

A lecture step can declare `"panels": ["tutorial", "web-preview"]` so the editor and terminal stay closed until a later coding step.

## Authoring Rules

- Use `multilab.json`, never `tutorial.json`.
- Keep instructions in `instructions.md`.
- Keep images under `assets/` at the package root or next to `instructions.md`. Reference them with package- or step-relative paths, not `http(s)` URLs.
- Keep editable starter files in `files/`.
- Keep command scripts as real files referenced by manifest commands.
- Do not inline instructions, source files, or scripts into the manifest.
- Use `/home/student/workspace/<file>` in interactive run scripts.
- Put build artifacts in `/tmp`, not in the workspace.
- Keep each step focused on one concept.
- Add TODO markers where the learner should edit.
- Prefer semantic ids such as `01-first-program`.
- Use step `panels` when a lecture step should hide the editor, or a coding step should hide preview.
- Do not use emoji or decorative Unicode in tutorial text or code comments.

## Validation

```bash
cd multilab
python3 docs/tutorial-skill/scripts/validate_tutorial.py ../tutorials/hello-c
```

The validator checks:

- `multilab.json` syntax and required fields;
- step directories;
- `instructions.md`;
- `files/`;
- command types;
- command script paths;
- `inherit_mode`;
- Markdown image paths (missing / escape / unsupported type / remote URL warnings);
- common path and output mistakes.

## Packing

```bash
cd multilab
python3 docs/tutorial-skill/scripts/pack_mlab.py ../tutorials/hello-c -o /tmp/hello-c.mlab
```

The packer validates the tutorial first, writes a `.mlab` ZIP package, and prints the deterministic package digest used by save identity.

To unpack a `.mlab` package back into a tutorial directory:

```bash
python3 docs/tutorial-skill/scripts/unpack_mlab.py /tmp/hello-c.mlab -o /tmp/hello-c-unpacked
```

The unpacker checks zip paths, extracts into a temporary directory, validates the extracted tutorial, and then moves it into place.

## Recommended AI Workflow

1. Generate a tutorial directory.
2. Write `multilab.json`.
3. Write step `instructions.md`, `files/`, and `commands/`.
4. Run the validator.
5. Pack the tutorial into `.mlab` when it is ready to share.
6. Manually inspect command scripts.
7. Import or run in MultiLab.
