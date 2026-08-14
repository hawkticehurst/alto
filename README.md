# Alto monorepo

This repository contains two packages:

- `packages/alto`: The Alto coding-agent runtime, SDK, model adapters, CLI, environments, and run artifact helpers.
- `packages/cirro`: A self-hostable service for running Alto jobs from HTTP requests, webhooks, cron jobs, and other remote triggers.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Run the Alto CLI during development:

```bash
pnpm dev:alto -- --task "Create a hello.txt file that says hello" --cwd /path/to/repo
```

Run the Cirro service during development:

```bash
pnpm dev:cirro -- serve --host 127.0.0.1 --port 3977
```

Submit a Cirro run:

```bash
curl -X POST http://127.0.0.1:3977/runs \
  -H 'content-type: application/json' \
  -d '{"task":"Investigate this repository","source":{"type":"git","repoUrl":"https://github.com/OWNER/REPO.git","ref":"main"}}'
```
