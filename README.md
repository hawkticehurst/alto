# alto

A tiny coding agent meant for cloud-style developer environments.

## Setup

```bash
pnpm install
pnpm build
pnpm link --global
```

After linking, the CLI is available as `alto`.

## Authentication

Alto defaults to GitHub Copilot and uses GitHub's device-code browser flow:

```bash
alto auth login
```

The login code is copied to your clipboard when possible, then Alto opens the GitHub verification page. Credentials are stored in the OS credential store when available. On macOS, Alto uses Keychain and only falls back to a restricted file under `~/.alto/credentials` if Keychain is unavailable.

Manage credentials with:

```bash
alto auth status
alto auth logout
```

## Run

```bash
alto --task "Create a hello.txt file that says hello" --cwd /path/to/repo
```

or during development:

```bash
pnpm dev -- --task "Fix the failing tests" --cwd /path/to/repo
```

By default, Alto copies `--cwd` into an ephemeral workspace under `~/.alto/workspaces/alto-workspace-*`, runs model-proposed shell commands there, and deletes the workspace after the run. Use `--preserve-workspace` to inspect the workspace afterward, `--workspace-root <path>` to choose a different workspace parent, or `--no-workspace` to run directly in `--cwd`.

Workspace management:

```bash
alto workspaces list
alto workspaces clean
```

The default provider is `github-copilot` and the default model is `gpt-5.4`. The default step limit is `0`, which means unlimited model calls. Set `--step-limit <number>` to cap a run.

Every run gets a generated run ID and is saved under `~/.alto/runs/<run-id>/` by default:

```text
metadata.json
transcript.json
events.jsonl
```

Inspect saved runs with:

```bash
alto runs list
alto runs show <run-id>
```

Useful options:

```bash
alto --help
alto -t "Implement feature X" --model gpt-5.4
alto -t "Implement feature X" --setup-command "pnpm install" --verify-command "pnpm test"
alto -t "Investigate this repo" --cwd /path/to/repo --step-limit 20 --events
```

## Service mode

For a minimal cloud-agent-style wrapper, start the local HTTP service:

```bash
alto serve --host 127.0.0.1 --port 3977
```

Submit a run:

```bash
curl -X POST http://127.0.0.1:3977/runs \
  -H 'content-type: application/json' \
  -d '{
    "task": "Create a hello.txt file that says hello",
    "workspace": { "sourcePath": "/path/to/repo" },
    "model": { "provider": "github-copilot", "name": "gpt-5.4" },
    "limits": { "stepLimit": 20 },
    "environment": { "agentEnv": [] }
  }'
```

Use `Accept: text/event-stream` or `?stream=true` to receive lifecycle events while the run executes.

## Environment variables

Alto loads `.env.alto.agent` explicitly for model/provider credentials, but does not forward those values to shell commands unless you allowlist keys with `--agent-env`.

```bash
echo "OPENAI_API_KEY=..." > .env.alto.agent
alto -t "Implement feature X" --provider openai --model gpt-4.1-mini

echo "MY_SERVICE_TOKEN=..." >> .env.alto.agent
alto -t "Use the service API" --agent-env MY_SERVICE_TOKEN
```

Shell commands inherit only a small safe set of host variables such as `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, and `LC_ALL`.

## Library use

The root `alto` import is the stable public SDK. It exposes a small facade for running Alto without manually wiring a model, environment, transcript store, and event sinks.

```ts
import { runAlto } from "alto";

const result = await runAlto({
  task: "Fix the failing tests",
  workspace: { sourcePath: "/path/to/repo", preserve: true },
  model: { provider: "github-copilot", name: "gpt-5.4" },
  limits: { stepLimit: 20 },
  events: {
    onEvent(event) {
      console.log(event.type);
    },
  },
});

console.log(result.status, result.submission);
```

For repeated use, create an SDK client with defaults:

```ts
import { Alto } from "alto";

const alto = new Alto({
  model: { provider: "openai", name: "gpt-5.4-mini" },
  workspace: { root: "/tmp/alto-workspaces" },
});

await alto.run({ task: "Implement feature X", workspace: { sourcePath: "/path/to/repo" } });
```

The supported package entrypoints are:

```text
alto                       runAlto, createAgent, Alto, SDK request/result/event types
alto/core                  AltoAgent, config, errors, model/environment contracts
alto/models                OpenAIModel and GitHubCopilotModel adapters
alto/environments          LocalEnvironment and WorkspaceEnvironment
alto/events                EventSink implementations
alto/runs                  run metadata and transcript helpers
alto/auth/github-copilot   GitHub Copilot login/logout/token/status helpers
alto/testing               deterministic model and in-memory event sink test helpers
```

The SDK `AltoRunRequest` shape is:

```ts
{
  task: string;
  context?: Record<string, unknown>;
  setupCommand?: string;
  verifyCommand?: string;
  model?: {
    provider?: "github-copilot" | "openai";
    name?: string;
    baseUrl?: string;
  };
  limits?: {
    stepLimit?: number;
    costLimit?: number;
    wallTimeLimitSeconds?: number;
    timeoutMs?: number;
  };
  workspace?: {
    sourcePath?: string;
    root?: string;
    preserve?: boolean;
  } | false;
  environment?: {
    cwd?: string;
    env?: Record<string, string>;
    agentEnvFile?: string;
    agentEnv?: string[] | string;
    inheritEnv?: string[];
    timeoutMs?: number;
  };
  output?: {
    runId?: string;
    runsRoot?: string;
    transcriptPath?: string;
    eventsPath?: string;
    writeEvents?: boolean;
  };
  events?: {
    onEvent?: (event: AltoEvent) => void | Promise<void>;
    sink?: EventSink;
    sinks?: EventSink[];
    console?: boolean;
  };
}
```

Advanced callers can import `AltoAgent`, `Model`, and `Environment` from `alto/core` and construct their own runtime. CLI and service adapters are intentionally not part of the root SDK surface.
