import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";

import { defaultCredentialStore } from "./credential-store.js";
import { defaultCredentialsRoot } from "../utils/paths.js";

export interface GitHubCopilotCredentials {
  access: string;
  refresh: string;
  expires: number;
  enterpriseUrl?: string;
}

export interface GitHubCopilotAuthOptions {
  enterpriseUrl?: string;
  credentialsPath?: string;
  openBrowser?: boolean;
}

export type GitHubAuthProvider = "github-copilot";

export interface GitHubAuthStatus {
  provider: GitHubAuthProvider;
  authenticated: boolean;
}

const CREDENTIAL_SERVICE = "alto";
const GITHUB_COPILOT_ACCOUNT = "github-copilot";
const COPILOT_CLIENT_ID = Buffer.from("SXYxLmI1MDdhMDhjODdlY2ZlOTg=", "base64").toString("utf8");
const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};
export function defaultGitHubCopilotCredentialsPath(): string {
  return join(defaultCredentialsRoot(), "github-copilot.json");
}

export async function loginWithGitHubCopilot(options: GitHubCopilotAuthOptions = {}): Promise<GitHubCopilotCredentials> {
  const enterpriseDomain = normalizeDomain(options.enterpriseUrl ?? "");
  if (options.enterpriseUrl?.trim() && !enterpriseDomain) {
    throw new Error("Invalid GitHub Enterprise URL/domain.");
  }

  const domain = enterpriseDomain ?? "github.com";
  const device = await requestCopilotDeviceCode(domain);
  const loginUrl = `${device.verification_uri}?user_code=${encodeURIComponent(device.user_code)}`;
  await announceDeviceCode(device.verification_uri, device.user_code);
  if (options.openBrowser !== false) {
    await openBrowser(loginUrl);
  }

  const githubAccessToken = await pollForGitHubAccessToken(domain, device);
  const credentials = await refreshGitHubCopilotToken(githubAccessToken, enterpriseDomain ?? undefined);
  await saveGitHubCopilotCredentials(credentials, options.credentialsPath);
  return credentials;
}

export async function getGitHubCopilotToken(
  options: { env?: Record<string, string>; credentialsPath?: string } = {},
): Promise<string> {
  const envToken =
    options.env?.COPILOT_GITHUB_TOKEN ??
    options.env?.GITHUB_COPILOT_TOKEN ??
    process.env.COPILOT_GITHUB_TOKEN ??
    process.env.GITHUB_COPILOT_TOKEN;
  if (envToken) {
    return envToken;
  }

  const credentials = await loadGitHubCopilotCredentials(options.credentialsPath);
  if (!credentials) {
    throw new Error("No GitHub Copilot token found. Run `alto auth login` or set COPILOT_GITHUB_TOKEN.");
  }

  if (Date.now() < credentials.expires - 60_000) {
    return credentials.access;
  }

  const refreshed = await refreshGitHubCopilotToken(credentials.refresh, credentials.enterpriseUrl);
  await saveGitHubCopilotCredentials(refreshed, options.credentialsPath);
  return refreshed.access;
}

export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
  if (token) {
    const match = token.match(/proxy-ep=([^;]+)/);
    const proxyHost = match?.[1];
    if (proxyHost) {
      return `https://${proxyHost.replace(/^proxy\./, "api.")}`;
    }
  }
  if (enterpriseDomain) {
    return `https://copilot-api.${enterpriseDomain}`;
  }
  return "https://api.individual.githubcopilot.com";
}

export async function loadGitHubCopilotCredentials(path = defaultGitHubCopilotCredentialsPath()): Promise<GitHubCopilotCredentials | undefined> {
  return loadCredentialJson<GitHubCopilotCredentials>(GITHUB_COPILOT_ACCOUNT, path, defaultGitHubCopilotCredentialsPath());
}

export async function getGitHubAuthStatus(provider: GitHubAuthProvider): Promise<GitHubAuthStatus> {
  const credentials = await loadGitHubCopilotCredentials();
  return { provider, authenticated: credentials !== undefined };
}

export async function saveGitHubCopilotCredentials(
  credentials: GitHubCopilotCredentials,
  path = defaultGitHubCopilotCredentialsPath(),
): Promise<void> {
  await saveCredentialJson(GITHUB_COPILOT_ACCOUNT, credentials, path, defaultGitHubCopilotCredentialsPath());
}

export async function deleteGitHubCopilotCredentials(path = defaultGitHubCopilotCredentialsPath()): Promise<void> {
  await deleteCredentialJson(GITHUB_COPILOT_ACCOUNT, path, defaultGitHubCopilotCredentialsPath());
}

export async function refreshGitHubCopilotToken(refreshToken: string, enterpriseDomain?: string): Promise<GitHubCopilotCredentials> {
  const domain = enterpriseDomain || "github.com";
  const response = await fetch(`https://api.${domain}/copilot_internal/v2/token`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_HEADERS,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub Copilot token request failed with status ${response.status}: ${await response.text()}`);
  }

  const raw = (await response.json()) as Record<string, unknown>;
  if (typeof raw.token !== "string" || typeof raw.expires_at !== "number") {
    throw new Error("Invalid GitHub Copilot token response.");
  }

  return {
    refresh: refreshToken,
    access: raw.token,
    expires: raw.expires_at * 1000 - 5 * 60 * 1000,
    enterpriseUrl: enterpriseDomain,
  };
}

async function requestCopilotDeviceCode(domain: string): Promise<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
}> {
  const response = await fetch(`https://${domain}/login/device/code`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    },
    body: new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub Copilot device-code request failed with status ${response.status}: ${await response.text()}`);
  }

  const raw = (await response.json()) as Record<string, unknown>;
  if (
    typeof raw.device_code !== "string" ||
    typeof raw.user_code !== "string" ||
    typeof raw.verification_uri !== "string" ||
    typeof raw.expires_in !== "number" ||
    (raw.interval !== undefined && typeof raw.interval !== "number")
  ) {
    throw new Error("Invalid GitHub Copilot device-code response.");
  }

  const verificationUri = new URL(raw.verification_uri);
  if (verificationUri.protocol !== "https:" && verificationUri.protocol !== "http:") {
    throw new Error("Untrusted GitHub Copilot verification URI.");
  }

  return {
    device_code: raw.device_code,
    user_code: raw.user_code,
    verification_uri: verificationUri.href,
    expires_in: raw.expires_in,
    interval: raw.interval,
  };
}

async function pollForGitHubAccessToken(
  domain: string,
  device: { device_code: string; expires_in: number; interval?: number },
): Promise<string> {
  const startedAt = Date.now();
  let intervalMs = (device.interval ?? 5) * 1000;

  while (Date.now() - startedAt < device.expires_in * 1000) {
    await sleep(intervalMs);
    const response = await fetch(`https://${domain}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "GitHubCopilotChat/0.35.0",
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub Copilot token polling failed with status ${response.status}: ${await response.text()}`);
    }

    const raw = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
    if (raw.access_token) {
      return raw.access_token;
    }
    if (raw.error === "authorization_pending") {
      continue;
    }
    if (raw.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(raw.error_description ?? raw.error ?? "Invalid GitHub Copilot token response.");
  }

  throw new Error("GitHub Copilot device authorization expired.");
}

async function loadCredentialJson<T>(account: string, path: string | undefined, legacyPath: string): Promise<T | undefined> {
  if (path && path !== legacyPath) {
    return readCredentialFile<T>(path);
  }

  const stored = await defaultCredentialStore.get(CREDENTIAL_SERVICE, account);
  if (stored) {
    return JSON.parse(stored) as T;
  }

  const legacy = await readCredentialFile<T>(legacyPath);
  if (legacy) {
    await defaultCredentialStore.set(CREDENTIAL_SERVICE, account, JSON.stringify(legacy));
  }
  return legacy;
}

async function saveCredentialJson(account: string, credentials: unknown, path: string | undefined, legacyPath: string): Promise<void> {
  if (path && path !== legacyPath) {
    await writeCredentialFile(path, credentials);
    return;
  }
  await defaultCredentialStore.set(CREDENTIAL_SERVICE, account, JSON.stringify(credentials));
}

async function deleteCredentialJson(account: string, path: string | undefined, legacyPath: string): Promise<void> {
  if (path && path !== legacyPath) {
    await rm(path, { force: true });
    return;
  }
  await defaultCredentialStore.delete(CREDENTIAL_SERVICE, account);
  await rm(legacyPath, { force: true });
}

async function readCredentialFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

async function writeCredentialFile(path: string, credentials: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function openBrowser(url: string): Promise<void> {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.log(`Could not open a browser automatically. Open this URL manually: ${url}`);
  });
  child.unref();
}

async function announceDeviceCode(verificationUri: string, userCode: string): Promise<void> {
  const copied = await copyToClipboard(userCode);
  console.log(`Open ${verificationUri} and enter code: ${userCode}`);
  console.log(copied ? "Copied the code to your clipboard." : "Could not copy the code to your clipboard; copy it manually.");
}

async function copyToClipboard(text: string): Promise<boolean> {
  const candidates =
    platform() === "darwin"
      ? [{ command: "pbcopy", args: [] }]
      : platform() === "win32"
        ? [{ command: "clip", args: [] }]
        : [
            { command: "wl-copy", args: [] },
            { command: "xclip", args: ["-selection", "clipboard"] },
            { command: "xsel", args: ["--clipboard", "--input"] },
          ];

  for (const candidate of candidates) {
    try {
      await writeToProcess(candidate.command, candidate.args, text);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function writeToProcess(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
    child.stdin.end(input);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
