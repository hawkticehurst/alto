import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

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

export type CirroFetchHandler = (request: Request) => Promise<Response>;

export interface CirroApp {
  fetch: CirroFetchHandler;
}

export function createCirroApp(options: CirroHttpServerOptions): CirroApp {
  return {
    fetch: (request) => routeRequest(request, options),
  };
}

export function createCirroHttpServer(options: CirroHttpServerOptions): Server {
  const app = createCirroApp(options);
  return createServer(async (request, response) => {
    try {
      await writeNodeResponse(response, await app.fetch(toWebRequest(request, response)));
    } catch (error) {
      await writeNodeResponse(response, jsonResponse(statusForError(error), {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });
}

async function routeRequest(request: Request, options: CirroHttpServerOptions): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse(200, { ok: true });
  }

  if (request.method === "POST" && url.pathname === "/runs") {
    const unauthorized = authorizeRequest(request, options.config, "write");
    if (unauthorized) {
      return unauthorized;
    }
    const body = (await readJsonBody(request)) as CirroRunRequest;
    const submitted = await options.service.submitRun(body, { type: "manual" });
    return jsonResponse(202, submitted);
  }

  if (request.method === "GET" && url.pathname === "/runs") {
    const unauthorized = authorizeRequest(request, options.config, "read");
    if (unauthorized) {
      return unauthorized;
    }
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return jsonResponse(200, { runs: await options.service.listRuns(Number.isFinite(limit) ? limit : 50) });
  }

  if (parts[0] !== "runs" || !parts[1]) {
    return jsonResponse(404, { error: "Not found" });
  }

  const runId = parts[1];

  if (request.method === "GET" && parts.length === 2) {
    const unauthorized = authorizeRequest(request, options.config, "read");
    if (unauthorized) {
      return unauthorized;
    }
    const run = await options.service.getRun(runId);
    if (!run) {
      return jsonResponse(404, { error: "Run not found" });
    }
    return jsonResponse(200, run);
  }

  if (request.method === "POST" && parts[2] === "cancel") {
    const unauthorized = authorizeRequest(request, options.config, "write");
    if (unauthorized) {
      return unauthorized;
    }
    return jsonResponse(200, await options.service.cancelRun(runId));
  }

  if (request.method === "GET" && parts[2] === "events") {
    const unauthorized = authorizeRequest(request, options.config, "read");
    if (unauthorized) {
      return unauthorized;
    }
    if (url.searchParams.get("stream") === "true" || request.headers.get("accept")?.includes("text/event-stream")) {
      return streamEvents(request.signal, runId, options);
    }
    return jsonResponse(200, { events: await options.store.readEvents(runId) });
  }

  if (request.method === "GET" && parts[2] === "transcript") {
    const unauthorized = authorizeRequest(request, options.config, "read");
    if (unauthorized) {
      return unauthorized;
    }
    const transcript = await options.store.readTranscript(runId);
    if (!transcript) {
      return jsonResponse(404, { error: "Transcript not found" });
    }
    return new Response(transcript, { headers: { "Content-Type": "application/json" } });
  }

  return jsonResponse(404, { error: "Not found" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null && Number(contentLengthHeader) > 1_000_000) {
    throw new HttpError(413, "Request body is too large.");
  }
  const body = await request.text();
  if (body.length > 1_000_000) {
    throw new HttpError(413, "Request body is too large.");
  }
  try {
    return JSON.parse(body || "{}") as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function streamEvents(signal: AbortSignal, runId: string, options: CirroHttpServerOptions): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sent = 0;
      try {
        while (!signal.aborted) {
          const events = await options.store.readEvents(runId);
          for (const event of events.slice(sent)) {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          }
          sent = events.length;

          const run = await options.service.getRun(runId);
          if (!run || isTerminalRunStatus(run.status)) {
            controller.enqueue(encoder.encode(`event: run_status\ndata: ${JSON.stringify({ runId, status: run?.status ?? "missing" })}\n\n`));
            break;
          }
          await sleep(1000);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function statusForError(error: unknown): number {
  if (error instanceof HttpError) {
    return error.status;
  }
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

function toWebRequest(request: IncomingMessage, response: ServerResponse): Request {
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? "GET";
  const init: RequestInit = {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(request) as unknown as ReadableStream,
    signal: controller.signal,
  };
  return new Request(
    new URL(request.url ?? "/", `http://${request.headers.host ?? "cirro.local"}`),
    { ...init, duplex: "half" } as RequestInit & { duplex: "half" },
  );
}

async function writeNodeResponse(response: ServerResponse, result: Response): Promise<void> {
  if (response.headersSent) {
    return;
  }
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  if (!result.body) {
    response.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(result.body as unknown as import("node:stream/web").ReadableStream)) {
    if (!response.write(chunk)) {
      await new Promise<void>((resolve) => response.once("drain", resolve));
    }
  }
  response.end();
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
