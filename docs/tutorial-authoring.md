# Tutorial Authoring Guide

MultiLab tutorials are authored as directories and must contain a `multilab.json` manifest.

There is no supported `tutorial.json` format.

## Directory Structure

```text
tutorials/<id>/
  multilab.json
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
- `entry_file`: default file to open.

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

## Authoring Rules

- Use `multilab.json`, never `tutorial.json`.
- Keep instructions in `instructions.md`.
- Keep editable starter files in `files/`.
- Keep command scripts as real files referenced by manifest commands.
- Do not inline instructions, source files, or scripts into the manifest.
- Use `/home/student/workspace/<file>` in interactive run scripts.
- Put build artifacts in `/tmp`, not in the workspace.
- Keep each step focused on one concept.
- Add TODO markers where the learner should edit.
- Prefer semantic ids such as `01-first-program`.
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
- common path and output mistakes.

## Recommended AI Workflow

1. Generate a tutorial directory.
2. Write `multilab.json`.
3. Write step `instructions.md`, `files/`, and `commands/`.
4. Run the validator.
5. Manually inspect command scripts.
6. Import or run in MultiLab.
