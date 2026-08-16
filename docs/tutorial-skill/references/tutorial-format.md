# MultiLab Tutorial Format Reference

Current format: `multilab.json` manifest plus real files.

There is no supported `tutorial.json` format.

## Directory

```text
tutorials/<id>/
  multilab.json
  assets/
  steps/
    01-<slug>/
      instructions.md
      files/
        main.c
      commands/
        run.sh
        test.sh
```

## Top-Level Manifest Fields

Required:

- `schema_version`: integer, currently `1`.
- `id`: package id, should match directory name.
- `version`: semver-like package version.
- `title`: display title.
- `description`: short description.
- `language`: primary language, for example `c`, `cpp`, `python`, `javascript`, `shell`, `rust`, `go`.
- `steps`: ordered step array.

Recommended:

- `runtime_requirements`
- `recommended_kernel`
- `security`
- `default_panels`

`default_panels` names which windows the package needs (`tutorial`, `editor`, `terminal`, `web-preview`, `file-tree`, `test-results`). It does not set geometry. The player auto-layouts: tutorial nailed left, editor and preview side by side when both are needed, terminal at the bottom of the work area, file-tree as an editor accessory. Logs and diagnostics are host chrome, not package windows. `area` is stored for compatibility and ignored.

## Runtime Requirements

Example:

```json
{
  "platform": "linux",
  "commands": {
    "gcc": ">=13",
    "gdb": ">=14",
    "bash": ">=5"
  },
  "capabilities": ["tty", "compile", "debug", "signals"]
}
```

This describes what kind of kernel/runtime can run the tutorial. It does not itself install the runtime.

## Step Fields

Required:

- `id`
- `title`
- `inherit_mode`
- `commands`

Optional:

- `chain`
- `entry_file`

## `inherit_mode`

- `template`: use this step's own starter files.
- `previous_save`: inherit the previous save in the same chain.
- `overlay_template`: inherit previous save and add missing files from this step's template.

## Commands

Example:

```json
{
  "id": "run",
  "type": "run",
  "label": "Run",
  "script": "steps/01-example/commands/run.sh",
  "terminal": "interactive",
  "timeout_sec": 10
}
```

Valid command types:

- `setup`
- `run`
- `test`
- `check`
- `preview`
- `cleanup`

Valid terminal modes:

- `interactive`
- `captured`

Script paths must be relative to the tutorial root and must not escape the package directory.

## Example Manifest

```json
{
  "schema_version": 1,
  "id": "hello-c",
  "version": "1.0.0",
  "title": "Hello, C",
  "description": "Compile and run a C program.",
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

## Markdown And Assets

`instructions.md` is GFM Markdown. The player sanitizes HTML, makes fenced code copyable, and loads images from the package:

- `![alt](assets/overview.png)` resolves at the package root, or `![alt](diagram.png)` next to the step.
- Allowed image types: png, jpeg, gif, webp, bmp, svg. Use `![alt](assets/flow.svg)`. Inline `<svg>` HTML is stripped; package SVG files are shown as images.
- Remote `http(s)` images are not loaded.
- Tag shell examples as `bash` so they are copyable command fences. The player does not display the language name.

## Validation

```bash
python3 docs/tutorial-skill/scripts/validate_tutorial.py <tutorial-dir>
```
