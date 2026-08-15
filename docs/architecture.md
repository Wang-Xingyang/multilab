# Architecture

This document describes the current MultiLab prototype after the `multilab.json` migration.

For the full target product architecture, see:

```text
../../MULTILAB_PRODUCT_ARCHITECTURE_SPEC.md
```

## Product Shape

MultiLab is an interactive tutorial player:

```text
tutorial package   read-only learning material (template files, scripts, markdown)
save bundle        durable learner-owned state on the player host (all steps + save.json)
workspace          live current-step files inside the Docker lab (`/home/student/workspace`)
runtime session    disposable Docker container (the lab machine)
```

The player is a Node frontend + backend on Windows or Linux. The lab machine is always a Docker container. The student's own WSL distro is not a kernel.

Host save is the source of truth. The lab only holds the current step:

- Linux ext4 (including Docker-on-WSL ext4): bind-mount the host save tree once; retarget `/home/student/workspace` at the current step `files/` directory (`mount --bind` when allowed, else a symlink). Same disk, no copy.
- Windows NTFS (and `/mnt/c`): copy only the current step into the container via `RuntimeSession.writeFiles` / `readFiles`. Do not bind-mount NTFS.

Save, run, step switch, exit, and export all flush the live workspace back into the host save for that step, then pack `.mlab-save` from the host save. `.mlab` is the tutorial; `.mlab-save` is progress.

The current code is still a compact prototype, but new work should follow this direction.

## Runtime Layers

```text
Browser UI
  Monaco editor
  xterm.js terminal
  tutorial Markdown
  editor-group tabs (files + preview / test-results / logs / diagnostics)

Node host
  Express APIs
  WebSocket terminal bridge
  PackageService
  PackageLibrary
  PanelModel
  SaveService
  WorkspaceService
  MlabSaveArchiveService
  CommandService
  SecurityPolicyService
  TrustStore
  KernelRegistry
  RuntimeManager
  RuntimeProvider abstraction

Docker runtime
  Ubuntu 24.04
  student user
  /home/student/workspace
  gcc/gdb/make/valgrind/strace
  NetworkMode/security options from selected kernel
```

Docker is the only registered lab provider. `RuntimeManager` selects it from the resolved kernel's `provider` field, then asks it to `planKernelSession`, `applyKernel`, and `startSession`. Every provider implements `probe(kernel)` and `capabilities()`; captured commands honor manifest `timeout_sec` through `RuntimeSession.runCaptured(script, { timeoutMs })`. `CommandService` / `SaveService` talk to this contract, not dockerode.

The workspace is logically owned by MultiLab through `WorkspaceService`. The physical IO strategy is `RuntimeProvider.workspaceStrategy`: bind-mount on Linux ext4, copy (`runtime-internal`) on Windows.

On Linux/WSL with a fast local filesystem (ext4/xfs/btrfs/tmpfs), Docker bind-mounts `.multilab-state/saves` to `/home/student/.mlab-saves` **once** at container start. Switching steps does not recreate that Docker bind. It retargets `/home/student/workspace` at the current step `files/` dir (`mount --bind` when the exec is allowed, otherwise a symlink). The learner-visible path stays `/home/student/workspace`; the physical `.mlab-saves/<id>/<version>/<digest>/...` tree must not appear in the shell prompt. `WorkspaceService` reads, writes, lists, and watches that save directory on the host. File-tree updates use host `fs.watch` on the bind source plus `find -H` polling as a safety net (content-only edits still do not fire). `find` without `-H` does not descend a symlink start path, so polling must pass `-H`.

The container `student` uid is aligned to the host process uid so terminal `mkdir` and host Node share ownership. `EACCES` during host clear still falls back to a container-root wipe.

Windows (NTFS) and Windows-drive mounts (`/mnt/c`) copy the **current step only** through `RuntimeSession.exec`. Override with `WORKSPACE_STRATEGY=bind-mount` or `WORKSPACE_STRATEGY=runtime-internal`. Do not bind-mount `/mnt/c`. Runtime kernels provide execution capability; they should not require a MultiLab-specific in-kernel agent.

Captured command scripts are uploaded through `RuntimeSession.tempScriptPath()` (`/tmp/<step>.<command>.sh`), not into the save directory. Build artifacts belong in the kernel `/tmp`, not the workspace.

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
GET  /api/packages                          # list installed packages
GET  /api/packages/item?id&version&digest   # package detail
DELETE /api/packages/item?id&version&digest # remove installed package
```

The UI "打开 .mlab" button uses browser file picker upload, imports into the package library, then opens the installed source by digest. The "教程库" panel lists installed packages with version/digest/source, and supports open/delete. Deleting a package does not delete learner saves. Host-path import remains available for API/automation.

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

## Panels And Preview

`PackageService` normalizes `default_panels` into `ui_panels` through `PanelModel`. Unknown panel types are dropped so packages cannot inject arbitrary host UI.

Current UI behavior:

- `tutorial` / `terminal` visibility follows the normalized panel list;
- `test-results` / `web-preview` / `logs` / `diagnostics` open as editor-group tabs next to file tabs (even if the panel starts `hidden`). Split editor groups (preview beside code) are not implemented yet. Logs and diagnostics are also always available from the right activity rail, without requiring a tutorial panel declaration;
- `web-preview` opens that tab for `type: "preview"` commands;
- captured preview output may include `MULTILAB_PREVIEW_HTML` or HTML body for sandboxed `iframe.srcdoc` rendering;
- `MULTILAB_PREVIEW_URL=...` is rewritten to a host-local mapped URL when the active Docker kernel publishes that container port (`publish_ports`, bound to `127.0.0.1`); otherwise it remains text with guidance to use `gcc-ubuntu24-docker-net` and `security.network_required` / `security.preview_ports`.
- Packages that need network or preview ports resolve to `gcc-ubuntu24-docker-net` (bridge + sandbox + published ports). Offline packages still require `network_default: none`.
- `file-tree` panels render a center-right tree from `GET /api/fs/ls?tree=1` (workspace-scoped). A right activity rail holds the explorer / logs / diagnostics icons; the tree opens to the left of that rail so the click target does not move. There is no FILES header. The tree auto-refreshes in real time: `WorkspaceService.watch` uses the current strategy's watcher and pushes `type: "fs_change"` over `/ws`; the frontend re-fetches `GET /api/fs/ls` on receipt. Bind-mount workspaces watch the host directory; `runtime-internal` keeps the find-polling fallback (~1s via `RuntimeSession.exec`). No MultiLab-specific kernel agent is required.

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

- `template`: package files under `steps/<id>/files/` (read-only);
- `save`: durable learner files for this step, owned by `SaveService`;
- `ui`: per-step editor/layout state (`open_files`, `active_file`, plus reserved keys for later preview panes);
- `workspace`: live scratch files for the **current step only**, owned by `WorkspaceService` inside the Docker lab;
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

Step load/save/reset is handled by `server/services/SaveService.js`. It owns save identity paths, host save file IO, first-entry inheritance, reset behavior, and progress metadata. On bind-mount, the step `files/` directory is the workspace: load retargets `/home/student/workspace`, save flushes editor buffers into that directory, and reset rewrites template files in place. On copy (Windows), load writes only that step into the container; save snapshots the live workspace back onto the host save.

`WorkspaceService` owns workspace initialization, scoped file IO (`/api/fs/*`), snapshot, export, and watch. File APIs and the WebSocket `fs_change` watcher go through this service rather than talking to Docker directly. Bind-mount step load falls back to a container-root wipe when host `rm` hits `EACCES`. Export/import of `.mlab-save` always packs the host save after snapshotting the live step — never zip the container blindly.

## Save Storage

Current prototype saves are stored under `.multilab-state`, but the identity now includes package id, version, and digest:

```text
multilab/.multilab-state/saves/<id>/<version>/<digest>/steps/<step>/files/
multilab/.multilab-state/saves/<id>/<version>/<digest>/steps/<step>/ui.json
```

`files/` is the learner workspace for that step, including empty directories and nested paths such as `src/foo.c`. `ui.json` records which editor tabs were open:

```json
{
  "open_files": ["hello.c"],
  "active_file": "hello.c"
}
```

Unknown `ui.json` keys are preserved for later special windows (preview panes, etc.). If `ui.json` is missing, the player opens `entry_file` only rather than every saved file.

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
steps/<step-id>/ui.json
steps/<step-id>/files/<relative-path>
steps/<step-id>/files/<empty-dir>/
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
- file APIs restrict paths to the workspace root (`/home/student/workspace` for current Linux kernels);
- tutorial scripts are loaded from package paths after path validation;
- test/check commands run inside the Docker runtime, not on the host.
- package trust defaults to `untrusted` and is stored by package digest under `.multilab-state/trust.json`.

Current command execution policy:

- command execution requires a compatible resolved kernel;
- `untrusted` packages require a sandbox-capable kernel;
- packages with `security.sandbox_required: true` require a sandbox-capable kernel even when user-trusted;
- packages that do not require network access require a selected kernel whose `network_default` is `none`;
- packages that require network access are rejected until a network-capable selected kernel/runtime path exists.

Command execution and step workspace IO go through `RuntimeManager`, which binds the selected kernel to a registered provider. For the Docker provider, container creation now applies:

- `NetworkMode: none` when `network_default` is `none`;
- `SecurityOpt: no-new-privileges` for non-`none` sandbox presets;
- labels recording kernel id/image/network/sandbox so mismatched existing containers are recreated.

Target security model:

- trust state per package digest;
- sandbox-capable kernel required by default for untrusted packages;
- Docker provider as the official sandbox-capable lab;
- the student's own WSL/home toolchain is not a kernel.

Current trust APIs:

```text
GET  /api/trust?package_digest=<sha256:...>
POST /api/trust { package_digest, trust }
```

The user-settable trust values are currently `untrusted` and `user-trusted`.

The frontend shows the current package trust state in the header and lets the user toggle between these two values. Trust metadata is enforced at command time together with kernel/runtime selection.

## Kernel Registry

The first implementation registers the current Docker runtime as an explicit kernel:

```text
gcc-ubuntu24-docker
  provider: docker
  image: multilab/os:latest
  platform: linux
  capabilities: tty, compile, debug, signals, sandbox
  network_default: none
  sandbox_presets: standard
```

Current kernel/runtime APIs:

```text
GET  /api/kernels
GET  /api/kernels/resolve?tutorial=<id>
GET  /api/runtime
POST /api/runtime/select { tutorial, kernel_id }
```

The resolver currently checks required platform, capabilities, command names, and simple command version constraints such as `>=13`, then prefers a per-package user selection (stored in `.multilab-state/kernel-selection.json`) and otherwise `recommended_kernel`. It returns `version_mismatches` for incompatible command versions and a `runtime` plan describing the provider/network/sandbox binding.

The UI shows a kernel selector for compatible candidates and a "重连终端" button. Selecting a kernel persists the preference, applies it through `RuntimeManager`, and reconnects the WebSocket terminal. If an interactive command hits `runtime_replaced`, the frontend auto-reconnects. Complex semver ranges and dynamic `kernels.json` loading are still not implemented.

## Known Limitations

- Docker is the only registered lab provider. The player is Node on Windows or Linux; the lab is a container, not the student's WSL distro.
- Runtime providers implement `probe`, `capabilities`, `planKernelSession`, `applyKernel`, and `startSession`. Sessions implement file IO, `exec`, captured command timeout, terminal, `getPortMap`, `pointWorkspace`, watch, and `dispose`.
- Host save is durable truth for all steps. The lab workspace is the current step only. Linux ext4 bind-mounts the save tree and retargets `/home/student/workspace`; Windows copies the current step. Do not bind-mount `/mnt/c`.
- File-tree watch uses host `fs.watch` on the bind source plus `find -H` polling so a workspace symlink still refreshes. The shell prompt maps `.mlab-saves/.../files` to `~/workspace`.
- `.mlab` pack/unpack CLI, host-path import, and browser upload/open are implemented.
- `.mlab-save` host-path export/import and browser upload/download are implemented. Export snapshots the live step into the host save first.
- Kernel registry is static (Docker `gcc-ubuntu24-docker` and `gcc-ubuntu24-docker-net`).
- Runtime selection follows resolved kernel plus optional per-package user preference.
- Package library management covers list/detail/open/delete; bulk cleanup and save-linked cleanup are not implemented.
- Panel declarations drive tutorial/terminal/file-tree visibility. `test-results` / `web-preview` open as editor tabs when declared. Logs and diagnostics are always on the right activity rail. The file-tree sits on the right of that rail with no FILES header. Learner-visible copy lives in `public/js/messages.js` (`t('group.key')`); static HTML uses `data-i18n*` filled by `applyStaticCopy()`. Progress UI reads `save.json` metadata from step APIs. Trust changes use a confirmation dialog. Frontend logic lives in `public/js/` ES modules without a bundler. Background long-running preview processes remain open; further live-web work is deprioritized in favor of HTML preview. There is no Settings view yet.
- The Docker container is single-session and intended for local single-user use.
