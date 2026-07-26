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
  PackageLibrary
  SaveService
  MlabSaveArchiveService
  CommandService
  SecurityPolicyService
  TrustStore
  KernelRegistry
  RuntimeProvider abstraction

Docker runtime
  Ubuntu 24.04
  student user
  /home/student/workspace
  gcc/gdb/make/valgrind/strace
```

Docker is currently the only implemented provider. It now sits behind a small `RuntimeProvider` abstraction so API and WebSocket logic do not manage Docker containers directly.

## Tutorial Loading

Each tutorial source must contain `multilab.json`. The current host supports two source types:

- `development`: an authoring directory under `TUTORIALS_DIR/<id>`.
- `installed`: an imported package under `.multilab-state/packages/<id>/<version>/<digest>/unpacked/`.

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

Package loading is handled by `server/services/PackageService.js`. It owns package source resolution, manifest loading, deterministic package digest calculation, step content assembly, and command script lookup.

The server loads a tutorial with this flow:

```text
GET /api/tutorials/:source_key
  PackageService resolves source_key
  PackageService reads multilab.json
  PackageService computes package_digest
  for each step:
    read instructions.md
    read files/*
    return commands[] metadata without script contents
```

Development tutorials keep their original id as the source key, so `/api/tutorials/hello-c` continues to open `TUTORIALS_DIR/hello-c`. Installed packages use a digest-derived source key such as `pkg-<sha256hex>` to avoid collisions when multiple packages share the same manifest id.

Scripts are not inlined into the API response. Execution endpoints ask `PackageService` to resolve and read the selected command script when invoked.

## Packaging

Tutorial directories can be packed into a `.mlab` ZIP package with:

```bash
python3 docs/tutorial-skill/scripts/pack_mlab.py <tutorial-dir> -o <package.mlab>
```

The packer runs the validator first, writes package files at the ZIP root, and prints the same deterministic `sha256:<hex>` package digest used by save identity.

Packages can also be safely unpacked into a tutorial directory with:

```bash
python3 docs/tutorial-skill/scripts/unpack_mlab.py <package.mlab> -o <tutorial-dir>
```

The unpacker rejects unsafe zip paths, extracts into a temporary directory, validates the extracted tutorial, and only then moves it into place.

The backend can import local `.mlab` files into a local package library:

```text
POST /api/packages/import { path }
GET  /api/packages
```

Imported packages are unpacked under:

```text
.multilab-state/packages/<id>/<version>/<digest>/unpacked/
```

`package.lock.json` records id, version, digest, source path, import time, file count, and unpacked directory. App-level package import supports two entry points:

```text
POST /api/packages/import { path }          # host-local path (API/dev)
POST /api/packages/upload                  # browser raw .mlab body + X-Filename
```

The UI "打开 .mlab" button uses browser file picker upload, imports into the package library, then opens the installed source by digest. Host-path import remains available for API/automation.

Imported packages are now included in `/api/tutorials` alongside development tutorials and can be opened by the player through their `source_key`.

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

Command execution is coordinated by `server/services/CommandService.js`. Before a command runs, it asks `SecurityPolicyService` to check package trust, the manifest security policy, and the kernel resolver result. It then asks `PackageService` to resolve the declared script, uploads that script through `RuntimeSession`, and dispatches to either captured execution or an attached interactive terminal.

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

`SaveService` also writes progress metadata at:

```text
multilab/.multilab-state/saves/<id>/<version>/<digest>/save.json
```

Current metadata tracks package identity, `current_step`, visited steps, test pass/fail state per step, and `updated_at`. Step load/save/reset records the current step as visited. Captured commands with `type: "test"` update `test_passed[step]`.

Learner saves can be exported and imported as `.mlab-save` ZIP archives through `MlabSaveArchiveService`:

```text
POST /api/saves/export { tutorial, path }
POST /api/saves/import { path }
```

Archive layout:

```text
save.json
steps/<step-id>/files/<file>
```

The archive references package `id` / `version` / `digest` and does not embed the tutorial package. Import requires a matching development or installed package source; if none exists, the API returns `code: "package_missing"` and asks the user to open/import the original `.mlab` first.

Save archive browser APIs:

```text
POST /api/saves/download { tutorial }      # browser download of .mlab-save
POST /api/saves/upload                     # browser raw .mlab-save body + X-Filename
POST /api/saves/export { tutorial, path }  # host-local path export
POST /api/saves/import { path }            # host-local path import
```

The UI uses file picker upload for import and browser download for export. Host-path APIs remain for automation.

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

Current command execution policy:

- command execution requires a compatible resolved kernel;
- `untrusted` packages require a sandbox-capable kernel;
- packages with `security.sandbox_required: true` require a sandbox-capable kernel even when user-trusted;
- packages that do not require network access require a selected kernel whose `network_default` is `none`;
- packages that require network access are rejected until a network-capable selected kernel/runtime path exists.

This policy currently guards command execution, but it does not yet dynamically select a runtime provider or change Docker network settings.

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

The frontend shows the current package trust state in the header and lets the user toggle between these two values. This persists trust metadata only; runtime selection, sandbox enforcement, and network policy enforcement are still future work.

## Kernel Registry

The first implementation registers the current Docker runtime as an explicit kernel:

```text
gcc-ubuntu24-docker
  provider: docker
  image: multilab/os:latest
  platform: linux
  capabilities: tty, compile, debug, signals, sandbox
  network_default: none
```

Current kernel APIs:

```text
GET /api/kernels
GET /api/kernels/resolve?tutorial=<id>
```

The resolver currently checks required platform, capabilities, command names, and simple command version constraints such as `>=13`, then prefers `recommended_kernel`. It returns `version_mismatches` for incompatible command versions. It does not yet enforce runtime selection or support complex semver ranges.

## Known Limitations

- Docker is still the only implemented provider.
- `.mlab` pack/unpack CLI, host-path import, and browser upload/open are implemented.
- `.mlab-save` host-path export/import and browser upload/download are implemented.
- Kernel registry is static and only contains the default Docker kernel.
- Runtime provider selection is not yet driven by the selected kernel.
- Panel declarations are present in manifests but not fully rendered dynamically.
- The Docker container is single-session and not suitable for multi-user deployment.
