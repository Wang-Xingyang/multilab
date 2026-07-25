# Deployment

MultiLab is currently optimized for local development and personal use.

The supported path today is:

```text
Node backend on the host/WSL
Docker runtime container managed by dockerode
Tutorial content loaded from a local tutorials repository
```

## Local Deployment

```bash
cd /home/wangxy/multilab-project/multilab
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/
cd server
npm install
cp .env.example .env
npm start
```

Open:

```text
http://localhost:3000
```

## Environment Variables

`server/.env`:

```text
PORT=3000
EXEC_IMAGE=multilab/os:latest
CONTAINER_NAME=multilab-session
TUTORIALS_DIR=../../tutorials
RUNTIME_STATE_DIR=../.multilab-state
```

## Docker Compose

The existing `docker-compose.yml` is not the main supported path while the project is moving toward the `.mlab` package/runtime model.

Before treating Compose as production-ready, update it to:

- mount the external tutorials repo or install `.mlab` packages;
- persist runtime state intentionally;
- avoid misleading `./tutorials` assumptions;
- keep Docker socket access restricted to the host service only.

## Production Notes

Running arbitrary tutorial code for other users is not safe with the current prototype.

Before any shared or public deployment:

- implement per-session containers;
- add resource limits;
- add trust and sandbox policy enforcement;
- avoid sharing a single container between users;
- audit Docker socket exposure;
- add cleanup and quota management.

For now, treat MultiLab as a local-first tool.
