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
  PackageService
  SaveService
  CommandService
  TrustStore
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

Package loading is handled by `server/services/PackageService.js`. It owns manifest loading, deterministic package digest calculation, step content assembly, and command script lookup.

The server loads a tutorial with this flow:

```text
GET /api/tutorials/:id
  PackageService reads multilab.json
  PackageService computes package_digest
  for each step:
    read instructions.md
    read files/*
    return commands[] metadata without script contents
```

Scripts are not inlined into the API response. Execution endpoints ask `PackageService` to resolve and read the selected command script when invoked.

## Packaging

Tutorial directories can be packed into a `.mlab` ZIP package with:

```bash
python3 docs/tutorial-skill/scripts/pack_mlab.py <tutorial-dir> -o <package.mlab>
```

The packer runs the validator first, writes package files at the ZIP root, and prints the same deterministic `sha256:<hex>` package digest used by save identity. Importing or opening `.mlab` files directly is not implemented yet.

Packages can also be safely unpacked into a tutorial directory with:

```bash
python3 docs/tutorial-skill/scripts/unpack_mlab.py <package.mlab> -o <tutorial-dir>
```

The unpacker rejects unsafe zip paths, extracts into a temporary directory, validates the extracted tutorial, and only then moves it into place.

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

Command execution is coordinated by `server/services/CommandService.js`. It asks `PackageService` to resolve the declared script, uploads that script through `RuntimeSession`, and dispatches to either captured execution or an attached interactive terminal.

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

Step load/save/reset is handled by `server/services/SaveService.js`. It owns save identity paths, host save file IO, first-entry inheritance, reset behavior, and workspace synchronization through `RuntimeSession`.

## Save Storage

Current prototype saves are stored under `.multilab-state`, but the identity now includes package id, version, and digest:

```text
multilab/.multilab-state/saves/<id>/<version>/<digest>/steps/<step>/files/
```

The digest is a deterministic `sha256:<hex>` over the tutorial package directory contents. The filesystem path uses a safe `sha256-<hex>` segment.

The final product storage root is documented in the root spec:

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
- package trust defaults to `untrusted` and is stored by package digest under `.multilab-state/trust.json`.

Target security model:

- trust state per package digest;
- sandbox-capable kernel required by default for untrusted packages;
- Docker provider as first official sandbox provider;
- future provider abstraction for WSL/local/remote/Wasm/VM.

Current trust APIs:

```text
GET  /api/trust?package_digest=<sha256:...>
POST /api/trust { package_digest, trust }
```

The user-settable trust values are currently `untrusted` and `user-trusted`.

## Known Limitations

- Docker is still the only implemented provider.
- `.mlab` pack/unpack CLI is implemented; app-level import/open is not implemented.
- Panel declarations are present in manifests but not fully rendered dynamically.
- The Docker container is single-session and not suitable for multi-user deployment.
