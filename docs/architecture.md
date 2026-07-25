# Architecture

This document describes the current MultiLab prototype after the `multilab.json` migration.

For the full target product architecture, see:

```text
../../MULTILAB_PRODUCT_ARCHITECTURE_SPEC.md
```

## Product Shape

MultiLab is an interactive tutorial player:

```text
tutorial package
  declares content, steps, commands, runtime requirements, and panels

MultiLab host
  loads packages, manages saves, selects/runs commands, and renders the UI

runtime session
  executes commands and provides a terminal, currently through Docker
```

The current code is still a compact prototype, but new work should follow this direction.

## Runtime Layers

```text
Browser UI
  Monaco editor
  xterm.js terminal
  tutorial Markdown

Node host
  Express APIs
  WebSocket terminal bridge
  tutorial loader
  step save state
  command executor
  RuntimeProvider abstraction

Docker runtime
  Ubuntu 24.04
  student user
  /home/student/workspace
  gcc/gdb/make/valgrind/strace
```

Docker is currently the only implemented provider. It now sits behind a small `RuntimeProvider` abstraction so API and WebSocket logic do not manage Docker containers directly.

## Tutorial Loading

Each tutorial directory must contain `multilab.json`.

```text
tutorials/hello-c/
  multilab.json
  steps/
    01-first-program/
      instructions.md
      files/
        hello.c
      run.sh
      test.sh
```

The server loads a tutorial with this flow:

```text
GET /api/tutorials/:id
  read multilab.json
  for each step:
    read instructions.md
    read files/*
    return commands[] metadata without script contents
```

Scripts are not inlined into the API response. Execution endpoints read scripts from disk when invoked.

## Command Model

Commands are first-class manifest objects:

```json
{
  "id": "run",
  "type": "run",
  "label": "运行",
  "script": "steps/01-first-program/run.sh",
  "terminal": "interactive",
  "timeout_sec": 10
}
```

Supported command types in the validator:

- `setup`
- `run`
- `test`
- `check`
- `preview`
- `cleanup`

Current execution modes:

- `interactive`: executed through the WebSocket terminal.
- `captured`: executed through `POST /api/commands/run`.

### Interactive Command Flow

```text
User clicks Run
  frontend saveCurrentStep()
  frontend sends ws { type: "command", tutorial, step, command }
  backend loads command script from manifest
  backend writes script to /tmp/<step>.<command>.sh in the container
  backend writes "bash /tmp/<step>.<command>.sh" to the persistent shell
  xterm displays output
```

### Captured Command Flow

```text
User clicks Check
  frontend saveCurrentStep()
  frontend POST /api/commands/run
  backend loads command script
  backend writes script to /tmp/<step>.<command>.sh
  backend runs it with containerExec(["bash", remoteScript])
  backend returns stdout, stderr, exitCode, passed
```

The old `/api/test` and WebSocket `type: "run"` paths have been removed.

## Terminal Model

Each browser WebSocket connection starts a persistent interactive shell:

```text
bash --login -i
```

The shell runs as `student` in:

```text
/home/student/workspace
```

Terminal input is forwarded directly to shell stdin. This supports interactive tools such as gdb, REPLs, and programs that read stdin.

Docker hijack streams are decoded with dockerode's `container.modem.demuxStream()`.

## Step State

Each step has:

- `template`: package files under `steps/<id>/files/`;
- `save`: local saved files for the learner;
- `workspace`: files currently present in the runtime session;
- `inherit_mode`: first-entry initialization rule.

Supported `inherit_mode` values:

```text
template
  initialize from this step's own files

previous_save
  initialize from the nearest previous save in the same chain

overlay_template
  initialize from previous save, then add missing files from this step's template
```

Current implementation intentionally does not overwrite learner files during `overlay_template`.

## Save Storage

Current prototype saves are still stored under:

```text
multilab/.multilab-state/saves/<tutorial>/<step>/
```

Target product storage is documented in the root spec:

```text
~/.multilab/saves/<id>/<version>/<digest>/
```

Do not use Git as the live step state machine.

## Security Model

Current practical protections:

- code runs as non-root `student`;
- file APIs restrict paths to `/home/student/workspace`;
- tutorial scripts are loaded from package paths after path validation;
- test/check commands run inside the Docker runtime, not on the host.

Target security model:

- trust state per package digest;
- sandbox-capable kernel required by default for untrusted packages;
- Docker provider as first official sandbox provider;
- future provider abstraction for WSL/local/remote/Wasm/VM.

## Known Limitations

- Docker is still the only implemented provider.
- Save paths are not yet version/digest aware.
- `.mlab` pack/unpack is not implemented.
- Panel declarations are present in manifests but not fully rendered dynamically.
- The Docker container is single-session and not suitable for multi-user deployment.
