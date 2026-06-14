// @ts-nocheck
// Google OAuth login for antigravity, on core-auth. Runs the existing PKCE flow
// (antigravity/oauth) over core-auth's generic local-callback listener, then
// persists the result as a CoreAccount via core-auth addAccount. The same core
// store is read by both the OpenCode loader and the Claude proxy, so one login
// works everywhere; no provider-side storage or app coupling.

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
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
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
    meta: {
      projectId: result.projectId || parts.projectId,
      managedProjectId: parts.managedProjectId,
    },
  };
  try { account.meta.fingerprint = generateFingerprint(); } catch {}
  return account;
}

// run the full browser login; resolves with the persisted CoreAccount.
export async function login(opts) {
  const log = (opts && opts.log) || ((message) => process.stderr.write(message + "\n"));
  const authorization = await authorizeAntigravity();
  const listener = await startOAuthListener(ANTIGRAVITY_REDIRECT_URI, { timeoutMs: LOGIN_TIMEOUT_MS });
  try {
    log("Open this URL in your browser to authenticate with Google:\n\n  " + authorization.url + "\n");
    tryOpenBrowser(authorization.url);
    const callbackUrl = await listener.waitForCallback();
    const code = callbackUrl.searchParams.get("code");
    const state = callbackUrl.searchParams.get("state");
    if (!code || !state) throw new Error("OAuth callback missing code/state");
    const result = await exchangeAntigravity(code, state);
    if (result.type !== "success") throw new Error("Token exchange failed: " + result.error);
    const account = toCoreAccount(result);
    addAccount(PROVIDER_ID, account);
    log("Logged in" + (account.email ? " as " + account.email : "") + " and saved to the antigravity account pool.");
    return account;
  } finally {
    try { await listener.close(); } catch {}
  }
}
