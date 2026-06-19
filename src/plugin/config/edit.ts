/**
 * Config read/write helpers for the generic settings UI exposed by core-auth.
 *
 * - getConfigValue resolves a dotted path against the EFFECTIVE config
 *   (defaults + env overrides) so the UI shows what is actually in effect.
 * - setConfigValue mutates the RAW user JSON file (never the defaulted config)
 *   and persists it, so only explicit overrides are written.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, getUserConfigPath } from "./loader";
import { createLogger } from "../logger";

const log = createLogger("config-edit");

/**
 * Resolve a dotted path against an object, returning undefined if any segment
 * is missing.
 */
function getPath(target: Record<string, any>, key: string): any {
  const segments = key.split(".");
  let current: any = target;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Set a dotted path on an object, creating intermediate objects as needed.
 */
function setPath(target: Record<string, any>, key: string, value: any): void {
  const segments = key.split(".");
  let current: Record<string, any> = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (current[segment] == null || typeof current[segment] !== "object") {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
}

/**
 * Delete a dotted path from an object, pruning now-empty parent objects.
 */
function deletePath(target: Record<string, any>, key: string): void {
  const segments = key.split(".");
  // Walk down, remembering each parent so empty ones can be pruned afterwards.
  const parents: Array<{ container: Record<string, any>; segment: string }> = [];
  let current: Record<string, any> = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (current[segment] == null || typeof current[segment] !== "object") return;
    parents.push({ container: current, segment });
    current = current[segment];
  }
  delete current[segments[segments.length - 1]];

  for (let index = parents.length - 1; index >= 0; index--) {
    const { container, segment } = parents[index];
    if (container[segment] && Object.keys(container[segment]).length === 0) {
      delete container[segment];
    } else {
      break;
    }
  }
}

/**
 * Get the current EFFECTIVE value for a dotted config key.
 * Reflects schema defaults + env overrides + user/project file values.
 */
export function getConfigValue(key: string): any {
  try {
    const config = loadConfig(process.cwd());
    return getPath(config as Record<string, any>, key);
  } catch (error) {
    log.warn("getConfigValue failed", { key, error: String(error) });
    return undefined;
  }
}

/**
 * Persist a dotted config key to the RAW user JSON file.
 * value === undefined resets the key (deletes it, pruning empty parents).
 * Never throws; logs and returns on failure.
 */
export function setConfigValue(key: string, value: any): void {
  try {
    const path = getUserConfigPath();

    let raw: Record<string, any> = {};
    if (existsSync(path)) {
      try {
        raw = JSON.parse(readFileSync(path, "utf-8")) || {};
      } catch (error) {
        log.warn("setConfigValue: invalid JSON, starting fresh", { path, error: String(error) });
        raw = {};
      }
    }

    if (value === undefined) {
      deletePath(raw, key);
    } else {
      setPath(raw, key, value);
    }

    const directory = dirname(path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  } catch (error) {
    log.warn("setConfigValue failed", { key, error: String(error) });
  }
}
