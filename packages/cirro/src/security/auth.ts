import type { CirroConfig } from "../config/index.js";

export type AuthScope = "read" | "write";

export function authorizeRequest(request: Request, config: CirroConfig, scope: AuthScope): Response | undefined {
  const accepted = acceptedTokens(config, scope);
  if (accepted.length === 0) {
    return undefined;
  }

  const token = readToken(request);
  if (token && accepted.includes(token)) {
    return undefined;
  }

  return jsonResponse(401, { error: "Unauthorized" });
}

function acceptedTokens(config: CirroConfig, scope: AuthScope): string[] {
  if (scope === "write") {
    return config.apiToken ? [config.apiToken] : [];
  }
  return [config.apiToken, config.readToken].filter((token): token is string => Boolean(token));
}

function readToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return request.headers.get("x-cirro-token") ?? undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
