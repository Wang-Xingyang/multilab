# Troubleshooting

Keep this file focused on current failures. Do not preserve obsolete prototype mistakes.

## No Tutorials Listed

Check `server/.env`:

```text
TUTORIALS_DIR=../../tutorials
```

Then verify each tutorial has:

```text
multilab.json
steps/
```

Run:

```bash
cd /home/wangxy/multilab-project/multilab
python3 docs/tutorial-skill/scripts/validate_tutorial.py ../tutorials/hello-c
```

## Runtime Image Missing

If startup says the execution image is missing:

```bash
cd /home/wangxy/multilab-project/multilab
docker build -t multilab/os:latest -f docker/os.Dockerfile docker/
```

## Docker Not Reachable

Verify Docker Desktop WSL integration is enabled, then:

```bash
docker version
docker ps
```

The backend uses dockerode and must be able to access the Docker daemon.

## Frontend Script Errors

Run the inline script parser:

```bash
cd /home/wangxy/multilab-project/multilab
node -e "const fs=require('fs'); const vm=require('vm'); const html=fs.readFileSync('public/index.html','utf8'); const scripts=[...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]).join('\\n'); new vm.Script(scripts); console.log('inline script syntax OK');"
```

## Commands Do Not Run

Confirm the step has a command in `multilab.json`:

```json
{
  "id": "run",
  "type": "run",
  "script": "steps/01-example/commands/run.sh",
  "terminal": "interactive"
}
```

Check:

- `script` is package-relative;
- script file exists;
- `terminal` is `interactive` for the Run button;
- captured commands use `POST /api/commands/run`.

## Terminal Garbled Output

The backend should use dockerode `demuxStream()` for Docker hijack streams.

Do not manually strip Docker frame bytes.

## Resetting Runtime State

Runtime saves live under:

```text
multilab/.multilab-state/
```

Delete that directory only when intentionally resetting local progress.
