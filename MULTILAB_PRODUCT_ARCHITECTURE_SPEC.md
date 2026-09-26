# MultiLab Product & Architecture Spec

> Version: 0.1 draft  
> Date: 2026-07-25  
> Status: product and architecture design draft  
> Direction update: 2026-09-25 (this banner wins where it disagrees with the body)

## 0. Direction update (2026-09-25)

The player is the product. The student brings the lab machine.

```text
Browser (Monaco / xterm)
  HTTP / WebSocket
Player Node on the student's computer
  SSH / SFTP, or local spawn
Lab the student already has
  (this computer, WSL, VirtualBox, cloud, container with sshd)
```

Supersedes the body on these points:

- Do not ship official Docker images or treat Docker bind-mount as the host↔lab architecture.
- `runtime_requirements` are probed on the connected machine, not satisfied by a packaged kernel.
- The lab needs sshd (or is the same OS as the player) plus the tutorial's tools. No vscode-server and no in-lab MultiLab agent.
- Host save remains truth for progress (`save.json`) and per-step **source** archives. The lab holds the current-step workspace only. Sync on save / run / step switch / export, not per keystroke. xterm is a live PTY.
- Tutorials decide where build artifacts go (`/tmp`, `build/`, or the workspace). The player does not globally hide `*.o`.
- Opening a package still must not execute it. Running a command still needs an explicit connected lab and a trust confirmation, because scripts run on the student's machine.

The Docker sections below describe the 2026-07 prototype and remaining live code, not the target connection model.

`hello-c` is the player coverage / test package (`tutorials/hello-c/`).

## 1. Product Thesis

MultiLab is a local-first interactive tutorial player and runtime standard for programming labs.

Its goal is not to be a generic IDE, a cloud judge, or a full LMS. The core product is a portable tutorial package format that can describe:

- what the learner reads,
- what files the learner edits,
- what commands can be run,
- what runtime/kernel is required,
- how progress is saved,
- what UI panels should be shown,
- and what sandbox/trust policy applies.

The closest analogy is:

```text
Jupyter Notebook
  .ipynb content file
  kernelspec
  Jupyter server
  kernel process

MultiLab
  .mlab tutorial package
  kernel/runtime spec
  MultiLab host
  runtime session / sandbox
```

MultiLab should be more security-aware than classic local Jupyter. A tutorial package may contain executable commands, generated starter code, tests, setup scripts, and eventually AI-generated content. Therefore, opening a package and executing a package are distinct operations.

## 2. Design Goals

### 2.1 Primary Goals

- Portable interactive tutorials: a `.mlab` package should be shareable like a notebook.
- Local-first execution: core editing, running, testing, and saving should work without a cloud service.
- Reproducible official runtime: official tutorials run in a recommended Docker kernel.
- Player ports: Windows and Linux Node frontend/backend; the lab machine is always a Docker container.
- Trust-aware execution: untrusted tutorials should default to sandbox-capable Docker kernels.
- The student's own WSL distro or host toolchain is not a lab kernel.
- Real terminal support: OS/gcc/gdb/shell tutorials require a true interactive TTY.
- Versioned learning state: student saves are tied to `tutorial@version@digest`.
- AI-authorable tutorials: the package standard should be precise enough for an AI skill to generate valid tutorials.

### 2.2 Non-Goals For The Core Standard

- Multi-user classroom management.
- Cloud grading.
- Anti-cheat.
- A full desktop IDE replacement.
- A complete package marketplace in the first implementation.
- Hard security against hostile public code on a shared server.

These can be built later on top of the core standard.

## 3. Conceptual Model

MultiLab has five primary layers:

```text
1. Tutorial Source Layer
   Remote Git repo, zip, .mlab file, local authoring directory, or future registry.

2. Local Tutorial Library
   Installed, versioned, mostly read-only tutorial packages.

3. Save Layer
   Learner progress and edited files, stored separately from tutorials.

4. Runtime Layer
   Kernel provider and runtime session, usually a Docker container.

5. Presentation Layer
   Tutorial text, file tree, Monaco editor, terminal, preview panels, diagnostics.
```

The core invariant:

```text
tutorial package = read-only learning material
save bundle      = learner-owned state on the player host (all steps)
workspace        = current-step live files in the Docker lab
runtime session  = disposable Docker container
```

## 4. Package Model

### 4.1 Development Format

During authoring, a tutorial is a directory:

```text
hello-c/
  multilab.json
  steps/
    01-first-program/
      instructions.md
      files/
        hello.c
      commands/
        run.sh
        test.sh
    02-args/
      instructions.md
      files/
        args.c
      commands/
        run.sh
        test.sh
```

This is optimized for:

- normal editors,
- Git diff,
- AI generation,
- validation,
- human review,
- and package signing/hash calculation.

### 4.2 Distribution Format

For sharing, the directory is packed into a single `.mlab` file.

`.mlab` is a ZIP container with a required `multilab.json` manifest at the root.

Example:

```text
hello-c-1.0.0.mlab
  multilab.json
  steps/
    01-first-program/
      instructions.md
      files/
        hello.c
      commands/
        run.sh
        test.sh
```

The `.mlab` file should be treated like a notebook file: portable, importable, previewable, and runnable after kernel selection.

### 4.3 Installed Package Layout

After import, MultiLab installs the package into a local tutorial library:

```text
~/.multilab/tutorials/
  hello-c/
    1.0.0/
      package.mlab
      unpacked/
        multilab.json
        steps/
      package.lock.json
```

`package.lock.json` records:

- package id,
- version,
- digest,
- import time,
- trust state,
- source,
- schema version,
- and validation result.

Installed packages should be immutable. Editing a tutorial should happen in an authoring workspace, not inside the installed library.

## 5. Manifest: `multilab.json`

`multilab.json` is the tutorial package manifest. It is the equivalent of `package.json`, `devcontainer.json`, and Jupyter notebook metadata combined, but scoped to interactive tutorials.

### 5.1 Example

```json
{
  "schema_version": 1,
  "id": "hello-c",
  "version": "1.0.0",
  "title": "Hello, C",
  "description": "Use gcc to compile and run your first C program.",
  "language": "c",
  "authors": [
    { "name": "Xingyang Wang" }
  ],
  "runtime_requirements": {
    "platform": "linux",
    "commands": {
      "gcc": ">=13",
      "gdb": ">=14",
      "bash": ">=5"
    },
    "capabilities": ["tty", "compile", "debug", "signals"]
  },
  "recommended_kernel": "gcc-ubuntu24-docker",
  "security": {
    "sandbox_required": true,
    "network_required": false,
    "trust": "untrusted"
  },
  "default_panels": [
    { "id": "tutorial", "type": "tutorial", "area": "left" },
    { "id": "files", "type": "file-tree", "area": "center-left" },
    { "id": "editor", "type": "editor", "area": "center" },
    { "id": "terminal", "type": "terminal", "area": "bottom" },
    { "id": "test-results", "type": "test-results", "area": "right", "hidden": true }
  ],
  "steps": [
    {
      "id": "01-first-program",
      "title": "First C Program",
      "chain": "hello-c",
      "inherit_mode": "template",
      "entry_file": "hello.c",
      "commands": [
        {
          "id": "run",
          "type": "run",
          "label": "Run",
          "script": "steps/01-first-program/commands/run.sh",
          "terminal": "interactive",
          "timeout_sec": 10
        },
        {
          "id": "test",
          "type": "test",
          "label": "Check",
          "script": "steps/01-first-program/commands/test.sh",
          "terminal": "captured",
          "timeout_sec": 10
        }
      ]
    }
  ]
}
```

### 5.2 Required Top-Level Fields

- `schema_version`: integer. The package schema version.
- `id`: stable package id, lowercase kebab-case.
- `version`: semver package version.
- `title`: display title.
- `description`: short package description.
- `language`: primary content language for editor defaults.
- `runtime_requirements`: required runtime capabilities.
- `steps`: ordered step list.

### 5.3 Optional Top-Level Fields

- `authors`
- `license`
- `tags`
- `difficulty`
- `recommended_kernel`
- `security`
- `default_panels`
- `metadata`

Custom extensions should live under `metadata.<namespace>` to avoid polluting the core standard.

## 6. Runtime And Kernel Model

### 6.1 Kernel Is A Runtime Contract

A MultiLab kernel is an execution environment that satisfies a runtime contract. The official lab machine is a Docker container. The MultiLab player (frontend + Node backend) runs on Windows or Linux and talks to that container; it does not execute tutorial code in the student's own WSL distro.

`RuntimeProvider` remains an internal seam so the player does not import dockerode throughout. Only the Docker provider is a product path.

```text
RuntimeProvider
  docker     # official lab
```

### 6.2 Kernel Registry

MultiLab keeps a local kernel registry:

```text
~/.multilab/config/kernels.json
```

Example:

```json
{
  "kernels": [
    {
      "id": "gcc-ubuntu24-docker",
      "display_name": "GCC Ubuntu 24.04 (Docker)",
      "provider": "docker",
      "image": "ghcr.io/multilab/gcc:ubuntu24.04",
      "dockerfile": "runtimes/gcc-ubuntu24/Dockerfile",
      "user": "student",
      "workspace": "/home/student/workspace",
      "capabilities": ["tty", "compile", "debug", "signals", "sandbox"],
      "versions": {
        "gcc": "13.3.0",
        "gdb": "15.0",
        "bash": "5.2"
      },
      "sandbox_presets": ["standard", "strict"]
    }
  ]
}
```

### 6.3 Kernel Resolution

When opening a package, MultiLab should:

1. Parse `runtime_requirements`.
2. Find installed kernels that satisfy the requirements.
3. Prefer the package's `recommended_kernel` when available.
4. Prefer sandbox-capable kernels for untrusted packages.
5. Recommend the best kernel.
6. Let the user confirm or switch.

If no compatible kernel exists, MultiLab should show a structured diagnostic:

```text
No compatible kernel found.

Required:
  platform: linux
  gcc >= 13
  gdb >= 14
  tty

Available:
  gcc-ubuntu24-docker: gcc 13.3, sandbox, network none

Recommended:
  Pull ghcr.io/multilab/gcc:ubuntu24.04
```

### 6.4 Runtime Provider Interface

Conceptual TypeScript interface:

```ts
interface RuntimeProvider {
  id: string;
  kind: "docker";

  probe(kernel: KernelSpec): Promise<RuntimeCapabilities>;
  startSession(kernel: KernelSpec, options: StartSessionOptions): Promise<RuntimeSession>;
}

interface RuntimeSession {
  writeFiles(files: WorkspaceFile[]): Promise<void>;
  readFiles(options?: ReadFilesOptions): Promise<WorkspaceFile[]>;
  runCommand(command: CommandSpec, options: RunOptions): Promise<RunResult>;
  attachTerminal(options: TerminalOptions): Promise<TerminalStream>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}
```

The rest of MultiLab should talk to `RuntimeSession`, not directly to Docker.

## 7. Sandbox And Trust Model

### 7.1 Trust States

Tutorial packages have local trust state:

- `official`
- `local-authored`
- `user-trusted`
- `signed`
- `untrusted`

AI-generated packages and imported packages from unknown sources default to `untrusted`.

Trust state is stored locally, keyed by package digest.

```text
~/.multilab/config/trust.json
```

Example:

```json
{
  "packages": {
    "sha256:abc123": {
      "trust": "user-trusted",
      "trusted_at": "2026-07-25T15:00:00Z",
      "source": "local import"
    }
  }
}
```

### 7.2 Security Policy

Package security declarations:

```json
{
  "security": {
    "sandbox_required": true,
    "network_required": false,
    "trust": "untrusted"
  }
}
```

Rules:

- Opening a package should not execute code.
- Running a command requires a selected kernel.
- Untrusted packages should default to sandbox-capable Docker kernels.
- The student's own WSL or host toolchain is not a selectable kernel.
- Overrides require a clear warning.

### 7.3 Sandbox Presets

Docker provider should support tiered presets:

```text
trusted
  For self-authored packages. Light restrictions.

standard
  Default for untrusted local execution.

strict
  Stronger restrictions. No network, lower resource limits.

hardened
  Future. gVisor/Kata/VM-backed isolation.
```

Example Docker `standard` preset:

```json
{
  "network": "none",
  "memory_mb": 512,
  "cpu": 1,
  "pids": 128,
  "user": "student",
  "no_new_privileges": true,
  "cap_drop": ["ALL"],
  "workspace_scope": "workspace-only"
}
```

OS debugging tutorials may require carefully tested exceptions for `gdb`, `strace`, or `ptrace`. These should be expressed as runtime capabilities, not hidden assumptions.

## 8. Save Model

### 8.1 Save Identity

Learner progress is saved by:

```text
package_id + package_version + package_digest + user_profile
```

Conceptually:

```text
save = hello-c@1.0.0@sha256:abc123
```

This prevents a package update from silently corrupting old progress.

### 8.2 Save Layout

Local save layout:

```text
~/.multilab/saves/
  hello-c/
    1.0.0/
      sha256-abc123/
        save.json
        steps/
          01-first-program/
            files/
              hello.c
          02-args/
            files/
              args.c
```

`save.json`:

```json
{
  "package": {
    "id": "hello-c",
    "version": "1.0.0",
    "digest": "sha256:abc123"
  },
  "current_step": "01-first-program",
  "visited": ["01-first-program"],
  "test_passed": {
    "01-first-program": true
  },
  "updated_at": "2026-07-25T15:30:00Z"
}
```

### 8.3 Save Bundles

Learner saves can be exported as `.mlab-save`.

`.mlab-save` is a separate ZIP container:

```text
hello-c-1.0.0-my-save.mlab-save
  save.json
  steps/
    01-first-program/
      files/
        hello.c
```

It should not embed the full tutorial package by default. Instead, it references:

- package id,
- package version,
- package digest.

If the matching package is missing, MultiLab should ask the user to import the original `.mlab` package or choose a compatible package manually.

## 9. Step State Model

### 9.1 Key Concepts

Each step has:

- `template`: official starter files from the package (read-only, shipped with the player / `.mlab`).
- `save`: durable learner files for this step, stored on the player host.
- `workspace`: live files gcc/bash see for the **current step only** inside the Docker lab (`/home/student/workspace`).
- `progress`: visited/test-passed/current-step metadata on the host (`save.json`).

Host save is the source of truth for every step. The lab never holds other steps in the learner-visible workspace.

Linux (ext4, including Docker-on-WSL ext4): bind-mount the host save tree once at `/mlab/saves` (outside `$HOME`); retarget `/home/student/workspace` at the current step directory. Same disk — flush editor buffers is enough to persist.

Windows (NTFS): copy only the current step into the container. Save, run, step switch, exit, and `.mlab-save` export snapshot that live tree back onto the host save. Do not bind-mount `C:\` or `/mnt/c`.

`.mlab` is the tutorial package. `.mlab-save` is the host save bundle (all saved steps + `save.json` + `ui.json` + package identity). Export snapshots the live step first; never zip the container blindly. Import writes the host save, then loads the current step into the lab.

### 9.2 `inherit_mode`

`inherit_mode` defines how a step initializes its save when the learner enters it for the first time.

Supported modes:

```text
template
  Initialize from this step's own files.
  Best for independent exercises.

previous_save
  Initialize from the nearest previous save in the same chain.
  Best for continuous projects.

overlay_template
  Start from previous save, then overlay this step's template files.
  Best for continuous projects that introduce new files.
```

### 9.3 Example: Independent Exercises

```json
{
  "steps": [
    {
      "id": "01-hello",
      "title": "Hello",
      "inherit_mode": "template"
    },
    {
      "id": "02-args",
      "title": "Command Line Arguments",
      "inherit_mode": "template"
    }
  ]
}
```

Entering `02-args` loads `steps/02-args/files/`, not the learner's `01-hello` files.

### 9.4 Example: Continuous Project

```json
{
  "steps": [
    {
      "id": "01-read-loop",
      "title": "Read Loop",
      "chain": "mini-shell",
      "inherit_mode": "template"
    },
    {
      "id": "02-fork-exec",
      "title": "Fork and Exec",
      "chain": "mini-shell",
      "inherit_mode": "previous_save"
    },
    {
      "id": "03-redirection",
      "title": "Redirection",
      "chain": "mini-shell",
      "inherit_mode": "overlay_template"
    }
  ]
}
```

Flow:

```text
Step 1:
  template -> save(01) -> workspace

Step 2 first entry:
  save(01) -> save(02) -> workspace

Step 3 first entry:
  save(02) + template(03) overlay -> save(03) -> workspace
```

Overlay behavior must be explicit and safe:

- adding new files is allowed by default,
- overwriting learner files should require an explicit manifest declaration,
- conflicts should produce diagnostics.

## 10. Command Model

### 10.1 Commands Are First-Class Objects

Commands are declared in `multilab.json`, but their implementation lives in real script files.

This keeps the manifest structured and scripts reviewable.

### 10.2 Standard Command Types

Core command types:

- `setup`: prepare workspace or generated assets.
- `run`: exploratory run, usually attached to terminal.
- `test`: pass/fail validation.
- `check`: non-pass/fail inspection or linting.
- `preview`: launch or refresh a UI preview.
- `cleanup`: clean temporary state.

### 10.3 Command Declaration

```json
{
  "id": "test",
  "type": "test",
  "label": "Check",
  "script": "steps/01-first-program/commands/test.sh",
  "terminal": "captured",
  "timeout_sec": 10,
  "result": {
    "pass_exit_codes": [0]
  }
}
```

### 10.4 Execution Modes

```text
interactive
  Run in or attach to an interactive terminal.

captured
  Run non-interactively, capture stdout/stderr/exit code.

background
  Start a process, expose preview/logs, stop later.
```

For reliability, scripts should generally be copied into the runtime session and executed as files rather than injected as raw shell text.

## 11. UI And Panel Model

### 11.1 Default Product UI

Default layout:

```text
Tutorial panel | File tree + Monaco editor
               | Terminal / results / preview
```

This is a hybrid of:

- tutorial player,
- IDE workspace,
- terminal lab,
- and preview environment.

### 11.2 Declarative Panels

Tutorials can request default panels:

```json
{
  "default_panels": [
    { "id": "tutorial", "type": "tutorial", "area": "left" },
    { "id": "files", "type": "file-tree", "area": "center-left" },
    { "id": "editor", "type": "editor", "area": "center" },
    { "id": "terminal", "type": "terminal", "area": "bottom" },
    { "id": "preview", "type": "web-preview", "area": "right", "hidden": true }
  ]
}
```

Panel types:

- `tutorial`
- `file-tree`
- `editor`
- `terminal`
- `test-results`
- `web-preview`
- `logs`
- `diagnostics`

The platform decides how panels are rendered. Tutorial packages should not be allowed to inject arbitrary UI code into the host application.

### 11.3 Web Preview

For React/frontend tutorials, MultiLab should support a preview panel.

The preview command can start a dev server inside the runtime session, and the provider can expose a safe local URL.

Security requirements:

- preview runs inside selected runtime,
- host chooses port mapping,
- untrusted packages should not get unrestricted host network access,
- preview frame should be isolated from the MultiLab host UI.

## 12. Progress Model

MultiLab uses soft progress.

It records:

- visited steps,
- current step,
- saved files,
- test pass/fail result,
- command history summary,
- timestamps.

It should not hard-lock navigation by default. Tutorials can recommend order, but the learner can jump around.

Future package field:

```json
{
  "progress": {
    "mode": "free"
  }
}
```

Possible future modes:

- `free`
- `guided`
- `locked`

The initial standard should implement `free` with soft progress.

## 13. Diagnostics

MultiLab should produce structured diagnostics for:

- invalid package format,
- unsupported schema version,
- missing files,
- invalid command declarations,
- unsafe script references,
- kernel mismatch,
- sandbox conflict,
- command timeout,
- command failure,
- overlay conflicts,
- save/package mismatch.

Diagnostic shape:

```json
{
  "code": "KERNEL_VERSION_MISMATCH",
  "severity": "error",
  "message": "gcc version does not satisfy tutorial requirements.",
  "details": {
    "required": ">=13",
    "found": "11.4.0",
    "kernel": "gcc-ubuntu24-docker"
  },
  "suggestions": [
    {
      "label": "Use recommended Docker kernel",
      "action": "select_kernel",
      "kernel": "gcc-ubuntu24-docker"
    }
  ]
}
```

Diagnostics should be both user-readable and machine-readable so future AI tools can help fix packages.

## 14. Authoring And AI Skill Workflow

The standard should be precise enough for an AI skill to generate full tutorial packages.

Recommended authoring workflow:

```text
1. User describes learning objective.
2. AI skill generates tutorial directory.
3. Validator checks schema, paths, commands, security declarations.
4. Optional dry-run executes commands in sandbox kernel.
5. Packer creates .mlab.
6. User imports .mlab into MultiLab.
```

Required tooling:

- `multilab validate <dir-or-mlab>`
- `multilab pack <dir> --out package.mlab`
- `multilab inspect <package.mlab>`
- `multilab install <package.mlab>`
- `multilab run-dry <package.mlab> --kernel gcc-ubuntu24-docker`

The first AI skill should target the development directory format and call the validator/packer.

## 15. Runtime Distribution

Official Docker kernels should be distributed as:

- prebuilt images for normal use,
- Dockerfiles for inspection and local build,
- optional digest pinning for reproducibility.

Example:

```json
{
  "id": "gcc-ubuntu24-docker",
  "image": "ghcr.io/multilab/gcc:ubuntu24.04",
  "digest": "sha256:...",
  "dockerfile": "https://github.com/multilab/runtimes/gcc-ubuntu24/Dockerfile"
}
```

Resolution:

1. Try local image by digest/tag.
2. Offer to pull prebuilt image.
3. If pull fails or user prefers, offer local build from Dockerfile.
4. Probe runtime capabilities after image is available.

## 16. Local Storage Layout

Suggested product layout:

```text
~/.multilab/
  config/
    settings.json
    kernels.json
    trust.json

  tutorials/
    <id>/
      <version>/
        package.mlab
        package.lock.json
        unpacked/

  saves/
    <id>/
      <version>/
        <digest>/
          save.json
          steps/

  runtimes/
    logs/
    sessions/

  cache/
    downloads/
    extracted/
    probes/
```

Development workspace layout can remain:

```text
multilab-project/
  multilab/
  tutorials/
  .ai/
```

But product code should eventually abstract storage behind a `StorageService` so development paths and user paths can differ.

## 17. Migration From Current Prototype

Current prototype concepts:

- `tutorial.json`
- `steps/<id>/instructions.md`
- `steps/<id>/files/`
- `run.sh`
- `test.sh`
- `.multilab-state/saves/`
- Docker-only runtime through `EXEC_IMAGE`

Target concepts:

- `multilab.json`
- `.mlab` package
- manifest-declared commands
- command script files under `commands/`
- kernel registry
- runtime provider abstraction
- local tutorial library
- `.mlab-save`
- trust store
- structured diagnostics

Suggested migration phases:

### Phase 1: Spec Compatibility Layer

- Add `multilab.json` support while still loading old `tutorial.json`.
- Convert old `run.sh`/`test.sh` into manifest commands internally.
- Add `schema_version`.
- Add package validation.

### Phase 2: Kernel Abstraction

- Introduce `RuntimeProvider` interface.
- Move Docker code behind `DockerRuntimeProvider`.
- Add kernel registry.
- Add kernel resolver.

### Phase 3: Package Import/Install

- Implement `.mlab` pack/unpack.
- Install packages into local library.
- Store package digest and trust state.

### Phase 4: Save Redesign

- Move saves to `tutorial@version@digest`.
- Implement `.mlab-save` export/import.
- Add progress metadata.

### Phase 5: Panels And Preview

- Add declarative panel model.
- Add test-results and web-preview panels.
- Support background preview commands.

### Phase 6: Authoring Toolchain

- Build validator, packer, inspector.
- Create AI skill based on the final package standard.

## 18. Open Specification Details

The following details remain to be finalized during implementation:

- exact `multilab.json` JSON Schema,
- exact semver and schema compatibility policy,
- exact `.mlab` ZIP metadata and digest rules,
- exact `.mlab-save` schema,
- precise overlay conflict behavior,
- exact sandbox preset values,
- provider probe protocol,
- preview port mapping policy,
- command result schema,
- package signing format for future versions.

These are implementation-level details. The product architecture should already assume their existence.

## 19. Summary

MultiLab should be designed as a portable interactive tutorial standard with a local-first runtime host.

The core product contract is:

```text
.mlab package
  declares content, steps, commands, panels, runtime requirements, and security policy

kernel/runtime
  provides execution capability and optional sandboxing

MultiLab host
  resolves kernel, manages trust, stores saves, runs commands, and renders panels

.mlab-save
  stores learner progress separately from tutorial content
```

Docker should be the first official kernel provider, especially for gcc/OS tutorials. But Docker should not be the architecture itself. The architecture should make runtime providers, sandbox capabilities, package trust, and student saves explicit from the beginning.
