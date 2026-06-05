import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const UNSET = Symbol("UNSET");

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recursiveMerge(...objects: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const object of objects) {
    if (!object) {
      continue;
    }

    for (const [key, value] of Object.entries(object)) {
      if (value === UNSET) {
        continue;
      }

      if (isPlainObject(result[key]) && isPlainObject(value)) {
        result[key] = recursiveMerge(result[key] as Record<string, unknown>, value);
      } else if (isPlainObject(value)) {
        result[key] = recursiveMerge(value);
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

export function getPath(vars: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (isPlainObject(current) && part in current) {
      return current[part];
    }
    return undefined;
  }, vars);
}

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = getPath(vars, key);
    if (value === undefined) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return String(value);
  });
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
