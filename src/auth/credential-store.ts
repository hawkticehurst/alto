import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { defaultCredentialsRoot } from "../utils/paths.js";

const execFileAsync = promisify(execFile);

export interface CredentialStore {
  get(service: string, account: string): Promise<string | undefined>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

export class MacOSKeychainCredentialStore implements CredentialStore {
  async get(service: string, account: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      return stdout.trimEnd();
    } catch (error) {
      if (isSecurityNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async set(service: string, account: string, value: string): Promise<void> {
    await execFileAsync("security", ["add-generic-password", "-s", service, "-a", account, "-w", value, "-U"]);
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", account]);
    } catch (error) {
      if (isSecurityNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }
}

export class FileCredentialStore implements CredentialStore {
  constructor(readonly path = join(defaultCredentialsRoot(), "credentials.json")) {}

  async get(service: string, account: string): Promise<string | undefined> {
    const credentials = await this.read();
    return credentials[this.key(service, account)];
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const credentials = await this.read();
    credentials[this.key(service, account)] = value;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async delete(service: string, account: string): Promise<void> {
    const credentials = await this.read();
    delete credentials[this.key(service, account)];
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (Object.keys(credentials).length === 0) {
      await rm(this.path, { force: true });
      return;
    }
    await writeFile(this.path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, string>;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private key(service: string, account: string): string {
    return `${service}:${account}`;
  }
}

export class DefaultCredentialStore implements CredentialStore {
  readonly primary?: CredentialStore;
  readonly fallback: CredentialStore;

  constructor(primary = platform() === "darwin" ? new MacOSKeychainCredentialStore() : undefined, fallback = new FileCredentialStore()) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async get(service: string, account: string): Promise<string | undefined> {
    if (this.primary) {
      try {
        const value = await this.primary.get(service, account);
        if (value !== undefined) {
          return value;
        }
      } catch {
        // Fall back to file storage when the OS credential store is unavailable.
      }
    }
    return this.fallback.get(service, account);
  }

  async set(service: string, account: string, value: string): Promise<void> {
    if (this.primary) {
      try {
        await this.primary.set(service, account, value);
        return;
      } catch {
        // Fall back to file storage when the OS credential store is unavailable.
      }
    }
    await this.fallback.set(service, account, value);
  }

  async delete(service: string, account: string): Promise<void> {
    if (this.primary) {
      try {
        await this.primary.delete(service, account);
      } catch {
        // Still attempt fallback cleanup when the OS credential store is unavailable.
      }
    }
    await this.fallback.delete(service, account);
  }
}

export const defaultCredentialStore = new DefaultCredentialStore();

function isSecurityNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 44,
  );
}
