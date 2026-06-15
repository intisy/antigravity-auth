// @ts-nocheck
// Antigravity's AccountController: provider-owned status/quota + Verify / Refresh /
// Manage-proxies actions, layered on core-auth's generic list/enable/remove helper.

import { accountControllerFromManager, select, confirm, prompt } from "../../core-auth/dist/index.js";
import { ANTIGRAVITY_ENDPOINT_PROD, ANTIGRAVITY_DEFAULT_PROJECT_ID, getAntigravityHeaders } from "../constants.js";
import { login } from "./login.js";

function out(message) { process.stdout.write(message + "\n"); }

function antigravityStatus(account, now) {
  if (account.enabled === false) return "disabled";
  if (account.meta && account.meta.verificationRequired) return "verification-required";
  if (typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now) return "cooling-down";
  const lanes = account.rateLimitResetTimes || {};
  if (Object.values(lanes).some((reset) => typeof reset === "number" && reset > now)) return "rate-limited";
  return "active";
}

function antigravityQuota(account) {
  const cached = account.meta && account.meta.cachedQuota;
  if (!cached) return undefined;
  return Object.entries(cached).map(([label, quota]) => ({
    label,
    remainingFraction: quota && typeof quota.remainingFraction === "number" ? quota.remainingFraction : undefined,
    resetTime: quota && quota.resetTime,
  }));
}

async function verify(manager, view) {
  const name = view.email || view.id;
  try {
    const access = await manager.ensureAccess(view.id);
    if (!access) { out("✗ " + name + ": no access token"); return; }
    const account = manager.list().find((a) => a.id === view.id);
    const meta = (account && account.meta) || {};
    const projectId = meta.managedProjectId || meta.projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;
    const headers = { ...getAntigravityHeaders(), Authorization: "Bearer " + access, "Content-Type": "application/json" };
    if (projectId) headers["x-goog-user-project"] = projectId;
    const body = JSON.stringify({ model: "gemini-3-flash", request: { model: "gemini-3-flash", contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1, temperature: 0 } } });
    const aborter = new AbortController();
    const timer = setTimeout(() => aborter.abort(), 20000);
    let response;
    try { response = await fetch(ANTIGRAVITY_ENDPOINT_PROD + "/v1internal:streamGenerateContent?alt=sse", { method: "POST", headers, body, signal: aborter.signal }); }
    finally { clearTimeout(timer); }
    if (response.status === 200 || response.status === 400) out("✓ " + name + ": verified");
    else if (response.status === 401) out("✗ " + name + ": token expired or revoked (401)");
    else if (response.status === 403) out("✗ " + name + ": forbidden, may need verification (403)");
    else out("✗ " + name + ": " + response.status);
  } catch (error) { out("✗ " + name + ": " + (error && error.message || error)); }
}

async function verifyAll(manager) {
  for (const account of manager.list()) await verify(manager, { id: account.id, email: account.email });
  out("Done.");
}

async function refreshToken(manager, view) {
  const name = view.email || view.id;
  try { out(await manager.refresh(view.id) ? "✓ refreshed " + name : "✗ no OAuth config / refresh token for " + name); }
  catch (error) { out("✗ refresh failed for " + name + ": " + (error && error.message || error)); }
}

async function manageProxies(manager, view) {
  while (true) {
    const account = manager.list().find((a) => a.id === view.id);
    const proxies = (account && account.meta && account.meta.proxies) || [];
    const items = [
      { label: "Back", value: { t: "back" } },
      { label: "Add proxy URL", value: { t: "add" }, color: "cyan" },
    ];
    proxies.forEach((proxy, i) => items.push({ label: "Remove: " + proxy, value: { t: "rm", i }, color: "yellow" }));
    if (proxies.length) items.push({ label: "Clear all proxies", value: { t: "clear" }, color: "red" });

    const result = await select(items, { message: "Proxies: " + (view.email || view.id), subtitle: proxies.length + " configured", clearScreen: true });
    if (!result || result.t === "back") return;
    if (result.t === "add") { const url = await prompt("Proxy URL:"); if (url) manager.mutate(view.id, (a) => { a.meta = a.meta || {}; a.meta.proxies = [...(a.meta.proxies || []), url]; }); }
    else if (result.t === "clear") { if (await confirm("Clear all proxies?")) manager.mutate(view.id, (a) => { if (a.meta) a.meta.proxies = []; }); }
    else if (result.t === "rm") manager.mutate(view.id, (a) => { if (a.meta && a.meta.proxies) a.meta.proxies.splice(result.i, 1); });
  }
}

export function createAntigravityAccounts(manager) {
  return accountControllerFromManager(manager, {
    status: antigravityStatus,
    quota: antigravityQuota,
    login: async () => {
      const account = await login({ log: (message) => process.stderr.write(message + "\n") });
      return account ? { id: account.id, email: account.email, status: "active", enabled: true } : null;
    },
    actions: () => [{ label: "Verify all accounts", run: () => verifyAll(manager) }],
    accountActions: (view) => [
      { label: "Verify access", run: () => verify(manager, view) },
      { label: "Refresh token", run: () => refreshToken(manager, view) },
      { label: "Manage proxies", run: () => manageProxies(manager, view) },
    ],
  });
}
