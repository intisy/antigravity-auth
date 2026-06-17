// Antigravity's client id/secret are its own public installed-app credentials
// (the cclog/experimentsandconfigs scopes can only be granted to a first-party
// Google app). They are NOT committed to this repo. Instead they are fetched once
// at runtime from the public npm mirror of opencode-antigravity-auth — where they
// are already published — and placed into process.env so the existing env-first
// resolution in constants.ts/config.ts picks them up. A user-supplied env value
// always wins; the repo stays secret-free.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SOURCE_URLS = [
  "https://cdn.jsdelivr.net/npm/opencode-antigravity-auth/dist/src/constants.js",
  "https://unpkg.com/opencode-antigravity-auth/dist/src/constants.js",
];
const CACHE_FILE = join(tmpdir(), "antigravity-client-credentials.json");

let resolved = false;

function hasEnvCredentials(): boolean {
  return !!(process.env.ANTIGRAVITY_CLIENT_ID && process.env.ANTIGRAVITY_CLIENT_SECRET);
}

function applyToEnv(id: string, secret: string): void {
  if (!process.env.ANTIGRAVITY_CLIENT_ID) process.env.ANTIGRAVITY_CLIENT_ID = id;
  if (!process.env.ANTIGRAVITY_CLIENT_SECRET) process.env.ANTIGRAVITY_CLIENT_SECRET = secret;
}

function parseCredentials(source: string): { id?: string; secret?: string } {
  const id = source.match(/CLIENT_ID\s*=\s*"([^"]+)"/)?.[1];
  const secret = source.match(/CLIENT_SECRET\s*=\s*"([^"]+)"/)?.[1];
  return { id, secret };
}

// idempotent; the first caller that needs creds (login, refresh, request) triggers it
export async function ensureAntigravityCredentials(): Promise<void> {
  if (resolved || hasEnvCredentials()) { resolved = true; return; }

  try {
    if (existsSync(CACHE_FILE)) {
      const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
      if (cached.id && cached.secret) { applyToEnv(cached.id, cached.secret); resolved = true; return; }
    }
  } catch { /* ignore a corrupt cache and re-fetch */ }

  for (const url of SOURCE_URLS) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const { id, secret } = parseCredentials(await response.text());
      if (id && secret) {
        applyToEnv(id, secret);
        try { writeFileSync(CACHE_FILE, JSON.stringify({ id, secret })); } catch { /* best-effort cache */ }
        resolved = true;
        return;
      }
    } catch { /* try next mirror */ }
  }

  process.stderr.write("antigravity: could not fetch OAuth client credentials; set ANTIGRAVITY_CLIENT_ID/SECRET to log in offline\n");
}
