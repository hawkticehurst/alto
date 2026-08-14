import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeterministicModel } from "alto/testing";
import {
  CirroService,
  CirroWorker,
  FileRunStore,
  InMemoryRunQueue,
  createCirroApp,
  loadCirroConfig,
} from "../src/index.js";
import type { CirroConfig } from "../src/index.js";

test("loadCirroConfig parses service defaults from env", () => {
  const config = loadCirroConfig({
    CIRRO_DATA_DIR: "/tmp/cirro-test",
    CIRRO_PORT: "4000",
    CIRRO_WORKER_CONCURRENCY: "2",
    CIRRO_ALLOWED_GIT_HOSTS: "github.com,example.com",
  });

  assert.equal(config.port, 4000);
  assert.equal(config.workerConcurrency, 2);
  assert.deepEqual(config.allowedGitHosts, ["github.com", "example.com"]);
});

test("CirroService queues a run and CirroWorker executes it with Alto", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cirro-"));
  const config = testConfig(dir);
  const store = new FileRunStore(dir);
  const queue = new InMemoryRunQueue();
  const service = new CirroService({ config, store, queue });
  const worker = new CirroWorker({
    config,
    store,
    queue,
    altoDefaults: {
      model: new DeterministicModel(),
      workspace: false,
    },
  });

  try {
    worker.start();
    const submitted = await service.submitRun({ task: "finish immediately", workspace: false });
    const finished = await waitForRun(store, submitted.runId);

    assert.equal(submitted.status, "queued");
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.result?.status, "submitted");
    assert.equal(typeof (await store.readTranscript(submitted.runId)), "string");
    assert.ok((await store.readEvents(submitted.runId)).some((event) => event.type === "run_finished"));
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CirroService cancels a queued run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cirro-"));
  const config = testConfig(dir);
  const store = new FileRunStore(dir);
  const queue = new InMemoryRunQueue();
  const service = new CirroService({ config, store, queue });

  try {
    const submitted = await service.submitRun({ task: "later", workspace: false });
    const cancelled = await service.cancelRun(submitted.runId);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(queue.size(), 0);
  } finally {
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Cirro app handles Web Standard Request objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cirro-"));
  const config = testConfig(dir);
  const store = new FileRunStore(dir);
  const queue = new InMemoryRunQueue();
  const service = new CirroService({ config, store, queue });
  const app = createCirroApp({ config, service, store });

  try {
    const health = await app.fetch(new Request("http://cirro.local/health"));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const submitted = await app.fetch(new Request("http://cirro.local/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "run through a Web Request", workspace: false }),
    }));
    assert.equal(submitted.status, 202);
    assert.equal((await submitted.json() as { status: string }).status, "queued");
  } finally {
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function testConfig(dataDir: string): CirroConfig {
  return {
    ...loadCirroConfig({ CIRRO_DATA_DIR: dataDir }),
    defaultTimeoutMs: 30_000,
  };
}

async function waitForRun(store: FileRunStore, runId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const run = await store.getRun(runId);
    if (run && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled" || run.status === "timed_out")) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for run.");
}
