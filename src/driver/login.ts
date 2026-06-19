// @ts-nocheck
// Google OAuth login for antigravity. loginFlow() is the split begin/complete form core-auth's opencode oauth method drives; login() is the all-in-one form the CLI uses (opens the browser itself).

import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "node:readline";
import { startOAuthListener, addAccount, proxyManager, isTTY } from "../../core-auth/dist/index.js";
import { authorizeAntigravity, exchangeAntigravity, encodeState } from "../antigravity/oauth.js";
import { parseRefreshParts } from "../plugin/auth.js";
import { generateFingerprint } from "../plugin/fingerprint.js";
import { ANTIGRAVITY_REDIRECT_URI } from "../constants.js";

const PROVIDER_ID = "antigravity";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// Unconditional trace to a fixed file — the account-menu TUI clears the screen on
// every redraw, so stderr/errors from login() never stay visible. Read it with:
//   cat ~/.config/opencode/antigravity-login.log
function dbg(message) {
  try {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    appendFileSync(join(base, "opencode", "antigravity-login.log"), "[" + new Date().toISOString() + "] " + message + "\n");
  } catch {}
}

// A connection-level failure means the request never reached Google, so the auth
// code is untouched and a proxy-less retry is safe. (Grant/auth errors are NOT
// matched — those mean the code was consumed and must not be retried.)
function isConnectError(message) {
  return /unable to connect|failed to connect|could not connect|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|socket|proxy|tunnel|network/i.test(String(message || ""));
}

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
  let settled = false;
  const closeListener = () => { try { listener.close(); } catch {} };

  // shared finisher for both paths (pasted code + loopback callback): exchange the
  // code, save the account, bind its proxy. Guarded so only the first path wins.
  const finish = async (cb) => {
    if (settled) return null;
    if (!cb || !cb.code) { dbg("finish: no code -> returning null"); return null; }
    settled = true;
    try {
      // a pasted bare code has no state; rebuild it from this flow's own verifier
      const state = cb.state || encodeState({ verifier: authorization.verifier, projectId: authorization.projectId });
      let boundProxy = proxy;
      let result = await exchangeAntigravity(cb.code, state, { proxy });
      // A dead/unreachable login proxy bricks the token exchange (the request never
      // reaches Google, so the auth code is NOT consumed). Retry directly — a
      // non-working proxy provides no isolation anyway — and then DON'T bind it.
      if (result.type !== "success" && proxy && isConnectError(result.error)) {
        dbg("finish: proxied exchange could not connect via " + proxy + " — retrying directly");
        process.stderr.write("antigravity: login proxy " + proxy + " unreachable — retrying token exchange without a proxy.\n");
        boundProxy = null;
        result = await exchangeAntigravity(cb.code, state, {});
      }
      dbg("finish: token exchange -> " + result.type + (result.type !== "success" ? " | error: " + (result.error || "unknown") : " | email: " + (result.email || "?")) + " | proxy=" + (boundProxy || "direct"));
      if (result.type !== "success") {
        process.stderr.write("antigravity login failed — token exchange error: " + (result.error || "unknown") + "\n");
        return null;
      }
      const account = toCoreAccount(result);
      addAccount(PROVIDER_ID, account);
      dbg("finish: addAccount done id=" + account.id);
      if (boundProxy) proxyManager.bindAccountProxy(account.id, boundProxy);
      return account;
    } catch (error) {
      dbg("finish: THREW " + (error && error.stack || error));
      throw error;
    } finally {
      closeListener();
    }
  };

  return {
    url: authorization.url,
    instructions: "Sign in with Google — approve in your browser and we'll detect it automatically. In a container the localhost redirect won't load, so copy the full URL from your address bar (or just the code) and paste it here instead.",
    // paste fallback: opencode's "code" method + the in-tab paste both pass text
    complete: (input) => finish(parsePastedCallback(input)),
    // primary: the loopback listener fires when the browser reaches our localhost
    loopback: listener.waitForCallback()
      .then((url) => { dbg("loopback: listener fired"); return finish({ code: url.searchParams.get("code"), state: url.searchParams.get("state") }); })
      .catch((e) => { dbg("loopback: listener rejected/closed: " + (e && e.message || e)); return null; }),
    cancel: closeListener,
  };
}

export async function login(opts) {
  const log = (opts && opts.log) || ((message) => process.stderr.write(message + "\n"));
  const flow = await loginFlow();
  log("Open this URL in your browser to sign in with Google:\n\n  " + flow.url + "\n\nApprove in your browser — we'll detect it automatically. In a container the localhost page won't load; copy the full URL from your address bar and paste it below.\n");
  tryOpenBrowser(flow.url);
  // race the loopback auto-capture against a terminal paste; close the readline as
  // soon as either settles so a loopback win doesn't leave it dangling
  let account = null;
  if (isTTY()) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const pasteP = rl.question("Paste the full redirect URL from your browser (or just the code), then Enter: ").then((a) => flow.complete(a)).catch(() => null);
    account = await Promise.race([flow.loopback, pasteP]);
    try { rl.close(); } catch {}
  } else {
    account = await flow.loopback;
  }
  try { flow.cancel(); } catch {}
  if (!account) throw new Error("login failed");
  log("Logged in" + (account.email ? " as " + account.email : "") + " and saved to the antigravity account pool.");
  return account;
}
