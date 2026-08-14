# alto

An opinionated coding agent that puts humans back in the loop.

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

`--cwd <path>` selects the source directory. By default, Alto copies that directory into an ephemeral workspace under `~/.alto/workspaces/alto-workspace-*`, runs model-proposed shell commands in the copy, and deletes the copy after the run. `--workspace-root <path>` changes only the parent directory where that temporary copy is created; it does not change cleanup behavior. Use `--preserve-workspace` to retain a temporary workspace for inspection.

`--no-workspace` changes the execution mode: Alto runs directly in `--cwd` (or its own current directory when `--cwd` is omitted), without copying or deleting anything. This mode lets the agent modify the selected directory directly.

Workspace management:

```bash
alto workspaces list
alto workspaces clean
```

The default provider is `github-copilot` and the default model is `gpt-5.4`. Alto does not impose agent execution limits: it continues until the task is submitted, the run fails, or it is manually stopped. `--timeout` remains available to bound an individual shell command; it is not a run-level limit.

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
alto -t "Implement feature X" --cwd /path/to/repo --events
```

## Service mode

Use the `cirro` package for a self-hostable Alto service that accepts remote run requests, webhooks, and scheduled jobs.

## Environment variables

Alto loads `.env.alto.agent` explicitly for model/provider credentials. The agent-env file path is resolved from the directory where Alto is launched, not from `--cwd` or the temporary workspace. Its values are not forwarded to shell commands unless you allowlist keys with `--agent-env`; the flag is for controlled shell access to selected secrets, not for model authentication.

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

await alto.run({
  task: "Implement feature X",
  workspace: { sourcePath: "/path/to/repo" },
});
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
  model?: {
    provider?: "github-copilot" | "openai";
    name?: string;
    baseUrl?: string;
  };
  limits?: {
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
