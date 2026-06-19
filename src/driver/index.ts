// @ts-nocheck
// The antigravity driver: a thin object on top of core-auth. core-auth owns
// account storage, selection, token refresh, and rate-limit/cooldown state; this
// driver owns only the antigravity-specific request transform + endpoint dispatch,
// reusing the existing plugin/request + plugin/project + plugin/transform code.

import { defineProvider, AccountManager, proxyManager, getAutoCandidates } from "../../core-auth/dist/index.js";
import { prepareAntigravityRequest, transformAntigravityResponse, generateSyntheticProjectId } from "../plugin/request.js";
import { ensureProjectContext } from "../plugin/project.js";
import { fetchAvailableModels, buildAntigravityCatalog } from "../plugin/models-fetch.js";
import { formatRefreshParts, parseRefreshParts } from "../plugin/auth.js";
import { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_ENDPOINT_PROD } from "../constants.js";
import { models } from "./models.js";
import { oauthConfig } from "./config.js";
import { laneFor, headerStyleFor, parseRateLimitReason, resetTimeFor } from "./lanes.js";
import { login, loginFlow } from "./login.js";
import { createAntigravityAccounts } from "./accounts-controller.js";
import { getConfigValue, setConfigValue, loadConfig, initRuntimeConfig, DEFAULT_CONFIG } from "../plugin/config/index.js";

const PROVIDER_ID = "antigravity";
const MAX_ATTEMPTS = 6;   // total account/endpoint attempts before giving up

// User config, loaded once at startup (changes apply on restart). Only the handful
// of keys actually consumed by this provider are wired below — account selection
// (core-auth's engine), the Claude request flags passed into prepareAntigravityRequest,
// and keep_thinking (read by the request transform via getKeepThinking). The other
// historical AntigravityConfig keys have no consumer here, so the settings UI omits them.
let config;
try { config = loadConfig(process.cwd()); } catch { config = DEFAULT_CONFIG; }
initRuntimeConfig(config);   // so getKeepThinking() in the request transform reads keep_thinking

// core-auth account engine. The driver availability hook keeps antigravity's
// "skip accounts pending Google verification" behavior without leaking it into core.
const manager = new AccountManager(PROVIDER_ID, {
  selection: config.account_selection_strategy || "hybrid",
  oauth: oauthConfig(),
  isAvailable: (account) => !(account.meta && account.meta.verificationRequired),
});

// reconstruct the OAuthAuthDetails the existing project/transform code expects;
// the legacy refresh string packs the project ids that ensureProjectContext reads.
function buildAuth(account, access) {
  const meta = account.meta || {};
  return {
    type: "oauth",
    access,
    expires: account.expires,
    refresh: formatRefreshParts({ refreshToken: account.refresh, projectId: meta.projectId, managedProjectId: meta.managedProjectId }),
  };
}

function endpointsFor(headerStyle) {
  return headerStyle === "gemini-cli" ? [ANTIGRAVITY_ENDPOINT_PROD] : [...ANTIGRAVITY_ENDPOINT_FALLBACKS];
}

function isRateLimitStatus(status) {
  return status === 429 || status === 503 || status === 529;
}

// model id without depending on the (currently broken) url-helpers module
function modelFromRequest(url, bodyText, ctxModel) {
  if (ctxModel) return ctxModel;
  const match = typeof url === "string" && url.match(/\/models\/([^:/?]+)/);
  if (match) return decodeURIComponent(match[1]);
  try { const parsed = JSON.parse(bodyText || "{}"); if (parsed.model) return parsed.model; } catch {}
  return "antigravity-auto";
}

// a stable per-account project id, so accounts without a discovered managed
// project never share the same x-goog-user-project (which would correlate them)
function syntheticProjectFor(account) {
  let synthetic = account.meta && account.meta.syntheticProjectId;
  if (!synthetic) {
    synthetic = generateSyntheticProjectId();
    manager.mutate(account.id, (a) => { a.meta = a.meta || {}; a.meta.syntheticProjectId = synthetic; });
  }
  return synthetic;
}

async function resolveProjectId(account, access, log, proxy) {
  const meta = account.meta || {};
  const fallbackProjectId = syntheticProjectFor(account);
  let projectId = meta.managedProjectId || meta.projectId || "";
  try {
    const result = await ensureProjectContext(buildAuth(account, access), { proxy, fallbackProjectId });
    if (result && result.effectiveProjectId) projectId = result.effectiveProjectId;
    const discovered = parseRefreshParts(result.auth.refresh).managedProjectId;
    if (discovered && discovered !== meta.managedProjectId) {
      manager.mutate(account.id, (a) => { a.meta = a.meta || {}; a.meta.managedProjectId = discovered; });
    }
  } catch (error) { log("ensureProjectContext failed: " + error); }
  return projectId || fallbackProjectId;
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
}

// Run one model through the account/endpoint attempt loop. Returns the upstream
// response (transformed on success); a rate-limit status means "all accounts for
// this model's lane are spent" so the Auto caller can fall through to the next.
async function attemptModel(model, url, init, ctx, log) {
  const lane = laneFor(model);
  const headerStyle = headerStyleFor(model);
  let lastResponse = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const acquired = await manager.acquire(lane);
    if (!acquired || !acquired.account) {
      // No account free for this lane — almost always its quota pool is spent.
      const next = manager.nextAvailableAt(lane);
      const secs = next ? Math.max(0, Math.round((next - Date.now()) / 1000)) : 0;
      const msg = secs > 0
        ? `${lane} quota exhausted — resets in ~${secs}s. Pick another model or use Auto (it falls through to a free pool).`
        : `No available antigravity account for lane ${lane}.`;
      return errorResponse(503, msg);
    }
    const account = acquired.account;
    const access = acquired.access;
    if (!access) { manager.reportError(account.id, attempt, "missing access token"); continue; }

    const proxyUrl = proxyManager.selectForAccount(account.id);
    const projectId = await resolveProjectId(account, access, log, proxyUrl);

    let rateLimited = false;
    for (const endpoint of endpointsFor(headerStyle)) {
      let prepared;
      try {
        prepared = prepareAntigravityRequest(url, init, access, projectId, endpoint, headerStyle, false, {
          fingerprint: account.meta && account.meta.fingerprint,
          claudeToolHardening: config.claude_tool_hardening,
          claudePromptAutoCaching: config.claude_prompt_auto_caching,
          debugGeminiPayloads: config.debug_gemini_payloads,
        });
      } catch (error) { log("prepare failed: " + error); continue; }
      if (proxyUrl) prepared.init.proxy = proxyUrl;   // Bun fetch honors .proxy

      let response;
      let proxyOk = false;
      const started = Date.now();
      try { response = await fetch(prepared.request, prepared.init); proxyOk = !!proxyUrl; }
      catch (error) {
        if (proxyUrl) {
          proxyManager.reportResult(proxyUrl, false);
          // proxy unreachable -> retry this request directly (a dead proxy gives
          // no isolation anyway, and otherwise every account/attempt fails).
          log("fetch via proxy " + proxyUrl + " failed: " + error + " — retrying directly");
          try {
            const directInit = { ...prepared.init };
            delete directInit.proxy;
            response = await fetch(prepared.request, directInit);
          } catch (directError) { log("direct retry failed: " + directError); continue; }
        } else { log("fetch failed: " + error); continue; }
      }
      if (proxyOk) proxyManager.reportResult(proxyUrl, true, Date.now() - started);

      if (!response.ok) {
        let snippet = "";
        try { snippet = (await response.clone().text()).slice(0, 300); } catch {}
        log("antigravity response " + response.status + " from " + endpoint + (snippet ? " body: " + snippet : ""));
      }

      if (isRateLimitStatus(response.status)) {
        rateLimited = true;
        lastResponse = response;
        let reason, message;
        try {
          let j = await response.clone().json();
          if (Array.isArray(j)) j = j[0];   // cloudcode-pa returns [{error}] for capacity 429s
          message = j && j.error && j.error.message;
          reason = j && j.error && (j.error.status || j.error.reason);
        } catch {}
        const parsed = parseRateLimitReason(reason, message, response.status);
        // honor the server's stated reset ("...reset after 38s") so a short rolling
        // window (e.g. the Gemini CLI free pool) isn't over-blocked by our backoff.
        const retryMatch = message && /reset(?:s)?\s+(?:after|in)\s+(\d+)\s*s/i.exec(message);
        const retryAfterMs = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : 0;
        manager.reportRateLimit(account.id, lane, resetTimeFor(parsed, attempt, retryAfterMs));
        if (proxyUrl) proxyManager.reportRateLimit(proxyUrl);   // possible IP rate-limit -> penalize the proxy
        continue;   // next endpoint, then rotate account
      }

      if (response.ok) {
        manager.reportSuccess(account.id);
        return await transformAntigravityResponse(
          response, prepared.streaming, null,
          prepared.requestedModel, prepared.projectId, prepared.endpoint,
          prepared.effectiveModel, prepared.sessionId,
        );
      }

      // Non-ok, non-rate-limit (e.g. 403 "no valid license" from a sandbox
      // endpoint the account isn't provisioned for): keep the response and try
      // the next endpoint. Only the last endpoint's error is surfaced.
      lastResponse = response;
      continue;
    }

    if (!rateLimited) break;
  }
  return lastResponse || errorResponse(502, "antigravity request failed after " + MAX_ATTEMPTS + " attempts");
}

function isAutoModel(model) {
  const stripped = String(model || "").replace(/^antigravity-/i, "");
  return stripped === "auto" || stripped.startsWith("auto-");
}

function rewriteModelInUrl(url, model) {
  return String(url).replace(/\/models\/[^:/?]+/, "/models/" + model);
}

async function handle(request, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  const url = request.url;
  let bodyText;
  try { bodyText = await request.clone().text(); } catch { bodyText = undefined; }
  const requestedModel = modelFromRequest(url, bodyText, ctx && ctx.model);
  const init = { method: request.method, headers: Object.fromEntries(request.headers), body: bodyText };

  // Auto: walk the user-ranked candidate models, falling through to the next when
  // one is rate-limited (smart fallback). Non-auto models run exactly once.
  let candidates = [requestedModel];
  if (isAutoModel(requestedModel)) {
    const ranked = getAutoCandidates(PROVIDER_ID);   // full catalog ids (already prefixed)
    if (ranked.length) candidates = ranked;
  }

  let lastResponse = null;
  for (const model of candidates) {
    const candidateUrl = candidates.length > 1 ? rewriteModelInUrl(url, model) : url;
    const response = await attemptModel(model, candidateUrl, init, ctx, log);
    lastResponse = response;
    if (!response || !isRateLimitStatus(response.status)) return response;   // success / non-retryable
    if (candidates.length > 1) log("auto: " + model + " rate-limited (" + response.status + "); trying next candidate");
  }
  return lastResponse || errorResponse(502, "all antigravity Auto candidates exhausted");
}

// Live model discovery for core-auth: pick the first usable account, fetch the
// account's real available models, and build the catalog (+ ranking/default for
// Auto). Returns null when no account exists or the fetch fails -> core-auth then
// falls back to the cache (or an empty catalog before first login).
async function fetchModels(ctx) {
  const log = (ctx && ctx.log) || (() => {});
  const account = manager.list().find((a) => a.enabled !== false && a.refresh);
  if (!account) return null;
  let access;
  try { access = await manager.ensureAccess(account.id); } catch (error) { log("fetchModels token refresh failed: " + error); return null; }
  if (!access) return null;
  const proxyUrl = proxyManager.selectForAccount(account.id);
  const projectId = await resolveProjectId(account, access, log, proxyUrl);
  const payload = await fetchAvailableModels(access, projectId, proxyUrl, log);
  if (!payload) return null;
  return buildAntigravityCatalog(payload);
}

// Settings shown in core-auth's settings UI. ONLY options actually consumed by
// this provider at runtime are listed — verified by tracing each to its consumer:
//   account_selection_strategy -> AccountManager(selection) above
//   keep_thinking              -> request transform via getKeepThinking() (initRuntimeConfig above)
//   claude_tool_hardening / claude_prompt_auto_caching / debug_gemini_payloads
//                              -> passed into prepareAntigravityRequest options in handle()
// The other historical AntigravityConfig keys (scheduling/rate-limit/quota/health/
// token-bucket/recovery/notifications/etc.) have NO consumer in the core-auth
// provider form — their behavior is owned by core-auth's own engine — so exposing
// them would let users set no-ops. They are intentionally omitted.
const settingsGroups = [
  {
    title: "Account rotation",
    fields: [
      { key: "account_selection_strategy", label: "Account selection", type: "enum", options: ["sticky", "round-robin", "hybrid"], hint: "How accounts are picked: sticky keeps prompt cache, round-robin maximizes throughput, hybrid balances by availability." },
    ],
  },
  {
    title: "Claude request handling",
    fields: [
      { key: "keep_thinking", label: "Keep thinking blocks", type: "bool", hint: "Preserve Claude thinking blocks (with signature caching) instead of stripping them." },
      { key: "claude_tool_hardening", label: "Tool hardening", type: "bool", hint: "Inject parameter signatures + strict tool-usage rules to curb Claude tool hallucination." },
      { key: "claude_prompt_auto_caching", label: "Prompt auto-caching", type: "bool", hint: "Add top-level cache_control to Claude prompts when absent." },
    ],
  },
  {
    title: "Debug",
    fields: [
      { key: "debug_gemini_payloads", label: "Debug Gemini payloads", type: "bool", hint: "Write the raw payload sent to Gemini models to a debug log file." },
    ],
  },
];

export const driver = {
  id: PROVIDER_ID,
  label: "Antigravity",
  opencodeProvider: "antigravity",
  opencodeNpm: "@ai-sdk/google",   // matches the Gemini-format transform; keeps the real "google" provider free
  models,
  fetchModels,
  sorts: ["leaderboard"],   // opt into core's built-in quality sort (manual + recommended are automatic)
  handle,
  login,
  loginFlow,
  accounts: createAntigravityAccounts(manager),
  proxies: true,
  settings: {
    groups: settingsGroups,
    get: getConfigValue,
    set: setConfigValue,
  },
};

export const AntigravityProvider = defineProvider(driver).opencode;
