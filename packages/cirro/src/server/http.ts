import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { isTerminalRunStatus, type CirroRunRequest } from "../api/types.js";
import type { CirroConfig } from "../config/index.js";
import { authorizeRequest } from "../security/auth.js";
import type { CirroService } from "../service.js";
import type { RunStore } from "../store/file-store.js";

export interface CirroHttpServerOptions {
  config: CirroConfig;
  service: CirroService;
  store: RunStore;
}

export function createCirroHttpServer(options: CirroHttpServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, options);
    } catch (error) {
      writeJson(response, response.headersSent ? 500 : statusForError(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function routeRequest(request: IncomingMessage, response: ServerResponse, options: CirroHttpServerOptions): Promise<void> {
  const url = new URL(request.url ?? "/", "http://cirro.local");
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/runs") {
    if (!authorizeRequest(request, response, options.config, "write")) {
      return;
    }
    const body = (await readJsonBody(request)) as CirroRunRequest;
    const submitted = await options.service.submitRun(body, { type: "manual" });
    writeJson(response, 202, submitted);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runs") {
    if (!authorizeRequest(request, response, options.config, "read")) {
      return;
    }
    const limit = Number(url.searchParams.get("limit") ?? 50);
    writeJson(response, 200, { runs: await options.service.listRuns(Number.isFinite(limit) ? limit : 50) });
    return;
  }

  if (parts[0] !== "runs" || !parts[1]) {
    writeJson(response, 404, { error: "Not found" });
    return;
  }

  const runId = parts[1];

  if (request.method === "GET" && parts.length === 2) {
    if (!authorizeRequest(request, response, options.config, "read")) {
      return;
    }
    const run = await options.service.getRun(runId);
    if (!run) {
      writeJson(response, 404, { error: "Run not found" });
      return;
    }
    writeJson(response, 200, run);
    return;
  }

  if (request.method === "POST" && parts[2] === "cancel") {
    if (!authorizeRequest(request, response, options.config, "write")) {
      return;
    }
    writeJson(response, 200, await options.service.cancelRun(runId));
    return;
  }

  if (request.method === "GET" && parts[2] === "events") {
    if (!authorizeRequest(request, response, options.config, "read")) {
      return;
    }
    if (url.searchParams.get("stream") === "true" || request.headers.accept?.includes("text/event-stream")) {
      await streamEvents(response, runId, options);
      return;
    }
    writeJson(response, 200, { events: await options.store.readEvents(runId) });
    return;
  }

  if (request.method === "GET" && parts[2] === "transcript") {
    if (!authorizeRequest(request, response, options.config, "read")) {
      return;
    }
    const transcript = await options.store.readTranscript(runId);
    if (!transcript) {
      writeJson(response, 404, { error: "Transcript not found" });
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(transcript);
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}") as unknown);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

async function streamEvents(response: ServerResponse, runId: string, options: CirroHttpServerOptions): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let sent = 0;
  while (!response.closed) {
    const events = await options.store.readEvents(runId);
    for (const event of events.slice(sent)) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    sent = events.length;

    const run = await options.service.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) {
      response.write(`event: run_status\ndata: ${JSON.stringify({ runId, status: run?.status ?? "missing" })}\n\n`);
      response.end();
      return;
    }
    await sleep(1000);
  }
}

function statusForError(error: unknown): number {
  if (!(error instanceof Error)) {
    return 500;
  }
  if (error.message.includes("not found")) {
    return 404;
  }
  if (error.message.includes("must") || error.message.includes("requires") || error.message.includes("disabled")) {
    return 400;
  }
  return 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
