// Live model discovery: ask cloudcode-pa which models the account can actually
// use (v1internal:fetchAvailableModels) and build the OpenCode/Claude catalog
// from the response instead of a hardcoded list. The agent-model set + ranking
// + default all come straight from the API.

import { ANTIGRAVITY_ENDPOINT_FALLBACKS, getAntigravityHeaders } from "../constants";
import type { OpencodeModelDefinition, OpencodeModelDefinitions } from "./config/models";

const MODEL_ID_PREFIX = "antigravity-";

interface FetchedModelInfo {
  displayName?: string;
  maxTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsThinking?: boolean;
}

interface FetchAvailableModelsPayload {
  models?: Record<string, FetchedModelInfo>;
  defaultAgentModelId?: string;
  agentModelSorts?: Array<{ groups?: Array<{ modelIds?: string[] }> }>;
  deprecatedModelIds?: Record<string, unknown>;
  imageGenerationModelIds?: string[];
}

export interface AntigravityCatalog {
  models: OpencodeModelDefinitions;
  /** Agent models in the API's recommended order (raw ids, no prefix) — Auto ranking source. */
  ranking: string[];
  /** The API's default agent model id (raw, no prefix). */
  defaultModelId?: string;
}

/**
 * Calls v1internal:fetchAvailableModels for the account's project. Retries
 * directly if the (per-account) proxy is unreachable, mirroring the request
 * handle, so a dead proxy never silently empties the catalog.
 */
export async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
  proxy: string | undefined,
  log: (message: string) => void,
): Promise<FetchAvailableModelsPayload | null> {
  const baseInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...getAntigravityHeaders() },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
  };

  for (const baseEndpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
    const url = `${baseEndpoint}/v1internal:fetchAvailableModels`;
    try {
      let response: Response;
      try {
        response = await fetch(url, { ...baseInit, proxy } as RequestInit & { proxy?: string });
      } catch (proxyError) {
        if (!proxy) throw proxyError;
        log("fetchAvailableModels via proxy failed, retrying directly: " + String(proxyError));
        response = await fetch(url, baseInit as RequestInit);
      }
      if (!response.ok) continue;
      return (await response.json()) as FetchAvailableModelsPayload;
    } catch (error) {
      log("fetchAvailableModels failed at " + baseEndpoint + ": " + String(error));
      continue;
    }
  }
  return null;
}

/** Flattens agentModelSorts into a single ranked id list (the API's recommended order). */
function rankedAgentModelIds(payload: FetchAvailableModelsPayload): string[] {
  const ids: string[] = [];
  for (const sort of payload.agentModelSorts || []) {
    for (const group of sort.groups || []) {
      for (const id of group.modelIds || []) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

// The separate Gemini CLI free quota pool (bare ids -> gemini-cli lane/headers).
// These are stable public Gemini models and aren't in the antigravity agent
// ranking, so they're listed as their own labeled group.
const GEMINI_CLI_MODELS: Array<{ id: string; name: string; context: number; output: number }> = [
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (Gemini CLI)", context: 1048576, output: 65536 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Gemini CLI)", context: 1048576, output: 65536 },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview (Gemini CLI)", context: 1048576, output: 65536 },
  { id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview (Gemini CLI)", context: 1048576, output: 65535 },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview (Gemini CLI)", context: 1048576, output: 65535 },
];

function buildModelEntry(rawId: string, info: FetchedModelInfo): OpencodeModelDefinition {
  return {
    name: (info.displayName || rawId) + " (Antigravity)",
    limit: { context: info.maxTokens || 200000, output: info.maxOutputTokens || 65535 },
    modalities: {
      input: info.supportsImages ? ["text", "image", "pdf"] : ["text", "pdf"],
      output: ["text"],
    },
  };
}

/**
 * Builds the catalog from a fetchAvailableModels payload: the recommended agent
 * models (in order), minus deprecated/image-generation ids. Returns the prefixed
 * OpenCode catalog plus the raw ranking + default for Auto.
 */
export function buildAntigravityCatalog(payload: FetchAvailableModelsPayload): AntigravityCatalog {
  const models = payload.models || {};
  const deprecated = new Set(Object.keys(payload.deprecatedModelIds || {}));
  const imageOnly = new Set(payload.imageGenerationModelIds || []);

  const ranked = rankedAgentModelIds(payload).filter(
    (id) => models[id] && !deprecated.has(id) && !imageOnly.has(id),
  );

  const catalog: OpencodeModelDefinitions = {};
  // "Auto" first (routes to the flagship via the resolver alias; becomes a
  // configurable core feature in a later phase). Kept so it never regresses.
  catalog[MODEL_ID_PREFIX + "auto"] = {
    name: "Auto",
    limit: { context: 1048576, output: 65535 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    variants: {
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  };
  for (const rawId of ranked) {
    catalog[MODEL_ID_PREFIX + rawId] = buildModelEntry(rawId, models[rawId]!);
  }
  // Gemini CLI quota pool (bare ids, distinct lane) — a second free pool.
  for (const cli of GEMINI_CLI_MODELS) {
    catalog[cli.id] = {
      name: cli.name,
      limit: { context: cli.context, output: cli.output },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    };
  }

  const defaultModelId =
    payload.defaultAgentModelId && ranked.includes(payload.defaultAgentModelId)
      ? payload.defaultAgentModelId
      : ranked[0];

  return { models: catalog, ranking: ranked, defaultModelId };
}
