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
import { getConfigValue, setConfigValue } from "../plugin/config/index.js";

const PROVIDER_ID = "antigravity";
const MAX_ATTEMPTS = 6;   // total account/endpoint attempts before giving up

// core-auth account engine. The driver availability hook keeps antigravity's
// "skip accounts pending Google verification" behavior without leaking it into core.
const manager = new AccountManager(PROVIDER_ID, {
  selection: "hybrid",
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

// Grouped field schema for the generic settings UI core-auth renders. Every
// meaningful schema.ts option lands in exactly one group; hints are pulled from
// the schema doc comments. SKIPPED: $schema, model_ranking (array, handled
// elsewhere), quota_fallback (deprecated).
const settingsGroups = [
  {
    title: "Account rotation & scheduling",
    fields: [
      { key: "account_selection_strategy", label: "Account selection", type: "enum", options: ["sticky", "round-robin", "hybrid"], hint: "How accounts are picked for requests: sticky keeps cache, round-robin maximizes throughput, hybrid balances by health." },
      { key: "scheduling_mode", label: "Scheduling mode", type: "enum", options: ["cache_first", "balance", "performance_first"], hint: "Rate-limit behavior: cache_first waits for the same account, balance switches immediately, performance_first round-robins." },
      { key: "switch_on_first_rate_limit", label: "Switch on first rate limit", type: "bool", hint: "Switch to another account immediately on the first rate limit instead of retrying the same one." },
      { key: "max_cache_first_wait_seconds", label: "Max cache-first wait (s)", type: "number", min: 5, max: 300, hint: "Maximum seconds to wait for the same account in cache_first mode before switching." },
      { key: "pid_offset_enabled", label: "PID account offset", type: "bool", hint: "Different sessions prefer different starting accounts to distribute load across parallel agents." },
    ],
  },
  {
    title: "Model fallback",
    fields: [
      { key: "auto_mode", label: "Auto mode", type: "bool", hint: "When a request targets antigravity-auto, dynamically select the best available model." },
      { key: "auto_mode_stage", label: "Auto mode stage", type: "enum", options: ["best", "high", "balanced", "fastest"], hint: "Which quality stage Auto mode targets first." },
      { key: "fallback_enabled", label: "Fallback enabled", type: "bool", hint: "If the current model is rate-limited, fall back to the next stage instead of waiting or failing." },
      { key: "cli_first", label: "Gemini CLI first", type: "bool", hint: "Try gemini-cli routing before Antigravity for Gemini models." },
    ],
  },
  {
    title: "Rate limits & retries",
    fields: [
      { key: "max_rate_limit_wait_seconds", label: "Max rate-limit wait (s)", type: "number", min: 0, max: 3600, hint: "Maximum seconds to wait when all accounts are rate-limited (0 = wait indefinitely)." },
      { key: "default_retry_after_seconds", label: "Default retry-after (s)", type: "number", min: 1, max: 300, hint: "Retry delay when the API does not return a retry-after header." },
      { key: "max_backoff_seconds", label: "Max backoff (s)", type: "number", min: 5, max: 300, hint: "Caps how long exponential backoff can grow." },
      { key: "request_jitter_max_ms", label: "Request jitter max (ms)", type: "number", min: 0, max: 5000, hint: "Maximum random delay before each request to break predictable cadence (0 = disabled)." },
      { key: "failure_ttl_seconds", label: "Failure TTL (s)", type: "number", min: 60, max: 7200, hint: "After this period without failures, an account's consecutive-failure count resets to 0." },
      { key: "empty_response_max_attempts", label: "Empty-response max attempts", type: "number", min: 1, max: 10, hint: "Maximum retries when Antigravity returns an empty response." },
      { key: "empty_response_retry_delay_ms", label: "Empty-response retry delay (ms)", type: "number", min: 500, max: 10000, hint: "Delay between empty-response retries." },
    ],
  },
  {
    title: "Quotas",
    fields: [
      { key: "soft_quota_threshold_percent", label: "Soft quota threshold (%)", type: "number", min: 1, max: 100, hint: "Skip an account during selection once its quota usage reaches this percentage (100 = disabled)." },
      { key: "quota_refresh_interval_minutes", label: "Quota refresh interval (min)", type: "number", min: 0, max: 60, hint: "How often quota data is refreshed in the background (0 = manual only)." },
      { key: "soft_quota_cache_ttl_minutes", label: "Soft quota cache TTL", type: "string", hint: "auto or a number of minutes." },
    ],
  },
  {
    title: "Token refresh",
    fields: [
      { key: "proactive_token_refresh", label: "Proactive token refresh", type: "bool", hint: "Refresh tokens in the background before they expire so requests never block on refresh." },
      { key: "proactive_refresh_buffer_seconds", label: "Refresh buffer (s)", type: "number", min: 60, max: 7200, hint: "Seconds before token expiry to trigger a proactive refresh." },
      { key: "proactive_refresh_check_interval_seconds", label: "Refresh check interval (s)", type: "number", min: 30, max: 1800, hint: "Interval between proactive refresh checks." },
    ],
  },
  {
    title: "Session recovery",
    fields: [
      { key: "session_recovery", label: "Session recovery", type: "bool", hint: "Automatically recover from tool_result_missing errors, showing a toast when they occur." },
      { key: "auto_resume", label: "Auto resume", type: "bool", hint: "Automatically send a continue prompt after a successful recovery." },
      { key: "resume_text", label: "Resume text", type: "string", hint: "Text sent when auto-resuming after recovery." },
    ],
  },
  {
    title: "Claude handling",
    fields: [
      { key: "keep_thinking", label: "Keep thinking blocks", type: "bool", hint: "Preserve Claude thinking blocks using signature caching instead of stripping them." },
      { key: "claude_tool_hardening", label: "Tool hardening", type: "bool", hint: "Inject parameter signatures and strict tool-usage rules to prevent Claude tool hallucination." },
      { key: "claude_prompt_auto_caching", label: "Prompt auto-caching", type: "bool", hint: "Add top-level cache_control to Claude prompts when absent." },
      { key: "tool_id_recovery", label: "Tool ID recovery", type: "bool", hint: "Recover orphaned tool responses with mismatched IDs by matching on function name or placeholders." },
    ],
  },
  {
    title: "Notifications",
    fields: [
      { key: "quiet_mode", label: "Quiet mode", type: "bool", hint: "Suppress most toast notifications (recovery toasts always show)." },
      { key: "toast_scope", label: "Toast scope", type: "enum", options: ["root_only", "all"], hint: "Which sessions show toasts: root_only silences subagents, all shows everything." },
    ],
  },
  {
    title: "Debug",
    fields: [
      { key: "debug", label: "Debug logging", type: "bool", hint: "Enable debug logging to file." },
      { key: "debug_tui", label: "Debug in TUI", type: "bool", hint: "Show debug logs in the TUI log panel (independent of file logging)." },
      { key: "debug_gemini_payloads", label: "Debug Gemini payloads", type: "bool", hint: "Write the raw payload sent to Gemini models to a debug log file." },
      { key: "log_dir", label: "Log directory", type: "string", hint: "Custom directory for debug logs." },
    ],
  },
  {
    title: "Advanced — health score",
    fields: [
      { key: "health_score.initial", label: "Initial", type: "number", min: 0, max: 100, hint: "Starting health score for a new account." },
      { key: "health_score.success_reward", label: "Success reward", type: "number", min: 0, max: 10, hint: "Score added on a successful request." },
      { key: "health_score.rate_limit_penalty", label: "Rate-limit penalty", type: "number", min: -50, max: 0, hint: "Score change applied on a rate limit." },
      { key: "health_score.failure_penalty", label: "Failure penalty", type: "number", min: -100, max: 0, hint: "Score change applied on a failure." },
      { key: "health_score.recovery_rate_per_hour", label: "Recovery rate / hour", type: "number", min: 0, max: 20, hint: "Score recovered per hour of inactivity." },
      { key: "health_score.min_usable", label: "Min usable", type: "number", min: 0, max: 100, hint: "Minimum score for an account to remain selectable." },
      { key: "health_score.max_score", label: "Max score", type: "number", min: 50, max: 100, hint: "Upper bound on the health score." },
    ],
  },
  {
    title: "Advanced — token bucket",
    fields: [
      { key: "token_bucket.max_tokens", label: "Max tokens", type: "number", min: 1, max: 1000, hint: "Bucket capacity for the token-bucket rate limiter." },
      { key: "token_bucket.regeneration_rate_per_minute", label: "Regeneration / min", type: "number", min: 0.1, max: 60, hint: "Tokens regenerated per minute." },
      { key: "token_bucket.initial_tokens", label: "Initial tokens", type: "number", min: 1, max: 1000, hint: "Tokens the bucket starts with." },
    ],
  },
  {
    title: "Advanced — signature cache",
    fields: [
      { key: "signature_cache.enabled", label: "Enabled", type: "bool", hint: "Cache thinking-block signatures to disk." },
      { key: "signature_cache.memory_ttl_seconds", label: "Memory TTL (s)", type: "number", min: 60, max: 86400, hint: "In-memory signature cache TTL." },
      { key: "signature_cache.disk_ttl_seconds", label: "Disk TTL (s)", type: "number", min: 3600, max: 604800, hint: "On-disk signature cache TTL." },
      { key: "signature_cache.write_interval_seconds", label: "Write interval (s)", type: "number", min: 10, max: 600, hint: "Background interval for flushing the signature cache to disk." },
    ],
  },
  {
    title: "Plugin",
    fields: [
      { key: "auto_update", label: "Auto update", type: "bool", hint: "Enable automatic plugin updates." },
    ],
  },
];

// soft_quota_cache_ttl_minutes is a string field but stores either "auto" or a
// Number; coerce numeric text before persisting.
function setSettingValue(key: string, value: any): void {
  if (key === "soft_quota_cache_ttl_minutes" && typeof value === "string" && value !== "auto") {
    const numeric = Number(value);
    setConfigValue(key, Number.isNaN(numeric) ? value : numeric);
    return;
  }
  setConfigValue(key, value);
}

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
    set: setSettingValue,
  },
};

export const AntigravityProvider = defineProvider(driver).opencode;
