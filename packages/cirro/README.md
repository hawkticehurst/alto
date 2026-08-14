# cirro

Cirro is a self-hostable service for running Alto coding-agent jobs on a VPS, VM, or remote server.

## Quickstart

```bash
pnpm install
pnpm --filter cirro build
CIRRO_API_TOKEN=change-me pnpm --filter cirro dev -- serve --host 127.0.0.1 --port 3977
```

Submit a run:

```bash
curl -X POST http://127.0.0.1:3977/runs \
  -H 'authorization: Bearer change-me' \
  -H 'content-type: application/json' \
  -d '{
    "task": "Fix the failing tests",
    "source": { "type": "git", "repoUrl": "https://github.com/OWNER/REPO.git", "ref": "main" }
  }'
```

Inspect it:

```bash
curl -H 'authorization: Bearer change-me' http://127.0.0.1:3977/runs/<run-id>
curl -H 'authorization: Bearer change-me' http://127.0.0.1:3977/runs/<run-id>/events
curl -H 'authorization: Bearer change-me' http://127.0.0.1:3977/runs/<run-id>/transcript
```

## API

- `GET /health`
- `POST /runs`
- `GET /runs`
- `GET /runs/:id`
- `GET /runs/:id/events`
- `GET /runs/:id/events?stream=true`
- `GET /runs/:id/transcript`
- `POST /runs/:id/cancel`

`POST /runs` returns `202` immediately. A background worker executes the run and persists status, events, and transcript artifacts under `CIRRO_DATA_DIR`.

## Configuration

| Variable                           | Default                      | Description                                                                           |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `CIRRO_HOST`                       | `127.0.0.1`                  | Host to bind.                                                                         |
| `CIRRO_PORT`                       | `3977`                       | Port to bind.                                                                         |
| `CIRRO_DATA_DIR`                   | `~/.cirro`                   | Run records, transcripts, events, and cloned sources.                                 |
| `CIRRO_API_TOKEN`                  | unset                        | Bearer token for write endpoints. If unset, endpoints are open for local development. |
| `CIRRO_READ_TOKEN`                 | unset                        | Optional read-only bearer token.                                                      |
| `CIRRO_WORKER_CONCURRENCY`         | `1`                          | Number of in-process workers.                                                         |
| `CIRRO_MAX_QUEUED_RUNS`            | `100`                        | Queue backpressure limit.                                                             |
| `CIRRO_ALLOW_LOCAL_SOURCES`        | `false`                      | Enable local path sources.                                                            |
| `CIRRO_ALLOWED_LOCAL_SOURCE_ROOTS` | unset                        | Comma-separated local source roots.                                                   |
| `CIRRO_ALLOWED_GIT_HOSTS`          | unset                        | Comma-separated allowed Git hostnames. Empty allows any HTTPS/SSH Git host.           |
| `CIRRO_ALTO_PROVIDER`              | Alto default                 | `github-copilot` or `openai`.                                                         |
| `CIRRO_ALTO_MODEL`                 | Alto default                 | Default Alto model.                                                                   |
| `CIRRO_WORKSPACE_ROOT`             | `$CIRRO_DATA_DIR/workspaces` | Temporary Alto workspace root.                                                        |
| `CIRRO_DEFAULT_TIMEOUT_MS`         | `30000`                      | Default shell command timeout.                                                        |

Cirro does not apply agent execution limits. An Alto job runs until it completes, fails, or is manually stopped. `CIRRO_DEFAULT_TIMEOUT_MS` only bounds individual shell commands.

## Local sources

Local source paths are disabled by default because they allow remote callers to ask Cirro to copy host paths. To enable them:

```bash
CIRRO_ALLOW_LOCAL_SOURCES=true
CIRRO_ALLOWED_LOCAL_SOURCE_ROOTS=/srv/repos,/opt/work
```

## systemd sketch

```ini
[Unit]
Description=Cirro Alto service
After=network.target

[Service]
WorkingDirectory=/opt/cirro
EnvironmentFile=/etc/cirro.env
ExecStart=/usr/bin/pnpm --filter cirro start
Restart=on-failure
User=cirro

[Install]
WantedBy=multi-user.target
```
