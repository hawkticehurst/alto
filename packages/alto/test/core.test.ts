import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAlto } from "../src/index.js";
import { AltoAgent, FormatError, Submitted, type Message } from "../src/core/index.js";
import { LocalEnvironment, WorkspaceEnvironment, cleanWorkspaces, listWorkspaces } from "../src/environments/index.js";
import { OpenAIModel } from "../src/models/index.js";
import { getRunPaths, listRuns, readRunMetadata, writeRunMetadata } from "../src/runs/index.js";
import type { AgentEvent } from "../src/runs/index.js";
import { getGitHubCopilotBaseUrl } from "../src/auth/github-copilot.js";
import { DeterministicModel, InMemoryEventSink } from "../src/testing/index.js";
import { FileCredentialStore } from "../src/auth/credential-store.js";
import { formatOutput } from "../src/models/openai.js";
import { defaultWorkspaceRoot } from "../src/utils/paths.js";

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

test("runAlto provides a curated root SDK facade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alto-sdk-"));
  const events = new InMemoryEventSink();

  try {
    const result = await runAlto({
      task: "finish immediately",
      model: new DeterministicModel(),
      workspace: false,
      output: { runsRoot: dir },
      events: { sink: events },
    });

    assert.equal(result.status, "submitted");
    assert.equal(result.submission, "all done\n");
    assert.equal(result.metadata.status, "succeeded");
    assert.ok(result.transcriptPath.startsWith(dir));
    assert.ok(events.events.some((event) => event.type === "run_finished"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
