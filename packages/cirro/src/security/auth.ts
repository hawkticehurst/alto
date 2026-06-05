import type { IncomingMessage, ServerResponse } from "node:http";

import type { CirroConfig } from "../config/index.js";

export type AuthScope = "read" | "write";

export function authorizeRequest(request: IncomingMessage, response: ServerResponse, config: CirroConfig, scope: AuthScope): boolean {
  const accepted = acceptedTokens(config, scope);
  if (accepted.length === 0) {
    return true;
  }

  const token = readToken(request);
  if (token && accepted.includes(token)) {
    return true;
  }

  response.writeHead(401, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify({ error: "Unauthorized" })}\n`);
  return false;
}

function acceptedTokens(config: CirroConfig, scope: AuthScope): string[] {
  if (scope === "write") {
    return config.apiToken ? [config.apiToken] : [];
  }
  return [config.apiToken, config.readToken].filter((token): token is string => Boolean(token));
}

function readToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const header = request.headers["x-cirro-token"];
  return Array.isArray(header) ? header[0] : header;
}
