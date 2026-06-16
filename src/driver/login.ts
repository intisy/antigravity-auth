// @ts-nocheck
// Google OAuth login for antigravity. loginFlow() is the split begin/complete form core-auth's opencode oauth method drives; login() is the all-in-one form the CLI uses (opens the browser itself).

import { spawn } from "child_process";
import { startOAuthListener, addAccount } from "../../core-auth/dist/index.js";
import { authorizeAntigravity, exchangeAntigravity } from "../antigravity/oauth.js";
import { parseRefreshParts } from "../plugin/auth.js";
import { generateFingerprint } from "../plugin/fingerprint.js";
import { ANTIGRAVITY_REDIRECT_URI } from "../constants.js";

const PROVIDER_ID = "antigravity";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function tryOpenBrowser(url) {
  try {
    const platform = process.platform;
    const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
    const args = platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});   // missing xdg-open/open emits an async error event, not a throw
    child.unref();
  } catch {}
}

function toCoreAccount(result) {
  const parts = parseRefreshParts(result.refresh);
  const account = {
    id: result.email || parts.refreshToken.slice(0, 16),
    email: result.email,
    refresh: parts.refreshToken,
    access: result.access,
    expires: result.expires,
    addedAt: Date.now(),
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    meta: { projectId: result.projectId || parts.projectId, managedProjectId: parts.managedProjectId },
  };
  try { account.meta.fingerprint = generateFingerprint(); } catch {}
  return account;
}

export async function loginFlow() {
  const authorization = await authorizeAntigravity();
  const listener = await startOAuthListener(ANTIGRAVITY_REDIRECT_URI, { timeoutMs: LOGIN_TIMEOUT_MS });
  return {
    url: authorization.url,
    instructions: "Sign in with Google in your browser; the terminal continues automatically.",
    complete: async () => {
      try {
        const callbackUrl = await listener.waitForCallback();
        const code = callbackUrl.searchParams.get("code");
        const state = callbackUrl.searchParams.get("state");
        if (!code || !state) return null;
        const result = await exchangeAntigravity(code, state);
        if (result.type !== "success") return null;
        const account = toCoreAccount(result);
        addAccount(PROVIDER_ID, account);
        return account;
      } finally {
        try { await listener.close(); } catch {}
      }
    },
  };
}

export async function login(opts) {
  const log = (opts && opts.log) || ((message) => process.stderr.write(message + "\n"));
  const flow = await loginFlow();
  log("Open this URL in your browser to authenticate with Google:\n\n  " + flow.url + "\n");
  tryOpenBrowser(flow.url);
  const account = await flow.complete();
  if (!account) throw new Error("login failed");
  log("Logged in" + (account.email ? " as " + account.email : "") + " and saved to the antigravity account pool.");
  return account;
}
