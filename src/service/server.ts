import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AgentRunRequest } from "../core/types.js";
import type { AgentEvent, EventSink } from "../runs/events.js";
import { executeRun, type CliOptions } from "../cli/run.js";

export interface ServeOptions extends CliOptions {
  host: string;
  port: string;
}

export async function startServer(options: ServeOptions): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method !== "POST" || !request.url?.startsWith("/runs")) {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const body = await readJsonBody(request);
      const runRequest = normalizeServiceRunRequest(body);
      const stream =
        request.headers.accept?.includes("text/event-stream") ||
        new URL(request.url, "http://alto.local").searchParams.get("stream") === "true";
      const runOptions = serviceOptionsForRequest(options, runRequest);

      if (stream) {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const execution = await executeRun(runOptions, runRequest, {
          interactive: false,
          eventSink: new ServerSentEventSink(response),
        });
        response.write(`event: run_result\ndata: ${JSON.stringify(execution)}\n\n`);
        response.end();
        return;
      }

      const execution = await executeRun(runOptions, runRequest, { interactive: false });
      writeJson(response, 200, execution);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (response.headersSent) {
        response.write(`event: run_error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        response.end();
      } else {
        writeJson(response, 500, { error: message });
      }
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(Number(options.port), options.host, resolve);
  });
  console.log(`Alto service listening on http://${options.host}:${options.port}`);
}

function normalizeServiceRunRequest(body: unknown): AgentRunRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be a JSON object.");
  }
  const request = body as AgentRunRequest;
  if (typeof request.task !== "string" || request.task.trim().length === 0) {
    throw new Error("Request body must include a non-empty task string.");
  }
  return request;
}

function serviceOptionsForRequest(options: ServeOptions, request: AgentRunRequest): CliOptions {
  return {
    ...options,
    task: request.task,
    provider: request.model?.provider ?? options.provider,
    model: request.model?.name ?? options.model,
    baseUrl: request.model?.baseUrl ?? options.baseUrl,
    cwd: request.workspace?.sourcePath ?? options.cwd,
    workspaceRoot: request.workspace?.root ?? options.workspaceRoot,
    preserveWorkspace: request.workspace?.preserve ?? options.preserveWorkspace,
    stepLimit: String(request.limits?.stepLimit ?? options.stepLimit ?? 0),
    costLimit: String(request.limits?.costLimit ?? options.costLimit ?? 0),
    wallTimeLimitSeconds: String(request.limits?.wallTimeLimitSeconds ?? options.wallTimeLimitSeconds ?? 0),
    timeout: String(request.limits?.timeoutMs ?? options.timeout ?? 30_000),
    agentEnvFile: request.environment?.agentEnvFile ?? options.agentEnvFile,
    agentEnv: request.environment?.agentEnv?.join(",") ?? options.agentEnv,
  };
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
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

class ServerSentEventSink implements EventSink {
  constructor(readonly response: ServerResponse) {}

  emit(event: AgentEvent & { timestamp: number }): void {
    this.response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}
