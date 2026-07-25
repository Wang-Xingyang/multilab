# MultiLab

MultiLab is a local-first interactive tutorial player for programming labs.

It runs `.mlab`-style tutorial directories from a local tutorial repository. A tutorial declares its manifest in `multilab.json`, provides real Markdown/code/script files, and runs commands inside a kernel/runtime. The current official runtime is a Docker container for OS/C labs.

## Current Status

This repository is an early prototype of the MultiLab host:

- frontend: single-page `public/index.html` with Monaco Editor and xterm.js;
- backend: `server/index.js` with Express, WebSocket, and dockerode;
- runtime: `docker/os.Dockerfile` with Ubuntu, gcc, gdb, make, valgrind, strace;
- package format: tutorial directories with `multilab.json`;
- command model: manifest-declared `commands[]` with script files;
- step model: explicit `inherit_mode`;
- state: local step saves under `.multilab-state`.

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

The default `.env` points `TUTORIALS_DIR` at `../../tutorials`.

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

The manifest declares metadata, runtime requirements, panels, steps, `inherit_mode`, and commands. Script content is stored in real files and read only when executed.

See `docs/tutorial-authoring.md`.

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
