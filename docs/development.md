# Development

## Workspace

Use the WSL workspace:

```text
/home/wangxy/multilab-project/
  multilab/
  tutorials/
  .ai/
```

The three child directories are separate git repositories.

## Local Setup

`TUTORIALS_DIR` must point at `../../tutorials` so the catalog is `hello-c` (the player test package). Do not point it at `os-deep-dive` while working on the player.

The Docker image below is the **current prototype** lab. The target is a student-provided machine (start with this WSL via local spawn; SSH later). Do not add player features that only work on bind-mount.

Build the runtime image:

```bash
cd /home/wangxy/multilab-project/multilab
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/
```

Install backend dependencies:

```bash
cd server
npm install
cp .env.example .env
```

`server/.env` should point at the content repo:

```text
TUTORIALS_DIR=../../tutorials
```

Start:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Checks

```bash
cd /home/wangxy/multilab-project/multilab
node --check server/index.js
python3 docs/tutorial-skill/scripts/validate_tutorial.py ../tutorials/hello-c
node -e "const fs=require('fs'); const vm=require('vm'); const html=fs.readFileSync('public/index.html','utf8'); const scripts=[...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]).join('\\n'); new vm.Script(scripts); console.log('inline script syntax OK');"
```

## Current Architecture Boundaries

- Tutorials require `multilab.json`.
- Frontend uses `step.commands`.
- Interactive execution uses WebSocket `type: "command"`.
- Captured execution uses `POST /api/commands/run`.
- Docker code is still in `server/index.js`; next refactor should extract a runtime provider.

## Git Notes

Do not create commits unless explicitly requested.

Keep the three repositories separate:

- `multilab/`
- `tutorials/`
- `.ai/`
