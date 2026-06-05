import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AltoAgent,
  FileCredentialStore,
  FormatError,
  LocalEnvironment,
  OpenAIModel,
  Submitted,
  WorkspaceEnvironment,
  cleanWorkspaces,
  getRunPaths,
  listWorkspaces,
  defaultWorkspaceRoot,
  formatOutput,
  getGitHubCopilotBaseUrl,
  listRuns,
  readRunMetadata,
  writeRunMetadata,
} from "../src/index.js";
import type { AgentEvent, ExecutionOutput, Message, Model } from "../src/index.js";

class DeterministicModel implements Model {
  calls = 0;

  async query(): Promise<Message> {
    this.calls += 1;
    return {
      role: "assistant",
      content: "Submitting.",
      extra: {
        actions: [{ command: "printf 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\nall done\\n'" }],
        cost: 0,
      },
    };
  }

  formatMessage(message: Message): Message {
    return message;
  }

  formatObservationMessages(_message: Message, outputs: ExecutionOutput[]): Message[] {
    return outputs.map((out) => ({ role: "user", content: out.output, extra: { ...out } }));
  }

  getTemplateVars(): Record<string, unknown> {
    return { model_name: "deterministic" };
  }

  serialize(): Record<string, unknown> {
    return { info: { config: { model_type: "DeterministicModel" } } };
  }
}

test("LocalEnvironment raises Submitted on completion sentinel", async () => {
  const env = new LocalEnvironment();
  await assert.rejects(
    () => env.execute({ command: "printf 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\nfinal text\\n'" }),
    (error: unknown) => {
      assert.ok(error instanceof Submitted);
      assert.equal(error.messages[0]?.extra?.submission, "final text\n");
      return true;
    },
  );
});

test("AltoAgent runs a linear transcript and saves it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alto-"));
  const outputPath = join(dir, "transcript.json");

  try {
    const agent = new AltoAgent(new DeterministicModel(), new LocalEnvironment(), { outputPath });
    const result = await agent.run("finish immediately");

    assert.equal(result.exit_status, "Submitted");
    assert.equal(result.submission, "all done\n");

    const saved = JSON.parse(await readFile(outputPath, "utf8")) as { messages: Message[] };
    assert.equal(saved.messages.at(-1)?.role, "exit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AltoAgent accepts run requests and emits lifecycle events", async () => {
  const events: Array<AgentEvent & { timestamp: number }> = [];
  const agent = new AltoAgent(new DeterministicModel(), new LocalEnvironment(), {
    eventSink: {
      emit(event) {
        events.push(event);
      },
    },
  });

  const result = await agent.run({
    task: "finish immediately",
    context: { issue: 123 },
    verifyCommand: "pnpm test",
  });

  assert.equal(result.exit_status, "Submitted");
  assert.ok(events.some((event) => event.type === "run_started"));
  assert.ok(events.some((event) => event.type === "model_call_started"));
  assert.ok(events.some((event) => event.type === "action_started"));
  assert.ok(events.some((event) => event.type === "run_finished"));
});

test("LocalEnvironment does not forward arbitrary process env to commands", async () => {
  process.env.ALTO_TEST_SECRET = "should-not-leak";
  try {
    const env = new LocalEnvironment();
    const output = await env.execute({ command: "printf ${ALTO_TEST_SECRET:-missing}" });
    assert.equal(output.output, "missing");
  } finally {
    delete process.env.ALTO_TEST_SECRET;
  }
});

test("WorkspaceEnvironment copies source into an ephemeral workspace and cleans up", async () => {
  const source = await mkdtemp(join(tmpdir(), "alto-source-"));
  await writeFile(join(source, "file.txt"), "hello", "utf8");
  const env = new WorkspaceEnvironment({ sourcePath: source });

  try {
    await env.prepare({ task: "inspect workspace" });
    const workspacePath = env.getTemplateVars().workspace_cwd;
    assert.equal(typeof workspacePath, "string");
    assert.ok((workspacePath as string).startsWith(defaultWorkspaceRoot()));

    const output = await env.execute({ command: "test -f file.txt && printf ok" });
    assert.equal(output.output, "ok");

    await env.cleanup();
    await assert.rejects(() => access(workspacePath as string));
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("workspace helpers list and clean Alto workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "alto-workspace-root-"));
  const workspace = await mkdtemp(join(root, "alto-workspace-"));
  await mkdtemp(join(root, "unrelated-"));

  const workspaces = await listWorkspaces(root);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]?.path, workspace);

  const cleaned = await cleanWorkspaces(root);
  assert.equal(cleaned.length, 1);
  await assert.rejects(() => access(workspace));
  await rm(root, { recursive: true, force: true });
});

test("run metadata helpers save and list runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "alto-runs-"));
  const paths = getRunPaths("run-test", root);
  await writeRunMetadata(paths, {
    runId: paths.runId,
    status: "running",
    task: "test",
    provider: "github-copilot",
    model: "gpt-5.4",
    startedAt: "2026-01-01T00:00:00.000Z",
    transcriptPath: paths.transcriptPath,
    eventsPath: paths.eventsPath,
    stepLimit: 0,
  });

  assert.equal((await readRunMetadata("run-test", root))?.task, "test");
  assert.equal((await listRuns(root)).length, 1);
  await rm(root, { recursive: true, force: true });
});

test("formatOutput elides long command output", () => {
  const formatted = formatOutput({ output: "a".repeat(12), returncode: 0 }, 10);
  assert.equal(formatted.elided_chars, 2);
  assert.equal(formatted.output_head, "aaaaa");
  assert.equal(formatted.output_tail, "aaaaa");
});

test("OpenAIModel rejects assistant messages without bash tool calls", async () => {
  const model = new OpenAIModel({ modelName: "test" });
  const parseActions = model as unknown as {
    parseActions(toolCalls: []): never;
  };

  assert.throws(() => parseActions.parseActions([]), FormatError);
});

test("getGitHubCopilotBaseUrl derives API host from token proxy endpoint", () => {
  assert.equal(
    getGitHubCopilotBaseUrl("tid=1;proxy-ep=proxy.business.githubcopilot.com;exp=123"),
    "https://api.business.githubcopilot.com",
  );
});

test("FileCredentialStore saves and reads credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alto-credentials-"));
  try {
    const store = new FileCredentialStore(join(dir, "credentials.json"));
    await store.set("alto", "github-copilot", "secret-value");
    assert.equal(await store.get("alto", "github-copilot"), "secret-value");
    assert.equal(await store.get("alto", "missing"), undefined);
    await store.delete("alto", "github-copilot");
    assert.equal(await store.get("alto", "github-copilot"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
