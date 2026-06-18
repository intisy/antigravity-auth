// @ts-nocheck
// Google OAuth login for antigravity. loginFlow() is the split begin/complete form core-auth's opencode oauth method drives; login() is the all-in-one form the CLI uses (opens the browser itself).

import { spawn } from "child_process";
import { createInterface } from "node:readline";
import { startOAuthListener, addAccount, proxyManager, isTTY } from "../../core-auth/dist/index.js";
import { authorizeAntigravity, exchangeAntigravity, encodeState } from "../antigravity/oauth.js";
import { parseRefreshParts } from "../plugin/auth.js";
import { generateFingerprint } from "../plugin/fingerprint.js";
import { ANTIGRAVITY_REDIRECT_URI } from "../constants.js";

const PROVIDER_ID = "antigravity";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// accept either the full redirect URL (code + state) or a bare code pasted alone
function parsePastedCallback(input) {
  const text = (input || "").trim();
  if (!text) return null;
  const codeMatch = text.match(/[?&]code=([^&\s]+)/);
  if (codeMatch) {
    const stateMatch = text.match(/[?&]state=([^&\s]+)/);
    return { code: decodeURIComponent(codeMatch[1]), state: stateMatch ? decodeURIComponent(stateMatch[1]) : null };
  }
  return { code: text, state: null };
}

// the loopback listener only fires when the browser can reach this host's localhost
// (not the case in a container), so race it against a manual paste of the URL/code
function awaitCallback(listener) {
  const auto = listener.waitForCallback()
    .then((url) => ({ code: url.searchParams.get("code"), state: url.searchParams.get("state") }))
    .catch(() => null);
  if (!isTTY()) return auto;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = new Promise((resolve) => {
    rl.question("Paste the full redirect URL from your browser's address bar (or just the code) here, then press Enter: ", (answer) => resolve(parsePastedCallback(answer)));
  });
  return Promise.race([auto, pasted]).finally(() => { try { rl.close(); } catch {} });
}

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
  // bind a proxy to this new account up front so the token exchange + project
  // discovery never touch Google from the server's own IP
  const proxy = proxyManager.pickForLogin();
  const authorization = await authorizeAntigravity();
  const listener = await startOAuthListener(ANTIGRAVITY_REDIRECT_URI, { timeoutMs: LOGIN_TIMEOUT_MS });
  return {
    url: authorization.url,
    instructions: "Sign in with Google. In a container the localhost redirect won't load — copy the full URL from your browser's address bar (or just the code) and paste it here.",
    complete: async (input) => {
      try {
        // opencode (method "code") passes the pasted code / redirect URL; the CLI
        // passes nothing and we race the loopback listener against a terminal paste.
        const cb = input ? parsePastedCallback(input) : await awaitCallback(listener);
        if (!cb || !cb.code) return null;
        // a pasted bare code has no state; rebuild it from this flow's own verifier
        const state = cb.state || encodeState({ verifier: authorization.verifier, projectId: authorization.projectId });
        const result = await exchangeAntigravity(cb.code, state, { proxy });
        if (result.type !== "success") {
          process.stderr.write("antigravity login failed — token exchange error: " + (result.error || "unknown") + "\n");
          return null;
        }
        const account = toCoreAccount(result);
        addAccount(PROVIDER_ID, account);
        proxyManager.bindAccountProxy(account.id, proxy);
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
  log("Open this URL in your browser to sign in with Google:\n\n  " + flow.url + "\n\nAfter approving, your browser will try to open a localhost page. In a container it won't load — that's expected. Copy the full URL from your browser's address bar and paste it below.\n");
  tryOpenBrowser(flow.url);
  const account = await flow.complete();
  if (!account) throw new Error("login failed");
  log("Logged in" + (account.email ? " as " + account.email : "") + " and saved to the antigravity account pool.");
  return account;
}
