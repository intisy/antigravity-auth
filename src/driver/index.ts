// @ts-nocheck
// The antigravity driver: a thin object on top of core-auth. core-auth owns
// account storage, selection, token refresh, and rate-limit/cooldown state; this
// driver owns only the antigravity-specific request transform + endpoint dispatch,
// reusing the existing plugin/request + plugin/project + plugin/transform code.

import { defineProvider, AccountManager } from "../../core-auth/dist/index.js";
import { prepareAntigravityRequest, transformAntigravityResponse } from "../plugin/request.js";
import { ensureProjectContext } from "../plugin/project.js";
import { formatRefreshParts, parseRefreshParts } from "../plugin/auth.js";
import { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_ENDPOINT_PROD } from "../constants.js";
import { models } from "./models.js";
import { oauthConfig } from "./config.js";
import { laneFor, headerStyleFor, parseRateLimitReason, resetTimeFor } from "./lanes.js";
import { runMigration } from "./migrate.js";
import { login, loginFlow } from "./login.js";

const PROVIDER_ID = "antigravity";
const MAX_ATTEMPTS = 6;   // total account/endpoint attempts before giving up

// core-auth account engine. The driver availability hook keeps antigravity's
// "skip accounts pending Google verification" behavior without leaking it into core.
const manager = new AccountManager(PROVIDER_ID, {
  selection: "hybrid",
  oauth: oauthConfig(),
  isAvailable: (account) => !(account.meta && account.meta.verificationRequired),
});

let migrationDone = false;
function ensureMigrated(configDir) {
  if (migrationDone || !configDir) return;
  migrationDone = true;
  try { runMigration(PROVIDER_ID, configDir); } catch {}
}

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

async function resolveProjectId(account, access, log) {
  const meta = account.meta || {};
  let projectId = meta.managedProjectId || meta.projectId || "";
  try {
    const result = await ensureProjectContext(buildAuth(account, access));
    if (result && result.effectiveProjectId) projectId = result.effectiveProjectId;
    const discovered = parseRefreshParts(result.auth.refresh).managedProjectId;
    if (discovered && discovered !== meta.managedProjectId) {
      manager.mutate(account.id, (a) => { a.meta = a.meta || {}; a.meta.managedProjectId = discovered; });
    }
  } catch (error) { log("ensureProjectContext failed: " + error); }
  return projectId;
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
}

async function handle(request, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  ensureMigrated(ctx && ctx.configDir);

  const url = request.url;
  let bodyText;
  try { bodyText = await request.clone().text(); } catch { bodyText = undefined; }
  const model = modelFromRequest(url, bodyText, ctx && ctx.model);
  const lane = laneFor(model);
  const headerStyle = headerStyleFor(model);
  const init = { method: request.method, headers: Object.fromEntries(request.headers), body: bodyText };

  let lastResponse = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const acquired = await manager.acquire(lane);
    if (!acquired || !acquired.account) return errorResponse(503, "No available antigravity account for lane " + lane);
    const account = acquired.account;
    const access = acquired.access;
    if (!access) { manager.reportError(account.id, attempt, "missing access token"); continue; }

    const projectId = await resolveProjectId(account, access, log);

    let rateLimited = false;
    for (const endpoint of endpointsFor(headerStyle)) {
      let prepared;
      try {
        prepared = prepareAntigravityRequest(url, init, access, projectId, endpoint, headerStyle, false, {
          fingerprint: account.meta && account.meta.fingerprint,
        });
      } catch (error) { log("prepare failed: " + error); continue; }

      let response;
      try { response = await fetch(prepared.request, prepared.init); }
      catch (error) { log("fetch failed: " + error); continue; }

      if (isRateLimitStatus(response.status)) {
        rateLimited = true;
        lastResponse = response;
        let reason, message;
        try { const j = await response.clone().json(); message = j && j.error && j.error.message; reason = j && j.error && (j.error.status || j.error.reason); } catch {}
        const parsed = parseRateLimitReason(reason, message, response.status);
        manager.reportRateLimit(account.id, lane, resetTimeFor(parsed, attempt));
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

      return response;   // non-retryable upstream error -> surface as-is
    }

    if (!rateLimited) break;
  }
  return lastResponse || errorResponse(502, "antigravity request failed after " + MAX_ATTEMPTS + " attempts");
}

export const driver = {
  id: PROVIDER_ID,
  label: "Antigravity",
  opencodeProvider: PROVIDER_ID,
  opencodeNpm: "@ai-sdk/anthropic",
  models,
  handle,
  login,
  loginFlow,
};

export const AntigravityProvider = defineProvider(driver).opencode;
