# MultiLab

MultiLab is a local-first interactive tutorial player for programming labs.

It runs tutorial packages that declare a `multilab.json` manifest, provide real Markdown/code/script files, and execute commands inside a kernel/runtime. The current official runtime is a Docker container for OS/C labs. Tutorials can also be packed as `.mlab` archives and imported into a local package library.

## Current Status

This repository is an early prototype of the MultiLab host:

- frontend: single-page `public/index.html` with Monaco Editor and xterm.js;
- backend: Node ESM services behind `server/index.js` (Express + WebSocket);
- runtime: `docker/os.Dockerfile` behind a `RuntimeProvider` abstraction;
- package format: `multilab.json` directories and `.mlab` ZIP packages;
- package sources: development directories under `TUTORIALS_DIR` and imported packages under `.multilab-state/packages/`;
- command model: manifest-declared `commands[]` with script files;
- security: digest-keyed trust store (default `untrusted`) and command-time security policy gates;
- kernels: static `KernelRegistry` with `gcc-ubuntu24-docker` and simple version matching;
- saves: versioned step files plus `save.json` progress metadata under `.multilab-state/saves/`.

The long-term product direction is documented in:

```text
../MULTILAB_PRODUCT_ARCHITECTURE_SPEC.md
```

## Repository Layout

The outer workspace contains three separate git repositories:

```text
multilab-project/
  multilab/      # this framework repo
  tutorials/     # tutorial content repo
  .ai/           # shared agent memory repo
```

Inside this repo:

```text
multilab/
  docker/
    os.Dockerfile
  public/
    index.html
  server/
    index.js
    runtime/
    services/
    package.json
    .env.example
  docs/
    architecture.md
    tutorial-authoring.md
    tutorial-skill/
```

Tutorial content lives outside this repo by default:

```text
../tutorials/
  hello-c/
    multilab.json
    steps/
```

## Quick Start

Prerequisites:

- Docker Desktop with WSL integration enabled;
- Node.js 20+;
- npm.

Build the OS runtime image:

```bash
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/
```

Install backend dependencies:

```bash
cd server
npm install
cp .env.example .env
```

The default `.env` points `TUTORIALS_DIR` at `../../tutorials` and stores runtime state under `../.multilab-state`.

Start the server:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Tutorial Format

Each tutorial is a directory with a required `multilab.json` manifest:

```text
tutorials/<id>/
  multilab.json
  steps/
    01-example/
      instructions.md
      files/
        main.c
      commands/
        run.sh
        test.sh
```

The manifest declares metadata, runtime requirements, security policy, panels, steps, `inherit_mode`, and commands. Script content is stored in real files and read only when executed.

See `docs/tutorial-authoring.md`.

## Packages, Trust, and Saves

Development tutorials under `TUTORIALS_DIR` remain openable by id, for example `/api/tutorials/hello-c`.

Imported `.mlab` packages are unpacked under:

```text
.multilab-state/packages/<id>/<version>/<digest>/unpacked/
```

They appear in `/api/tutorials` with a digest-derived `source_key` such as `pkg-<sha256hex>`. The UI "打开 .mlab" button uploads a browser-selected file to `POST /api/packages/upload`, imports it into the library, and opens it. Host-path import via `POST /api/packages/import` remains available for automation.

Trust is keyed by package digest and defaults to `untrusted`. The UI can toggle `untrusted` / `user-trusted` through `/api/trust`. Command execution is gated by `SecurityPolicyService`: untrusted or sandbox-required packages need a sandbox-capable kernel, and network-disabled packages require a kernel with `network_default: none`.

Step saves are stored by package identity:

```text
.multilab-state/saves/<id>/<version>/<digest>/steps/<step>/files/
.multilab-state/saves/<id>/<version>/<digest>/save.json
```

`save.json` currently tracks `current_step`, `visited`, `test_passed`, and `updated_at`. Progress can be exported/imported as a `.mlab-save` archive:

```text
POST /api/saves/download { tutorial }   # browser download
POST /api/saves/upload                  # browser upload
POST /api/saves/export { tutorial, path }
POST /api/saves/import { path }
```

Import matches package `id` / `version` / `digest`. If the package is missing, import returns `package_missing` and the original `.mlab` must be opened/imported first.

## Checks

Server syntax:

```bash
cd multilab
node --check server/index.js
```

Tutorial validation:

```bash
cd multilab
python3 docs/tutorial-skill/scripts/validate_tutorial.py ../tutorials/hello-c
```

Frontend inline script syntax:

```bash
cd multilab
node -e "const fs=require('fs'); const vm=require('vm'); const html=fs.readFileSync('public/index.html','utf8'); const scripts=[...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]).join('\\n'); new vm.Script(scripts); console.log('inline script syntax OK');"
```

Pack / unpack a tutorial package:

```bash
cd multilab
python3 docs/tutorial-skill/scripts/pack_mlab.py ../tutorials/hello-c -o /tmp/hello-c.mlab
python3 docs/tutorial-skill/scripts/unpack_mlab.py /tmp/hello-c.mlab -o /tmp/hello-c-unpacked
```

## Documentation

- `docs/architecture.md`: current host/runtime/package architecture.
- `docs/tutorial-authoring.md`: how to write `multilab.json` tutorials.
- `docs/tutorial-skill/`: guidance and assets for AI-generated tutorials.
- `../MULTILAB_PRODUCT_ARCHITECTURE_SPEC.md`: product-level target architecture.

## Development Notes

- Do not add new `tutorial.json` support.
- Do not reintroduce `run_cmd`, `has_run`, `has_test`, `/api/test`, or WebSocket `type: "run"`.
- New execution should go through manifest `commands[]`.
- Docker is the first official runtime provider, not the permanent architecture boundary.
- Keep trust defaulting to untrusted and network defaulting to denied unless a package explicitly requires it.
- Prefer service boundaries: PackageService, PackageLibrary, SaveService, CommandService, SecurityPolicyService, TrustStore, KernelRegistry.
