# Architecture

This document describes the **live Docker prototype** after the `multilab.json` migration.

Target product (2026-09-25): the player connects to a student-provided lab over SSH or local spawn. Do not add features that deepen Docker bind-mount as the architecture. See:

```text
../MULTILAB_PRODUCT_ARCHITECTURE_SPEC.md   # §0 direction update
../../.ai/AGENTS.md
../../.ai/memory/MEMORY.md
```

The test / coverage tutorial is `tutorials/hello-c/` (`TUTORIALS_DIR=../../tutorials` from `multilab/server/`).

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

- Linux ext4 (including Docker-on-WSL ext4): bind-mount the host save tree once at `/mlab/saves` (outside `$HOME`); retarget `/home/student/workspace` at the current step `files/` directory with a symlink. Same disk, no copy. Switching tutorials does not recreate the container. `ls ~` does not show the save tree. Do not inner-bind the workspace — open shells cannot detect that retarget.
- Windows NTFS (and `/mnt/c`): copy only the current step into the container via `RuntimeSession.writeFiles` / `readFiles`. Switching steps snapshots the live tree back onto the host save first. Do not bind-mount NTFS.

Save, run, step switch, exit, and export all flush the live workspace back into the host save for that step, then pack `.mlab-save` from the host save. `.mlab` is the tutorial; `.mlab-save` is progress.

The current code is still this Docker prototype. New work should follow the 2026-09-25 SSH/local lab direction, not extend bind-mount as the product path.

## Runtime Layers

```text
Browser UI
  Monaco editor
  xterm.js terminal
  tutorial Markdown (`public/js/content-renderer.js`)
  auto-layout work area (tutorial | editor | preview, terminal bottom)
  host drawer (logs / diagnostics)

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

The workspace is logically owned by MultiLab through `WorkspaceService`. The physical IO strategy is `RuntimeProvider.workspaceStrategy`: bind-mount on Linux ext4, copy on Windows (`kind: "copy"`; `WORKSPACE_STRATEGY=runtime-internal` is still accepted as an alias).

On Linux/WSL with a fast local filesystem (ext4/xfs/btrfs/tmpfs), Docker bind-mounts `.multilab-state/saves` to `/mlab/saves` **once** at container start (mode `711`, not in `$HOME`). Switching tutorials or steps does not recreate that Docker bind. It retargets `/home/student/workspace` at the current step `files/` dir with a symlink (`ln -sfn`, not an inner `mount --bind`, and not `rm`+`rmdir` of a live cwd). Bash keeps cwd on the old inode after a symlink swap; already-open shells receive `SIGUSR1` and also re-enter on a DEBUG trap before the next typed command. The persistent shell is attached at `/home/student`, then the profile snippet `chdir`s into the workspace. The learner-visible path stays `/home/student/workspace`. `WorkspaceService` reads, writes, lists, and watches the current step directory on the host. File-tree updates use host `fs.watch` on that directory plus `find -H` polling as a safety net. `find` without `-H` does not descend a symlink start path, so polling must pass `-H`.

The container `student` uid is aligned to the host process uid so terminal `mkdir` and host Node share ownership. `EACCES` during host clear still falls back to a container-root wipe.

Windows (NTFS) and Windows-drive mounts (`/mnt/c`) copy the **current step only** through `RuntimeSession.exec`. `WorkspaceService.flushLiveToHost` writes that live tree back onto the host save on save, step switch, and `.mlab-save` export. Override with `WORKSPACE_STRATEGY=bind-mount` or `WORKSPACE_STRATEGY=copy`. Do not bind-mount `/mnt/c`. Runtime kernels provide execution capability; they should not require a MultiLab-specific in-kernel agent.

Captured command scripts are uploaded through `RuntimeSession.tempScriptPath()` (`/tmp/<step>.<command>.sh`), not into the save directory. Build artifacts belong in the kernel `/tmp`, not the workspace.

## Tutorial Loading

Each tutorial source must contain `multilab.json`. The current host supports two source types:

- `development`: an authoring directory under `TUTORIALS_DIR/<id>`. This is the live writing path (hello-c in this workspace), not a test stub.
- `installed`: an imported `.mlab` under `.multilab-state/packages/<id>/<version>/<digest>/unpacked/`. This is what a learner (and a shipped tutorial) typically opens.

The player lists both. A learner-only install can point `TUTORIALS_DIR` at an empty folder so the catalog is import-only. Authors keep a development directory so they can edit Markdown and files without packing a `.mlab` on every change.

```text
tutorials/hello-c/
  multilab.json
  assets/
  steps/
    01-watch-hello/          # lecture/demo, preview only
    02-first-program/        # template + chain + test
    03-keep-hello/           # previous_save
    04-add-header/           # overlay_template + generated HTML preview
    05-args/                 # independent template, not in chain
    06-gdb/
    07-chain-note/           # lecture, stays out of chain
    08-no-test-handoff/      # previous_save, run only
    09-overlay-notes/
```

Package loading is handled by `server/services/PackageService.js`. It owns package source resolution, manifest loading, deterministic package digest calculation, step content assembly, command script lookup, and tutorial-panel content assets (`resolveContentAsset`).

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

## Tutorial Content Rendering

The left tutorial panel is rendered by `public/js/content-renderer.js`, not by `tutorial-loader.js`. `tutorial-loader` still owns list/open/step navigation and passes `instructions.md` plus `source_key` / `step_id` into the renderer.

```text
instructions.md
  marked (GFM)
  DOMPurify allowlist (no script/iframe/form/inline svg/button)
  rewrite <img src> to GET /api/tutorials/:source_key/assets?path=&step=
  wrap <pre> with copy chrome (player UI, after sanitize)
```

Image rules:

- Package-relative paths resolve first against `steps/<step-id>/`, then the package root. `./diagram.svg` and `assets/overview.png` both work. `..` is allowed only while the result stays inside the package.
- Allowed types: png, jpeg, gif, webp, bmp, **svg**. Use `![alt](assets/flow.svg)`. Inline `<svg>` in Markdown HTML is still stripped (that would inject into the player DOM); package SVG files are served as `<img>`.
- Asset responses send `Content-Security-Policy: default-src 'none'; sandbox` so opening the asset URL as a document cannot run package script. `<img>` still paints SVG.
- Remote `http(s)` images are dropped (local-first).
- Inline `data:image/png|jpeg|gif|webp;base64,...` is kept. Other `data:` / `javascript:` URLs are dropped.
- Assets come from the tutorial package, never from the live workspace or host save.

```text
GET /api/tutorials/:source_key/assets?path=<authored-src>&step=<step-id>
  PackageService.resolveContentAsset
  Content-Type from extension
  X-Content-Type-Options: nosniff
```

Fenced code blocks get a copy icon at the top-right of the block (Cursor-style: no header strip, no language label). Copy is player chrome added after sanitize, so package HTML cannot inject those buttons. The tutorial panel allows text selection (`user-select: text`); the rest of the chrome stays unselectable.

Restricted HTML in Markdown is allowed only through the DOMPurify allowlist (headings, lists, tables, links, images, `pre`/`code`, emphasis). `http(s)` and `mailto:` links open in a new tab with `rel="noopener noreferrer"`. Relative file links are unwrapped to text; they are not a second navigation surface.

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

The tutorial catalog is one control: the current-tutorial button opens a list of development and imported packages (`GET /api/tutorials`). "打开 .mlab" sits in that list's footer (`POST /api/packages/upload`). Imported rows can be deleted (`DELETE /api/packages/item`); learner saves are kept. Progress import/export is a separate control because it belongs to the open tutorial, not the catalog. Host-path import remains available for API/automation.

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
  frontend saveCurrentStep() if the step is editable
  frontend sends ws { type: "command", tutorial, step, command, generation }
  backend loads command script from manifest
  backend writes script to /tmp/<step>.<command>.sh in the container
  backend runs it in a dedicated exec PTY (RuntimeSession.attachCommand)
  command output streams to xterm; stdin goes to the command PTY
  exec.inspect() Running=false + exit code → ws { type: "command_done", exitCode }
  (Docker keeps a TTY+stdin hijack socket open after exit; do not wait only for stream end)
  persistent bash receives a newline so the prompt returns
```

Declared interactive commands do not run inside the persistent learner shell.
When a step is not editable, that shell accepts no stdin. Lecture/demo Preview
is still allowed: stdin is routed to the command PTY only while it is active.
Exercise Run / Test / Preview, and persistent-shell input, require every previous
tutorial step to be currently complete.

### Captured Command Flow

```text
User clicks Check
  frontend saveCurrentStep()
  frontend POST /api/commands/run
  backend loads command script
  backend writes script to /tmp/<step>.<command>.sh
  backend runs it with containerExec(["bash", remoteScript])
  backend returns stdout, stderr, exitCode, passed
  frontend shows output in the test-results editor tab (not xterm)
```

The old `/api/test` and WebSocket `type: "run"` paths have been removed.

## Panels And Preview

`PackageService` normalizes `default_panels` into `ui_panels` through `PanelModel`. A step may set `panels`; that overlay is resolved into `step.ui_panels` (inherit the package set when omitted). Unknown panel types are dropped so packages cannot inject arbitrary host UI.

Packages declare **which primitives they need**, not window geometry. The player auto-layouts. `public/index.html` is the layout source of truth.

Current UI behavior:

- One player top bar: brand and tutorial-collapse on the left; tutorial catalog (current tutorial + all packages + open `.mlab`) and current-tutorial progress; diagnostics and theme on the right. Logs live inside the diagnostics drawer. No kernel picker, no trust badge, and no step commands in the header.
- Tutorial is nailed left and collapsible. Packages cannot move it. `area` on panel objects is stored for compatibility and ignored for geometry.
- Editor and preview are optional peer columns (side by side when both are needed). Preview is an observation panel, not a file tab. Declaring `web-preview` (and not `hidden`) shows the column; a `type: "preview"` command also opens it. Visibility follows the **current step** (`step.ui_panels`), not only the package default.
- Terminal stays at the bottom of the work area, never a third column.
- File-tree is an editor accessory inside the editor column (right of Monaco), toggled from the editor tab strip. It is not a third workspace column and must not sit at the far right of the page when preview is open. There is no FILES header and no activity rail.
- `test-results` still opens as an editor tab when declared. Captured Check/Test output goes there plus a toast; it is not written into the persistent terminal.
- Logs and diagnostics are one host drawer opened from a single 诊断 button. The drawer is one scroll: trust / kernel / reconnect, then session logs. No inner tabs.
- Bottom bar: fixed-width prev/next on the left, a fixed-width nearby-five step-dot track (complete = green, incomplete = white, current = black ring; leading/trailing ellipsis keep the track width stable), `n / total · title` after the dots (ellipsis, must not push the buttons), current-step commands on the right (run / test / preview / reset / solution, plus interrupt when a terminal is shown). Command buttons follow the current step's `commands[]`, not which windows exist. Exercise commands stay disabled until every previous tutorial step is currently complete. Lecture/demo Preview stays enabled while read-only. 看答案 stays visible when `solution/` exists and is disabled until commands are allowed.
- captured preview output may include `MULTILAB_PREVIEW_HTML` or HTML body for sandboxed `iframe.srcdoc` rendering;
- `MULTILAB_PREVIEW_URL=...` is rewritten to a host-local mapped URL when the active Docker kernel publishes that container port (`publish_ports`, bound to `127.0.0.1`); otherwise it remains text with guidance to use `gcc-ubuntu24-docker-net` and `security.network_required` / `security.preview_ports`.
- Packages that need network or preview ports resolve to `gcc-ubuntu24-docker-net` (bridge + sandbox + published ports). Offline packages still require `network_default: none`.
- `file-tree` panels render a tree from `GET /api/fs/ls?tree=1` (workspace-scoped). The tree auto-refreshes in real time: `WorkspaceService.watch` uses the current strategy's watcher and pushes `type: "fs_change"` over `/ws`; the frontend re-fetches `GET /api/fs/ls` on receipt. Bind-mount workspaces watch the host directory; copy strategy keeps the find-polling fallback (~1s via `RuntimeSession.exec`). No MultiLab-specific kernel agent is required.

## Terminal Model

Each browser WebSocket connection starts a persistent interactive shell:

```text
bash --login -i
```

The shell runs as `student` in:

```text
/home/student/workspace
```

When the current step currently allows exercise commands, terminal input goes to the persistent shell (gdb, REPLs, arbitrary commands). Otherwise the persistent shell accepts no stdin. While a declared command is running, stdin goes to that command PTY instead.

Copy/paste: selection + Ctrl+C copies (then clears the selection); no selection sends SIGINT. Ctrl+Shift+C copies. Paste uses the browser `paste` event (`clipboardData`), not `navigator.clipboard.readText()`. The bottom-bar interrupt button is enabled only while an interactive declared command is running (`commandBusy`); it sends `\x03` to that command PTY.

Docker hijack streams are decoded with dockerode's `container.modem.demuxStream()`.

## Step State

Each step has a package **template** (`steps/<id>/files/`), an optional **solution**, and a learner **archive** on the host save. The archive exists only after a needs-edit step **becomes editable**.

Author flags:

- `needs_edit` (default true): exercise vs lecture/demo. Lecture/demo never get an archive.
- `inherit_mode`: built-in archive constructor (`template` / `previous_save` / `overlay_template`). It runs when this needs-edit step becomes editable. Authors do not write constructor code. `previous_save` and `overlay_template` require `chain`. Lecture/demo stay out of `chain`.

Runtime flags:

- complete / incomplete
- editable / not editable (`needs_edit` only; sticky once true)

Only tutorial step 0 starts editable, and only if it `needs_edit`. A still-not-editable exercise becomes editable when **every previous tutorial step is complete**. That transition is when its archive is constructed. Already-editable steps stay editable if an earlier step later becomes incomplete. Command buttons on those later steps stay disabled until the previous steps are complete again.

Completion:

- lecture/demo: on enter, and only if every previous step is already complete. Browse-ahead does not complete it. Preview is allowed while read-only. No archive.
- exercise with a test: archive passes that test (`test_passed` paired with `test_hash`)
- exercise without a test: entered while already editable

Not editable / lecture / demo: inject template into an ephemeral preview directory (not packed into `.mlab-save`). Monaco and persist APIs are read-only. Persistent bash accepts no stdin unless the exercise currently allows commands. Lecture/demo Preview may take stdin for the running program only. Exercise commands stay disabled until every previous tutorial step is currently complete.

Editable: inject the archive. For `previous_save` the copy is the previous chain archive after that previous step completed. 重做 re-runs the constructor. 看答案 replaces the archive, clears test status, and does not auto-complete. Once built, keep showing that archive if an earlier step later becomes incomplete.

Browse-ahead while not editable must not create an archive. `save.json` `archive_built[step]` records that the constructor already ran; a directory without that flag is not an archive.

`SaveService` owns this machine, host archive IO, preview paths, and write/command/shell gates. `WorkspaceService` still owns live workspace IO.

Do not say 「锁住」 in learner-facing copy.

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

Current metadata tracks package identity, `current_step`, visited, `test_passed` / `test_hash`, `completed`, `editable`, `entered_editable`, `archive_built`, and `updated_at`. `archive_built[step]` means the constructor already ran for that unlock; a save directory without it is not an archive. Step load/save/reset records the current step as visited. Captured commands with `type: "test"` update `test_passed[step]`.

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

The frontend shows the current package trust state in the diagnostics drawer and lets the user toggle between these two values. Trust metadata is enforced at command time together with kernel/runtime selection.

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

The player auto-matches a compatible kernel on open (`recommended_kernel`, then any stored per-package preference). Kernel, trust, and reconnect are shown in the diagnostics drawer, not in the top bar. Selecting a kernel through `POST /api/runtime/select` still persists the preference, applies it through `RuntimeManager`, and reconnects the WebSocket terminal. If an interactive command hits `runtime_replaced`, the frontend auto-reconnects. Complex semver ranges and dynamic `kernels.json` loading are still not implemented.

## Known Limitations

- Docker is the only registered lab provider. The player is Node on Windows or Linux; the lab is a container, not the student's WSL distro.
- Runtime providers implement `probe`, `capabilities`, `planKernelSession`, `applyKernel`, and `startSession`. Sessions implement file IO, `exec`, captured command timeout, terminal, `getPortMap`, `pointWorkspace`, watch, and `dispose`.
- Host save is durable truth for all steps. The lab workspace is the current step only. Linux ext4 bind-mounts the save tree at `/mlab/saves` and retargets `/home/student/workspace`; Windows copies the current step and flushes live files back on save/switch/export. Do not bind-mount `/mnt/c`.
- File-tree watch uses host `fs.watch` on the bind source plus `find -H` polling so a workspace symlink still refreshes. The shell prompt maps `/mlab/saves/.../files` to `~/workspace`.
- `.mlab` pack/unpack CLI, host-path import, and browser upload/open are implemented.
- `.mlab-save` host-path export/import and browser upload/download are implemented. Export snapshots the live step into the host save first.
- Kernel registry is static (Docker `gcc-ubuntu24-docker` and `gcc-ubuntu24-docker-net`).
- Runtime selection follows resolved kernel plus optional per-package user preference.
- Package library management covers list/detail/open/delete; bulk cleanup and save-linked cleanup are not implemented.
- Panel declarations name primitives (`tutorial` / `editor` / `terminal` / `web-preview` / `file-tree` / `test-results`). Package `default_panels` is the default; a step `panels` overlay replaces it for that step. The player auto-layouts; packages cannot set geometry. Preview sits beside the whole editor column when needed. Logs and diagnostics are a host drawer. The file-tree sits on the right of Monaco, not the far right of the page. Learner-visible copy lives in `public/js/messages.js` (`t('group.key')`); static HTML uses `data-i18n*` filled by `applyStaticCopy()`. Tutorial Markdown is rendered by `public/js/content-renderer.js` (copyable fences, package-relative images, sanitized HTML). Progress UI reads `save.json` metadata from step APIs. Trust changes use a confirmation dialog. Frontend logic lives in `public/js/` ES modules without a bundler. Background long-running preview processes remain open; further live-web work is deprioritized in favor of HTML preview. There is no Settings view yet.
- The Docker container is single-session and intended for local single-user use.
