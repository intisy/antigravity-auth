import crypto from "node:crypto";
import {
  ANTIGRAVITY_ENDPOINT,
  GEMINI_CLI_ENDPOINT,
  GEMINI_CLI_HEADERS,
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  SKIP_THOUGHT_SIGNATURE,
  getRandomizedHeaders,
  type HeaderStyle,
} from "../constants";
import { cacheSignature, getCachedSignature } from "./cache";
import { getKeepThinking } from "./config";
import {
  createStreamingTransformer,
  transformSseLine,
  transformStreamingPayload,
} from "./core/streaming";
import { defaultSignatureStore } from "./stores/signature-store";
import {
  DEBUG_MESSAGE_PREFIX,
  isDebugEnabled,
  isDebugTuiEnabled,
  logAntigravityDebugResponse,
  logCacheStats,
  type AntigravityDebugContext,
} from "./debug";
import { createLogger } from "./logger";
import {
  cleanJSONSchemaForAntigravity,
  DEFAULT_THINKING_BUDGET,
  deepFilterThinkingBlocks,
  extractThinkingConfig,
  extractVariantThinkingConfig,
  extractUsageFromSsePayload,
  extractUsageMetadata,
  fixToolResponseGrouping,
  validateAndFixClaudeToolPairing,
  applyToolPairingFixes,
  injectParameterSignatures,
  injectToolHardeningInstruction,
  isThinkingCapableModel,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  resolveThinkingConfig,
  rewriteAntigravityPreviewAccessError,
  transformThinkingParts,
  type AntigravityApiBody,
} from "./request-helpers";
import {
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  CLAUDE_DESCRIPTION_PROMPT,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
} from "../constants";
import {
  analyzeConversationState,
  closeToolLoopForThinking,
  needsThinkingRecovery,
} from "./thinking-recovery";
import { sanitizeCrossModelPayloadInPlace } from "./transform/cross-model-sanitizer";
import { isGemini3Model, isImageGenerationModel, buildImageGenerationConfig, applyGeminiTransforms, sanitizeGeminiContents, fixGeminiToolPairing } from "./transform";
import {
  resolveModelWithTier,
  resolveModelWithVariant,
  resolveModelForHeaderStyle,
  isClaudeModel,
  isClaudeThinkingModel,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
  type ThinkingTier,
} from "./transform";
import { detectErrorType } from "./recovery";
import { getSessionFingerprint, buildFingerprintHeaders, type Fingerprint } from "./fingerprint";
import type { GoogleSearchConfig } from "./transform/types";

const log = createLogger("request");

const PLUGIN_SESSION_ID = `-${crypto.randomUUID()}`;

const sessionDisplayedThinkingHashes = new Set<string>();

const MIN_SIGNATURE_LENGTH = 50;

function buildSignatureSessionKey(
  sessionId: string,
  model?: string,
  conversationKey?: string,
  projectKey?: string,
): string {
  const modelKey = typeof model === "string" && model.trim() ? model.toLowerCase() : "unknown";
  const projectPart = typeof projectKey === "string" && projectKey.trim()
    ? projectKey.trim()
    : "default";
  const conversationPart = typeof conversationKey === "string" && conversationKey.trim()
    ? conversationKey.trim()
    : "default";
  return `${sessionId}:${modelKey}:${projectPart}:${conversationPart}`;
}







function shouldCacheThinkingSignatures(model?: string): boolean {
  if (typeof model !== "string") return false;
  const lower = model.toLowerCase();

  return lower.includes("claude") || lower.includes("gemini-3");
}

function hashConversationSeed(seed: string): string {
  return crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const anyBlock = block as any;
    if (typeof anyBlock.text === "string") {
      return anyBlock.text;
    }
    if (anyBlock.text && typeof anyBlock.text === "object" && typeof anyBlock.text.text === "string") {
      return anyBlock.text.text;
    }
  }
  return "";
}

function extractConversationSeedFromMessages(messages: any[]): string {
  const system = messages.find((message) => message?.role === "system");
  const users = messages.filter((message) => message?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined;
  const systemText = system ? extractTextFromContent(system.content) : "";
  const userText = firstUser ? extractTextFromContent(firstUser.content) : "";
  const fallbackUserText = !userText && lastUser ? extractTextFromContent(lastUser.content) : "";
  return [systemText, userText || fallbackUserText].filter(Boolean).join("|");
}

function extractConversationSeedFromContents(contents: any[]): string {
  const users = contents.filter((content) => content?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined;
  const primaryUser = firstUser && Array.isArray(firstUser.parts) ? extractTextFromContent(firstUser.parts) : "";
  if (primaryUser) {
    return primaryUser;
  }
  if (lastUser && Array.isArray(lastUser.parts)) {
    return extractTextFromContent(lastUser.parts);
  }
  return "";
}

function resolveConversationKey(requestPayload: Record<string, unknown>): string | undefined {
  const anyPayload = requestPayload as any;
  const candidates = [
    anyPayload.conversationId,
    anyPayload.conversation_id,
    anyPayload.thread_id,
    anyPayload.threadId,
    anyPayload.chat_id,
    anyPayload.chatId,
    anyPayload.sessionId,
    anyPayload.session_id,
    anyPayload.metadata?.conversation_id,
    anyPayload.metadata?.conversationId,
    anyPayload.metadata?.thread_id,
    anyPayload.metadata?.threadId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const systemSeed = extractTextFromContent(
    (anyPayload.systemInstruction as any)?.parts
    ?? anyPayload.systemInstruction
    ?? anyPayload.system
    ?? anyPayload.system_instruction,
  );
  const messageSeed = Array.isArray(anyPayload.messages)
    ? extractConversationSeedFromMessages(anyPayload.messages)
    : Array.isArray(anyPayload.contents)
      ? extractConversationSeedFromContents(anyPayload.contents)
      : "";
  const seed = [systemSeed, messageSeed].filter(Boolean).join("|");
  if (!seed) {
    return undefined;
  }
  return `seed-${hashConversationSeed(seed)}`;
}

function resolveConversationKeyFromRequests(requestObjects: Array<Record<string, unknown>>): string | undefined {
  for (const req of requestObjects) {
    const key = resolveConversationKey(req);
    if (key) {
      return key;
    }
  }
  return undefined;
}

function resolveProjectKey(candidate?: unknown, fallback?: string): string | undefined {
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

function formatDebugLinesForThinking(lines: string[]): string {
  const cleaned = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-50);
  const prelude = `[ThinkingResolution] source=debug_tui lines=${cleaned.length}`;
  return `${DEBUG_MESSAGE_PREFIX}\n- ${prelude}\n${cleaned.map((line) => `- ${line}`).join("\n")}`;
}

function injectDebugThinking(response: unknown, debugText: string): unknown {
  if (!response || typeof response !== "object") {
    return response;
  }

  const resp = response as any;

  if (Array.isArray(resp.candidates) && resp.candidates.length > 0) {
    const candidates = resp.candidates.slice();
    const first = candidates[0];

    if (
      first &&
      typeof first === "object" &&
      first.content &&
      typeof first.content === "object" &&
      Array.isArray(first.content.parts)
    ) {
      const parts = [{ thought: true, text: debugText }, ...first.content.parts];
      candidates[0] = { ...first, content: { ...first.content, parts } };
      return { ...resp, candidates };
    }

    return resp;
  }

  if (Array.isArray(resp.content)) {
    const content = [{ type: "thinking", thinking: debugText }, ...resp.content];
    return { ...resp, content };
  }

  if (!resp.reasoning_content) {
    return { ...resp, reasoning_content: debugText };
  }

  return resp;
}

/**
 * Synthetic thinking placeholder text used when keep_thinking=true but debug mode is off.
 * Injected via the same path as debug text (injectDebugThinking) to ensure consistent
 * signature caching and multi-turn handling.
 */
const SYNTHETIC_THINKING_PLACEHOLDER = "[Thinking preserved]\n";

function stripInjectedDebugFromParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) {
    return parts;
  }

  return parts.filter((part) => {
    if (!part || typeof part !== "object") {
      return true;
    }

    const record = part as any;
    const text =
      typeof record.text === "string"
        ? record.text
        : typeof record.thinking === "string"
          ? record.thinking
          : undefined;


    if (text && (text.startsWith(DEBUG_MESSAGE_PREFIX) || text.startsWith(SYNTHETIC_THINKING_PLACEHOLDER.trim()))) {
      return false;
    }

    return true;
  });
}

function stripInjectedDebugFromRequestPayload(payload: Record<string, unknown>): void {
  const anyPayload = payload as any;

  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents.map((content: any) => {
      if (!content || typeof content !== "object") {
        return content;
      }

      if (Array.isArray(content.parts)) {
        return { ...content, parts: stripInjectedDebugFromParts(content.parts) };
      }

      if (Array.isArray(content.content)) {
        return { ...content, content: stripInjectedDebugFromParts(content.content) };
      }

      return content;
    });
  }

  if (Array.isArray(anyPayload.messages)) {
    anyPayload.messages = anyPayload.messages.map((message: any) => {
      if (!message || typeof message !== "object") {
        return message;
      }

      if (Array.isArray(message.content)) {
        return { ...message, content: stripInjectedDebugFromParts(message.content) };
      }

      return message;
    });
  }
}

function isValidRequestPart(part: unknown): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  const record = part as Record<string, unknown>;

  return (
    Object.prototype.hasOwnProperty.call(record, "text") ||
    Object.prototype.hasOwnProperty.call(record, "functionCall") ||
    Object.prototype.hasOwnProperty.call(record, "functionResponse") ||
    Object.prototype.hasOwnProperty.call(record, "inlineData") ||
    Object.prototype.hasOwnProperty.call(record, "fileData") ||
    Object.prototype.hasOwnProperty.call(record, "executableCode") ||
    Object.prototype.hasOwnProperty.call(record, "codeExecutionResult") ||
    Object.prototype.hasOwnProperty.call(record, "thought")
  );
}

function sanitizeRequestPayloadForAntigravity(payload: Record<string, unknown>): void {
  const anyPayload = payload as any;

  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents
      .map((content: unknown) => {
        if (!content || typeof content !== "object") {
          return null;
        }

        const contentRecord = content as Record<string, unknown>;
        const rawParts = Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
        let foundFirstFunctionCall = false;

        const sanitizedParts = rawParts.filter(isValidRequestPart).map((part: any) => {
          if (part && typeof part === "object" && part.functionCall) {
            let sig = part.thoughtSignature || part.thought_signature;


            if (!foundFirstFunctionCall) {
              foundFirstFunctionCall = true;
              if (!sig || sig.length < MIN_SIGNATURE_LENGTH) {
                sig = SKIP_THOUGHT_SIGNATURE;
              }
            } else {

              sig = undefined;
            }

            if (sig) {
              return { ...part, thought_signature: sig, thoughtSignature: sig };
            }
            

            const newPart = { ...part };
            delete newPart.thoughtSignature;
            delete newPart.thought_signature;
            return newPart;
          }
          return part;
        });

        if (sanitizedParts.length === 0) {
          return null;
        }

        return {
          ...contentRecord,
          parts: sanitizedParts,
        };
      })
      .filter((content: unknown): content is Record<string, unknown> => content !== null);
  }

  const systemInstruction = anyPayload.systemInstruction;
  if (systemInstruction && typeof systemInstruction === "object" && !Array.isArray(systemInstruction)) {
    const sys = systemInstruction as Record<string, unknown>;
    if (Array.isArray(sys.parts)) {
      const sanitizedSystemParts = sys.parts.filter(isValidRequestPart);
      if (sanitizedSystemParts.length > 0) {
        sys.parts = sanitizedSystemParts;
      } else {
        delete anyPayload.systemInstruction;
      }
    }
  }
}

function isGeminiToolUsePart(part: any): boolean {
  return !!(part && typeof part === "object" && (part.functionCall || part.tool_use || part.toolUse));
}

function isGeminiThinkingPart(part: any): boolean {
  return !!(
    part &&
    typeof part === "object" &&
    (part.thought === true || part.type === "thinking" || part.type === "reasoning")
  );
}


const SENTINEL_SIGNATURE = "skip_thought_signature_validator";

function getThinkingPartText(part: any): string {
  if (!part || typeof part !== "object") {
    return "";
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  if (typeof part.thinking === "string") {
    return part.thinking;
  }

  return "";
}

function hasCachedMatchingSignature(part: any, sessionId: string): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  const text = getThinkingPartText(part);
  if (!text) {
    return false;
  }

  const expectedSignature = getCachedSignature(sessionId, text);
  if (!expectedSignature) {
    return false;
  }

  if (part.thought === true) {
    return part.thoughtSignature === expectedSignature;
  }

  return part.signature === expectedSignature;
}

function ensureThoughtSignature(part: any, sessionId: string): any {
  if (!part || typeof part !== "object") {
    return part;
  }

  if (!sessionId) {
    return part;
  }

  const text = getThinkingPartText(part);
  if (!text) {
    return part;
  }

  if (part.thought === true) {
    return { ...part, thoughtSignature: SENTINEL_SIGNATURE };
  }

  if (part.type === "thinking" || part.type === "reasoning" || part.type === "redacted_thinking") {
    return { ...part, signature: SENTINEL_SIGNATURE };
  }

  return part;
}

function hasSignedThinkingPart(part: any, sessionId?: string): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  if (part.thought === true) {
    if (part.thoughtSignature === SENTINEL_SIGNATURE || part.thoughtSignature === SKIP_THOUGHT_SIGNATURE) {
      return true;
    }

    if (typeof part.thoughtSignature !== "string" || part.thoughtSignature.length < MIN_SIGNATURE_LENGTH) {
      return false;
    }

    if (!sessionId) {
      return true;
    }

    return hasCachedMatchingSignature(part, sessionId);
  }

  if (part.type === "thinking" || part.type === "reasoning" || part.type === "redacted_thinking") {
    if (part.signature === SENTINEL_SIGNATURE || part.signature === SKIP_THOUGHT_SIGNATURE) {
      return true;
    }

    if (typeof part.signature !== "string" || part.signature.length < MIN_SIGNATURE_LENGTH) {
      return false;
    }

    if (!sessionId) {
      return true;
    }

    return hasCachedMatchingSignature(part, sessionId);
  }

  return false;
}

function ensureThinkingBeforeToolUseInContents(contents: any[], signatureSessionKey: string): any[] {
  return contents.map((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return content;
    }

    const role = content.role;
    if (role !== "model" && role !== "assistant") {
      return content;
    }

    const parts = content.parts as any[];
    const hasToolUse = parts.some(isGeminiToolUsePart);
    if (!hasToolUse) {
      return content;
    }

    const thinkingParts = parts.filter(isGeminiThinkingPart).map((p) => ensureThoughtSignature(p, signatureSessionKey));
    const otherParts = parts.filter((p) => !isGeminiThinkingPart(p));
    const hasSignedThinking = thinkingParts.some((part) => hasSignedThinkingPart(part, signatureSessionKey));

    if (hasSignedThinking) {
      return { ...content, parts: [...thinkingParts, ...otherParts] };
    }

    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    if (!lastThinking) {

      // Return only tool_use parts without any thinking to avoid signature validation errors
      log.debug("Stripping thinking from tool_use content (no valid cached signature)", { signatureSessionKey });
      return { ...content, parts: otherParts };
    }

    const injected = {
      thought: true,
      text: lastThinking.text,
      thoughtSignature: SENTINEL_SIGNATURE,
    };

    return { ...content, parts: [injected, ...otherParts] };
  });
}

function ensureMessageThinkingSignature(block: any, sessionId: string): any {
  if (!block || typeof block !== "object") {
    return block;
  }

  if (block.type !== "thinking" && block.type !== "redacted_thinking") {
    return block;
  }

  const text = getThinkingPartText(block);
  if (!text) {
    return block;
  }

  if (!sessionId) {
    return block;
  }

  return { ...block, signature: SKIP_THOUGHT_SIGNATURE };
}

function hasToolUseInContents(contents: any[]): boolean {
  return contents.some((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return (content.parts as any[]).some(isGeminiToolUsePart);
  });
}

function hasSignedThinkingInContents(contents: any[], sessionId?: string): boolean {
  return contents.some((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return (content.parts as any[]).some((part) => hasSignedThinkingPart(part, sessionId));
  });
}

function hasToolUseInMessages(messages: any[]): boolean {
  return messages.some((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false;
    }
    return (message.content as any[]).some(
      (block) => block && typeof block === "object" && (block.type === "tool_use" || block.type === "tool_result"),
    );
  });
}

function hasSignedThinkingInMessages(messages: any[], sessionId?: string): boolean {
  return messages.some((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false;
    }
    return (message.content as any[]).some((block) => hasSignedThinkingPart(block, sessionId));
  });
}

function ensureThinkingBeforeToolUseInMessages(messages: any[], signatureSessionKey: string): any[] {
  return messages.map((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return message;
    }

    if (message.role !== "assistant") {
      return message;
    }

    const blocks = message.content as any[];
    const hasToolUse = blocks.some((b) => b && typeof b === "object" && (b.type === "tool_use" || b.type === "tool_result"));
    if (!hasToolUse) {
      return message;
    }

    const thinkingBlocks = blocks
      .filter((b) => b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking"))
      .map((b) => ensureMessageThinkingSignature(b, signatureSessionKey));

    const otherBlocks = blocks.filter((b) => !(b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking")));
    const hasSignedThinking = thinkingBlocks.some((block) => hasSignedThinkingPart(block, signatureSessionKey));

    if (hasSignedThinking) {
      return { ...message, content: [...thinkingBlocks, ...otherBlocks] };
    }

    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    if (!lastThinking) {

      const existingThinking = thinkingBlocks[0];
      const thinkingText = existingThinking?.thinking || existingThinking?.text || "";
      log.debug("Injecting sentinel signature (cache miss)", { signatureSessionKey });
      const sentinelBlock = {
        type: "thinking",
        thinking: thinkingText,
        signature: SKIP_THOUGHT_SIGNATURE,
      };
      return { ...message, content: [sentinelBlock, ...otherBlocks] };
    }

    const injected = {
      type: "thinking",
      thinking: lastThinking.text,
      signature: SKIP_THOUGHT_SIGNATURE,
    };

    return { ...message, content: [injected, ...otherBlocks] };
  });
}

/**
 * Gets the stable session ID for this plugin instance.
 */
export function getPluginSessionId(): string {
  return PLUGIN_SESSION_ID;
}

export function generateSyntheticProjectId(): string {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomPart = crypto.randomUUID().slice(0, 5).toLowerCase();
  return `${adj}-${noun}-${randomPart}`;
}

const STREAM_ACTION = "streamGenerateContent";

/**
 * Resolve a fetch() URL from RequestInfo. OpenCode / AI SDK often calls fetch(Request, init)
 * instead of fetch(string, init); we must inspect the URL the same way in both cases.
 */
export function requestInfoToUrlString(input: RequestInfo): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  if (typeof URL !== "undefined" && input instanceof URL) {
    return input.href;
  }
  return null;
}

/**
 * Detects requests headed to the Google Generative Language API (or Antigravity / Cloud Code PA)
 * so we can intercept and rewrite them.
 */
export function isGenerativeLanguageRequest(input: RequestInfo): boolean {
  const url = requestInfoToUrlString(input);
  if (!url) {
    return false;
  }
  return (
    url.includes("generativelanguage.googleapis.com") ||
    url.includes("cloudcode-pa")
  );
}

function mergeInitFromRequest(req: Request, init?: RequestInit): RequestInit {
  const next: RequestInit = { ...(init ?? {}) };
  next.method = init?.method ?? req.method;
  const headers = new Headers(req.headers);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  next.headers = headers;
  next.signal = init?.signal ?? req.signal;
  if (init?.referrer !== undefined) {
    next.referrer = init.referrer;
  }
  if (init?.referrerPolicy !== undefined) {
    next.referrerPolicy = init.referrerPolicy;
  }
  if (init?.mode !== undefined) {
    next.mode = init.mode;
  }
  if (init?.credentials !== undefined) {
    next.credentials = init.credentials;
  }
  if (init?.cache !== undefined) {
    next.cache = init.cache;
  }
  if (init?.redirect !== undefined) {
    next.redirect = init.redirect;
  }
  if (init?.integrity !== undefined) {
    next.integrity = init.integrity;
  }
  if (init?.keepalive !== undefined) {
    next.keepalive = init.keepalive;
  }
  return next;
}

/**
 * OpenCode / AI SDK often calls fetch(Request, init) with the JSON body on the Request only.
 * prepareAntigravityRequest reads init.body as a string; materialize so sanitization always runs.
 */
export async function materializeGenerativeLanguageFetchInput(
  input: RequestInfo,
  init?: RequestInit,
): Promise<{ input: RequestInfo; init?: RequestInit }> {
  if (typeof Request === "undefined" || !(input instanceof Request)) {
    return { input, init };
  }
  if (!isGenerativeLanguageRequest(input)) {
    return { input, init };
  }
  if (init !== undefined && init.body != null) {
    return { input, init };
  }
  const method = (init?.method ?? input.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { input: input.url, init: mergeInitFromRequest(input, init) };
  }
  try {
    const bodyText = await input.clone().text();
    const nextInit = mergeInitFromRequest(input, init);
    nextInit.body = bodyText;
    return { input: input.url, init: nextInit };
  } catch {
    return { input, init };
  }
}

/**
 * Options for request preparation.
 */
export interface PrepareRequestOptions {
  /** Enable Claude tool hardening (parameter signatures + system instruction). Default: true */
  claudeToolHardening?: boolean;
  /** Enable top-level Claude prompt auto-caching (`cache_control`). Default: false */
  claudePromptAutoCaching?: boolean;
  /** Google Search configuration (global default) */
  googleSearch?: GoogleSearchConfig;
  /** Per-account fingerprint for rate limit mitigation. Falls back to session fingerprint if not provided. */
  fingerprint?: Fingerprint;
  /** Write Gemini payloads to debug log. Default: false */
  debugGeminiPayloads?: boolean;
}

export function prepareAntigravityRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  endpointOverride?: string,
  headerStyle: HeaderStyle = "antigravity",
  forceThinkingRecovery = false,
  options?: PrepareRequestOptions,
): {
  request: RequestInfo;
  init: RequestInit;
  streaming: boolean;
  requestedModel?: string;
  effectiveModel?: string;
  projectId?: string;
  endpoint?: string;
  sessionId?: string;
  toolDebugMissing?: number;
  toolDebugSummary?: string;
  toolDebugPayload?: string;
  needsSignedThinkingWarmup?: boolean;
  headerStyle: HeaderStyle;
  thinkingRecoveryMessage?: string;
} {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});
  let resolvedProjectId = projectId?.trim() || "";
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];
  let toolDebugPayload: string | undefined;
  let sessionId: string | undefined;
  let needsSignedThinkingWarmup = false;
  let thinkingRecoveryMessage: string | undefined;

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");

  headers.delete("x-goog-user-project");

  const inputUrl = requestInfoToUrlString(input);
  if (!inputUrl) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    };
  }

  const match = inputUrl.match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    };
  }

  const [, rawModel = "", rawAction = ""] = match;
  const requestedModel = rawModel;

  const resolved = resolveModelForHeaderStyle(rawModel, headerStyle);
  let effectiveModel = resolved.actualModel;

  const streaming = rawAction === STREAM_ACTION;
  const defaultEndpoint = headerStyle === "gemini-cli" ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
  const baseEndpoint = endpointOverride ?? defaultEndpoint;
  const transformedUrl = `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`;

  const isClaude = isClaudeModel(resolved.actualModel);
  const isClaudeThinking = isClaudeThinkingModel(resolved.actualModel);
  const keepThinkingEnabled = getKeepThinking();
  const enableClaudePromptAutoCaching = options?.claudePromptAutoCaching ?? false;


  let tierThinkingBudget = resolved.thinkingBudget;
  let tierThinkingLevel = resolved.thinkingLevel;
  let signatureSessionKey = buildSignatureSessionKey(
    PLUGIN_SESSION_ID,
    effectiveModel,
    undefined,
    resolveProjectKey(projectId),
  );

  let body = baseInit.body;
  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body) as Record<string, unknown>;
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;

      if (isWrapped) {
        const wrappedBody = {
          ...parsedBody,
          model: effectiveModel,
        } as Record<string, unknown>;


        // We still need to sanitize Claude thinking blocks (remove cache_control)

        const requestRoot = wrappedBody.request;
        const requestObjects: Array<Record<string, unknown>> = [];

        if (requestRoot && typeof requestRoot === "object") {
          requestObjects.push(requestRoot as Record<string, unknown>);
          const nested = (requestRoot as any).request;
          if (nested && typeof nested === "object") {
            requestObjects.push(nested as Record<string, unknown>);
          }
        }

        const conversationKey = resolveConversationKeyFromRequests(requestObjects);

        const modelForCacheKey = effectiveModel.replace(/-(minimal|low|medium|high)$/i, "");
        signatureSessionKey = buildSignatureSessionKey(PLUGIN_SESSION_ID, modelForCacheKey, conversationKey, resolveProjectKey(parsedBody.project));

        if (requestObjects.length > 0) {
          sessionId = signatureSessionKey;
        }

        for (const req of requestObjects) {

          (req as any).sessionId = signatureSessionKey;
          stripInjectedDebugFromRequestPayload(req as Record<string, unknown>);

          if (isClaude) {

            sanitizeCrossModelPayloadInPlace(req, { targetModel: effectiveModel });


            deepFilterThinkingBlocks(req, signatureSessionKey, getCachedSignature, true);

            if (enableClaudePromptAutoCaching && (req as any).cache_control === undefined) {
              (req as any).cache_control = { type: "ephemeral" };
            }


            if (isClaudeThinking && keepThinkingEnabled && Array.isArray((req as any).contents)) {
              (req as any).contents = ensureThinkingBeforeToolUseInContents((req as any).contents, signatureSessionKey);
            }
            if (isClaudeThinking && keepThinkingEnabled && Array.isArray((req as any).messages)) {
              (req as any).messages = ensureThinkingBeforeToolUseInMessages((req as any).messages, signatureSessionKey);
            }


            applyToolPairingFixes(req as Record<string, unknown>, true);
          } else {
            // OpenCode often sends an already-wrapped `{ project, request }` body. That path used to

            sanitizeRequestPayloadForAntigravity(req as Record<string, unknown>);
            if (Array.isArray((req as any).contents)) {
              (req as any).contents = sanitizeGeminiContents((req as any).contents as any[]);
              (req as any).contents = fixGeminiToolPairing((req as any).contents as any[]);
              (req as any).contents = sanitizeGeminiContents((req as any).contents as any[]);
            }
          }
        }

        if (isClaudeThinking && keepThinkingEnabled && sessionId) {
          const hasToolUse = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasToolUseInContents((req as any).contents)) ||
            (Array.isArray((req as any).messages) && hasToolUseInMessages((req as any).messages)),
          );
          const hasSignedThinking = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasSignedThinkingInContents((req as any).contents, signatureSessionKey)) ||
            (Array.isArray((req as any).messages) && hasSignedThinkingInMessages((req as any).messages, signatureSessionKey)),
          );
          const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
          needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
        }

        body = JSON.stringify(wrappedBody);
      } else {
        const requestPayload: Record<string, unknown> = { ...parsedBody };

        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
        const extraBody = requestPayload.extra_body as Record<string, unknown> | undefined;

        const variantConfig = extractVariantThinkingConfig(
          requestPayload.providerOptions as Record<string, unknown> | undefined,
          rawGenerationConfig
        );
        const isGemini3 = effectiveModel.toLowerCase().includes("gemini-3");

        log.debug(`[ThinkingResolution] rawModel=${rawModel} resolvedModel=${effectiveModel} resolvedTier=${tierThinkingLevel ?? "none"} variantLevel=${variantConfig?.thinkingLevel ?? "none"} variantBudget=${variantConfig?.thinkingBudget ?? "none"} providerOptions.google=${JSON.stringify((requestPayload.providerOptions as any)?.google ?? null)} generationConfig.thinkingConfig=${JSON.stringify((rawGenerationConfig as any)?.thinkingConfig ?? null)}`);

        if (variantConfig?.thinkingLevel && isGemini3) {

          tierThinkingLevel = variantConfig.thinkingLevel;
          tierThinkingBudget = undefined;
        } else if (variantConfig?.thinkingBudget) {
          if (isGemini3) {

            log.warn("[Deprecated] Using thinkingBudget for Gemini 3 model. Use thinkingLevel instead.");
            tierThinkingLevel = variantConfig.thinkingBudget <= 8192 ? "low"
              : variantConfig.thinkingBudget <= 16384 ? "medium" : "high";
            tierThinkingBudget = undefined;
          } else {

            tierThinkingBudget = variantConfig.thinkingBudget;
            tierThinkingLevel = undefined;
          }
        }

        if (isClaude) {
          if (!requestPayload.toolConfig) {
            requestPayload.toolConfig = {};
          }
          if (typeof requestPayload.toolConfig === "object" && requestPayload.toolConfig !== null) {
            const toolConfig = requestPayload.toolConfig as Record<string, unknown>;
            if (!toolConfig.functionCallingConfig) {
              toolConfig.functionCallingConfig = {};
            }
            if (typeof toolConfig.functionCallingConfig === "object" && toolConfig.functionCallingConfig !== null) {
              (toolConfig.functionCallingConfig as Record<string, unknown>).mode = "VALIDATED";
            }
          }
        }


        const isImageModel = isImageGenerationModel(effectiveModel);
        const userThinkingConfig = isImageModel ? undefined : extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody);
        const hasAssistantHistory = Array.isArray(requestPayload.contents) &&
          requestPayload.contents.some((c: any) => c?.role === "model" || c?.role === "assistant");


        const lowerEffective = effectiveModel.toLowerCase();
        const isClaudeSonnetNonThinking = lowerEffective === "claude-sonnet-4-6";
        const effectiveUserThinkingConfig = (isClaudeSonnetNonThinking || isImageModel) ? undefined : userThinkingConfig;


        if (isImageModel) {
          const imageConfig = buildImageGenerationConfig();
          const generationConfig = (rawGenerationConfig ?? {}) as Record<string, unknown>;
          generationConfig.imageConfig = imageConfig;

          delete generationConfig.thinkingConfig;

          if (!generationConfig.candidateCount) {
            generationConfig.candidateCount = 1;
          }
          requestPayload.generationConfig = generationConfig;


          if (!requestPayload.safetySettings) {
            requestPayload.safetySettings = [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
            ];
          }


          delete requestPayload.tools;
          delete requestPayload.toolConfig;


          requestPayload.systemInstruction = {
            parts: [{ text: "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request." }]
          };
        } else {
          const finalThinkingConfig = resolveThinkingConfig(
            effectiveUserThinkingConfig,
            isClaudeSonnetNonThinking ? false : (resolved.isThinkingModel ?? isThinkingCapableModel(effectiveModel)),
            isClaude,
            hasAssistantHistory,
          );

          const normalizedThinking = normalizeThinkingConfig(finalThinkingConfig);
          if (normalizedThinking) {

            const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;


            let thinkingConfig: Record<string, unknown>;

            if (isClaudeThinking) {
              // Claude uses snake_case keys
              thinkingConfig = {
                include_thoughts: normalizedThinking.includeThoughts ?? true,
                ...(typeof thinkingBudget === "number" && thinkingBudget > 0
                  ? { thinking_budget: thinkingBudget }
                  : {}),
              };
            } else if (tierThinkingLevel) {

              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                thinkingLevel: tierThinkingLevel,
              };
            } else {

              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                ...(typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}),
              };
            }

            if (rawGenerationConfig) {
              rawGenerationConfig.thinkingConfig = thinkingConfig;

              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                const currentMax = (rawGenerationConfig.maxOutputTokens ?? rawGenerationConfig.max_output_tokens) as number | undefined;
                if (!currentMax || currentMax <= thinkingBudget) {
                  rawGenerationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
                  if (rawGenerationConfig.max_output_tokens !== undefined) {
                    delete rawGenerationConfig.max_output_tokens;
                  }
                }
              }

              requestPayload.generationConfig = rawGenerationConfig;
            } else {
              const generationConfig: Record<string, unknown> = { thinkingConfig };

              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
              }

              requestPayload.generationConfig = generationConfig;
            }
          } else if (rawGenerationConfig?.thinkingConfig) {
            delete rawGenerationConfig.thinkingConfig;
            requestPayload.generationConfig = rawGenerationConfig;
          }
        } // End of else block for non-image models

        // Clean up thinking fields from extra_body
        if (extraBody) {
          delete extraBody.thinkingConfig;
          delete extraBody.thinking;
        }
        delete requestPayload.thinkingConfig;
        delete requestPayload.thinking;

        if ("system_instruction" in requestPayload) {
          requestPayload.systemInstruction = requestPayload.system_instruction;
          delete requestPayload.system_instruction;
        }

        if (isClaudeThinking && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
          const hint = "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";
          const existing = requestPayload.systemInstruction;

          if (typeof existing === "string") {
            requestPayload.systemInstruction = existing.trim().length > 0 ? `${existing}\n\n${hint}` : hint;
          } else if (existing && typeof existing === "object") {
            const sys = existing as Record<string, unknown>;
            const partsValue = sys.parts;

            if (Array.isArray(partsValue)) {
              const parts = partsValue as unknown[];
              let appended = false;

              for (let i = parts.length - 1; i >= 0; i--) {
                const part = parts[i];
                if (part && typeof part === "object") {
                  const partRecord = part as Record<string, unknown>;
                  const text = partRecord.text;
                  if (typeof text === "string") {
                    partRecord.text = `${text}\n\n${hint}`;
                    appended = true;
                    break;
                  }
                }
              }

              if (!appended) {
                parts.push({ text: hint });
              }
            } else {
              sys.parts = [{ text: hint }];
            }

            requestPayload.systemInstruction = sys;
          } else if (Array.isArray(requestPayload.contents)) {
            requestPayload.systemInstruction = { parts: [{ text: hint }] };
          }
        }

        const cachedContentFromExtra =
          typeof requestPayload.extra_body === "object" && requestPayload.extra_body
            ? (requestPayload.extra_body as Record<string, unknown>).cached_content ??
            (requestPayload.extra_body as Record<string, unknown>).cachedContent
            : undefined;
        const cachedContent =
          (requestPayload.cached_content as string | undefined) ??
          (requestPayload.cachedContent as string | undefined) ??
          (cachedContentFromExtra as string | undefined);
        if (cachedContent) {
          requestPayload.cachedContent = cachedContent;
        }

        delete requestPayload.cached_content;
        delete requestPayload.cachedContent;
        if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
          delete (requestPayload.extra_body as Record<string, unknown>).cached_content;
          delete (requestPayload.extra_body as Record<string, unknown>).cachedContent;
          if (Object.keys(requestPayload.extra_body as Record<string, unknown>).length === 0) {
            delete requestPayload.extra_body;
          }
        }


        const hasTools = Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0;

        if (hasTools) {
          if (isClaude) {
            const functionDeclarations: any[] = [];
            const passthroughTools: any[] = [];

            const normalizeSchema = (schema: any) => {
              const createPlaceholderSchema = (base: any = {}) => ({
                ...base,
                type: "object",
                properties: {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
                  },
                },
                required: [EMPTY_SCHEMA_PLACEHOLDER_NAME],
              });

              if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }

              const cleaned = cleanJSONSchemaForAntigravity(schema);

              if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }


              const hasProperties =
                cleaned.properties &&
                typeof cleaned.properties === "object" &&
                Object.keys(cleaned.properties).length > 0;

              cleaned.type = "object";

              if (!hasProperties) {
                cleaned.properties = {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
                  },
                };
                cleaned.required = Array.isArray(cleaned.required)
                  ? Array.from(new Set([...cleaned.required, EMPTY_SCHEMA_PLACEHOLDER_NAME]))
                  : [EMPTY_SCHEMA_PLACEHOLDER_NAME];
              }

              return cleaned;
            };

            (requestPayload.tools as any[]).forEach((tool: any) => {
              const pushDeclaration = (decl: any, source: string) => {
                const schema =
                  decl?.parameters ||
                  decl?.parametersJsonSchema ||
                  decl?.input_schema ||
                  decl?.inputSchema ||
                  tool.parameters ||
                  tool.parametersJsonSchema ||
                  tool.input_schema ||
                  tool.inputSchema ||
                  tool.function?.parameters ||
                  tool.function?.parametersJsonSchema ||
                  tool.function?.input_schema ||
                  tool.function?.inputSchema ||
                  tool.custom?.parameters ||
                  tool.custom?.parametersJsonSchema ||
                  tool.custom?.input_schema;

                let name =
                  decl?.name ||
                  tool.name ||
                  tool.function?.name ||
                  tool.custom?.name ||
                  `tool-${functionDeclarations.length}`;


                name = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

                const description =
                  decl?.description ||
                  tool.description ||
                  tool.function?.description ||
                  tool.custom?.description ||
                  "";

                functionDeclarations.push({
                  name,
                  description: String(description || ""),
                  parameters: normalizeSchema(schema),
                });

                toolDebugSummaries.push(
                  `decl=${name},src=${source},hasSchema=${schema ? "y" : "n"}`,
                );
              };

              if (Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0) {
                tool.functionDeclarations.forEach((decl: any) => pushDeclaration(decl, "functionDeclarations"));
                return;
              }


              if (
                tool.function ||
                tool.custom ||
                tool.parameters ||
                tool.input_schema ||
                tool.inputSchema
              ) {
                pushDeclaration(tool.function ?? tool.custom ?? tool, "function/custom");
                return;
              }


              passthroughTools.push(tool);
            });

            const finalTools: any[] = [];
            if (functionDeclarations.length > 0) {
              finalTools.push({ functionDeclarations });
            }
            requestPayload.tools = finalTools.concat(passthroughTools);
          } else {

            const geminiResult = applyGeminiTransforms(requestPayload, {
              model: effectiveModel,
              normalizedThinking: undefined, // Thinking config already applied above (lines 816-880)
              tierThinkingBudget,
              tierThinkingLevel: tierThinkingLevel as ThinkingTier | undefined,
            });

            toolDebugMissing = geminiResult.toolDebugMissing;
            toolDebugSummaries.push(...geminiResult.toolDebugSummaries);
          }

          try {
            toolDebugPayload = JSON.stringify(requestPayload.tools);
          } catch {
            toolDebugPayload = undefined;
          }


          // Can be disabled via config.claude_tool_hardening = false to reduce context size
          const enableToolHardening = options?.claudeToolHardening ?? true;
          if (enableToolHardening && isClaude && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {

            requestPayload.tools = injectParameterSignatures(
              requestPayload.tools,
              CLAUDE_DESCRIPTION_PROMPT,
            );


            injectToolHardeningInstruction(
              requestPayload as Record<string, unknown>,
              CLAUDE_TOOL_SYSTEM_INSTRUCTION,
            );
          }
        }

        const conversationKey = resolveConversationKey(requestPayload);
        signatureSessionKey = buildSignatureSessionKey(PLUGIN_SESSION_ID, effectiveModel, conversationKey, resolveProjectKey(projectId));


        if (isClaude) {

          sanitizeCrossModelPayloadInPlace(requestPayload, { targetModel: effectiveModel });


          deepFilterThinkingBlocks(requestPayload, signatureSessionKey, getCachedSignature, true);

          if (enableClaudePromptAutoCaching && requestPayload.cache_control === undefined) {
            requestPayload.cache_control = { type: "ephemeral" };
          }


          if (isClaudeThinking && keepThinkingEnabled && Array.isArray(requestPayload.contents)) {
            requestPayload.contents = ensureThinkingBeforeToolUseInContents(requestPayload.contents, signatureSessionKey);
          }
          if (isClaudeThinking && keepThinkingEnabled && Array.isArray(requestPayload.messages)) {
            requestPayload.messages = ensureThinkingBeforeToolUseInMessages(requestPayload.messages, signatureSessionKey);
          }


          if (isClaudeThinking && keepThinkingEnabled) {
            const hasToolUse =
              (Array.isArray(requestPayload.contents) && hasToolUseInContents(requestPayload.contents)) ||
              (Array.isArray(requestPayload.messages) && hasToolUseInMessages(requestPayload.messages));
            const hasSignedThinking =
              (Array.isArray(requestPayload.contents) && hasSignedThinkingInContents(requestPayload.contents, signatureSessionKey)) ||
              (Array.isArray(requestPayload.messages) && hasSignedThinkingInMessages(requestPayload.messages, signatureSessionKey));
            const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
            needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
          }
        }


        if (isClaude && Array.isArray(requestPayload.contents)) {
          let toolCallCounter = 0;

          const pendingCallIdsByName = new Map<string, string[]>();


          requestPayload.contents = requestPayload.contents.map((content: any) => {
            if (!content || !Array.isArray(content.parts)) {
              return content;
            }

            const newParts = content.parts.map((part: any) => {
              if (part && typeof part === "object" && part.functionCall) {
                const call = { ...part.functionCall };
                if (!call.id) {
                  call.id = `tool-call-${++toolCallCounter}`;
                }
                const nameKey = typeof call.name === "string" ? call.name : `tool-${toolCallCounter}`;

                const queue = pendingCallIdsByName.get(nameKey) || [];
                queue.push(call.id);
                pendingCallIdsByName.set(nameKey, queue);
                return { ...part, functionCall: call };
              }
              return part;
            });

            return { ...content, parts: newParts };
          });


          requestPayload.contents = (requestPayload.contents as any[]).map((content: any) => {
            if (!content || !Array.isArray(content.parts)) {
              return content;
            }

            const newParts = content.parts.map((part: any) => {
              if (part && typeof part === "object" && part.functionResponse) {
                const resp = { ...part.functionResponse };
                if (!resp.id && typeof resp.name === "string") {
                  const queue = pendingCallIdsByName.get(resp.name);
                  if (queue && queue.length > 0) {

                    resp.id = queue.shift();
                    pendingCallIdsByName.set(resp.name, queue);
                  }
                }
                return { ...part, functionResponse: resp };
              }
              return part;
            });

            return { ...content, parts: newParts };
          });


          // Ported from LLM-API-Key-Proxy's _fix_tool_response_grouping()
          requestPayload.contents = fixToolResponseGrouping(requestPayload.contents as any[]);
        }


        // Handles orphaned tool_use blocks in Claude's messages[] format
        if (Array.isArray(requestPayload.messages)) {
          requestPayload.messages = validateAndFixClaudeToolPairing(requestPayload.messages);
        }

        // =====================================================================

        // =====================================================================

        //

        // - Context compaction stripped thinking blocks
        // - Signature cache miss
        // - Any other corruption we couldn't repair
        // - API error indicated thinking_block_order issue (forceThinkingRecovery=true)
        //

        if (isClaudeThinking && Array.isArray(requestPayload.contents)) {
          const conversationState = analyzeConversationState(requestPayload.contents);

          // Force recovery if API returned thinking_block_order error (retry case)

          if (forceThinkingRecovery || needsThinkingRecovery(conversationState)) {

            thinkingRecoveryMessage = forceThinkingRecovery
              ? "Thinking recovery: retrying with fresh turn (API error)"
              : "Thinking recovery: restarting turn (corrupted context)";

            requestPayload.contents = closeToolLoopForThinking(requestPayload.contents);

            defaultSignatureStore.delete(signatureSessionKey);
          }
        }

        if ("model" in requestPayload) {
          delete requestPayload.model;
        }

        stripInjectedDebugFromRequestPayload(requestPayload);
        sanitizeRequestPayloadForAntigravity(requestPayload);


        try {
          if (!isClaude && Array.isArray(requestPayload.contents) && options?.debugGeminiPayloads) {
            const fs = require('fs');
            fs.appendFileSync(
              require('path').join(require('os').homedir(), '.config', 'opencode', 'gemini-payload-debug.log'),
              "\n\n=== PAYLOAD BEFORE ===\n" + JSON.stringify(requestPayload.contents, null, 2)
            );
          }
        } catch (e) {}


        if (!isClaude && Array.isArray(requestPayload.contents)) {
          requestPayload.contents = sanitizeGeminiContents(requestPayload.contents as any[]);
          requestPayload.contents = fixGeminiToolPairing(requestPayload.contents as any[]);

          requestPayload.contents = sanitizeGeminiContents(requestPayload.contents as any[]);
        }

        const effectiveProjectId = projectId?.trim() || (headerStyle === "antigravity" ? generateSyntheticProjectId() : "");
        resolvedProjectId = effectiveProjectId;


        try {
          if (!isClaude && Array.isArray(requestPayload.contents) && options?.debugGeminiPayloads) {
            const fs = require('fs');
            fs.appendFileSync(
              require('path').join(require('os').homedir(), '.config', 'opencode', 'gemini-payload-debug.log'),
              "\n\n=== PAYLOAD AFTER ===\n" + JSON.stringify(requestPayload.contents, null, 2)
            );
          }
        } catch (e) {}
        
        if (headerStyle === "antigravity") {
          const existingSystemInstruction = requestPayload.systemInstruction;
          if (existingSystemInstruction && typeof existingSystemInstruction === "object") {
            const sys = existingSystemInstruction as Record<string, unknown>;
            sys.role = "user";
            if (Array.isArray(sys.parts) && sys.parts.length > 0) {
              const firstPart = sys.parts[0] as Record<string, unknown>;
              if (firstPart && typeof firstPart.text === "string") {
                firstPart.text = ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + firstPart.text;
              } else {
                sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...sys.parts];
              }
            } else {
              sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }];
            }
          } else if (typeof existingSystemInstruction === "string") {
            requestPayload.systemInstruction = {
              role: "user",
              parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + existingSystemInstruction }],
            };
          } else {
            requestPayload.systemInstruction = {
              role: "user",
              parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }],
            };
          }
        }

        const wrappedBody: Record<string, unknown> = {
          project: effectiveProjectId,
          model: effectiveModel,
          request: requestPayload,
        };

        if (headerStyle === "antigravity") {
          wrappedBody.requestType = "agent";
          wrappedBody.userAgent = "antigravity";
          wrappedBody.requestId = "agent-" + crypto.randomUUID();
        }
        if (wrappedBody.request && typeof wrappedBody.request === 'object') {

          sessionId = signatureSessionKey;
          (wrappedBody.request as any).sessionId = signatureSessionKey;
        }

        body = JSON.stringify(wrappedBody);
      }
    } catch (error) {
      throw error;
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }


  if (isClaudeThinking) {
    const existing = headers.get("anthropic-beta");
    const interleavedHeader = "interleaved-thinking-2025-05-14";

    if (existing) {
      if (!existing.includes(interleavedHeader)) {
        headers.set("anthropic-beta", `${existing},${interleavedHeader}`);
      }
    } else {
      headers.set("anthropic-beta", interleavedHeader);
    }
  }

  if (headerStyle === "antigravity") {

    const selectedHeaders = getRandomizedHeaders("antigravity", requestedModel);


    // (ideType=ANTIGRAVITY goes in request body metadata via project.ts, not as a header)
    const fingerprint = options?.fingerprint ?? getSessionFingerprint();
    const fingerprintHeaders = buildFingerprintHeaders(fingerprint);

    headers.set("User-Agent", fingerprintHeaders["User-Agent"] || selectedHeaders["User-Agent"]);
  } else {

    headers.set("User-Agent", GEMINI_CLI_HEADERS["User-Agent"]);
    headers.set("X-Goog-Api-Client", GEMINI_CLI_HEADERS["X-Goog-Api-Client"]);
    headers.set("Client-Metadata", GEMINI_CLI_HEADERS["Client-Metadata"]);
  }
  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel,
    effectiveModel: effectiveModel,
    projectId: resolvedProjectId,
    endpoint: transformedUrl,
    sessionId,
    toolDebugMissing,
    toolDebugSummary: toolDebugSummaries.slice(0, 20).join(" | "),
    toolDebugPayload,
    needsSignedThinkingWarmup,
    headerStyle,
    thinkingRecoveryMessage,
  };
}

export function buildThinkingWarmupBody(
  bodyText: string | undefined,
  isClaudeThinking: boolean,
): string | null {
  if (!bodyText || !isClaudeThinking) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }

  const warmupPrompt = "Warmup request for thinking signature.";

  const updateRequest = (req: Record<string, unknown>) => {
    req.contents = [{ role: "user", parts: [{ text: warmupPrompt }] }];
    delete req.tools;
    delete (req as any).toolConfig;

    const generationConfig = (req.generationConfig ?? {}) as Record<string, unknown>;
    generationConfig.thinkingConfig = {
      include_thoughts: true,
      thinking_budget: DEFAULT_THINKING_BUDGET,
    };
    generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
    req.generationConfig = generationConfig;
  };

  if (parsed.request && typeof parsed.request === "object") {
    updateRequest(parsed.request as Record<string, unknown>);
    const nested = (parsed.request as any).request;
    if (nested && typeof nested === "object") {
      updateRequest(nested as Record<string, unknown>);
    }
  } else {
    updateRequest(parsed);
  }

  return JSON.stringify(parsed);
}

/**
 * Normalizes Antigravity responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 *
 * For streaming SSE responses, uses TransformStream for true real-time incremental streaming.
 * Thinking/reasoning tokens are transformed and forwarded immediately as they arrive.
 */
export async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  debugContext?: AntigravityDebugContext | null,
  requestedModel?: string,
  projectId?: string,
  endpoint?: string,
  effectiveModel?: string,
  sessionId?: string,
  toolDebugMissing?: number,
  toolDebugSummary?: string,
  toolDebugPayload?: string,
  debugLines?: string[],
  onComplete?: () => void,
  onWatchdogTimeout?: () => Promise<void> | void,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");


  // - If debug=true: inject full debug logs
  // - If keep_thinking=true (but no debug): inject placeholder to trigger signature caching

  const debugText =
    isDebugTuiEnabled() && Array.isArray(debugLines) && debugLines.length > 0
      ? formatDebugLinesForThinking(debugLines)
      : getKeepThinking()
        ? SYNTHETIC_THINKING_PLACEHOLDER
        : undefined;
  const cacheSignatures = shouldCacheThinkingSignatures(effectiveModel);

  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }


  if (streaming && response.ok && isEventStreamResponse && response.body) {
    const headers = new Headers(response.headers);

    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE response (real-time transform)",
    });

    const streamingTransformer = createStreamingTransformer(
      defaultSignatureStore,
      {
        onCacheSignature: cacheSignature,
        onInjectDebug: injectDebugThinking,
        // onInjectSyntheticThinking removed - keep_thinking now uses debugText path
        transformThinkingParts,
      },
      {
        signatureSessionKey: sessionId,
        debugText,
        cacheSignatures,
        displayedThinkingHashes: effectiveModel && isGemini3Model(effectiveModel) ? sessionDisplayedThinkingHashes : undefined,
        onComplete,
        onWatchdogTimeout,
      },
    );
    return new Response(response.body.pipeThrough(streamingTransformer), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const responseFallback = response.clone();

  try {
    const headers = new Headers(response.headers);
    const text = await response.text();

    if (!response.ok) {
      let errorBody;
      try {
        errorBody = JSON.parse(text);
      } catch {
        errorBody = { error: { message: text } };
      }


      if (errorBody?.error) {
        const rawErrorMessage =
          typeof errorBody.error.message === "string" && errorBody.error.message.length > 0
            ? errorBody.error.message
            : "Unknown error";
        const errorType = detectErrorType(rawErrorMessage);
        const debugInfo = `\n\n[Debug Info]\nRequested Model: ${requestedModel || "Unknown"}\nEffective Model: ${effectiveModel || "Unknown"}\nProject: ${projectId || "Unknown"}\nEndpoint: ${endpoint || "Unknown"}\nStatus: ${response.status}\nRequest ID: ${headers.get("x-request-id") || "N/A"}${toolDebugMissing !== undefined ? `\nTool Debug Missing: ${toolDebugMissing}` : ""}${toolDebugSummary ? `\nTool Debug Summary: ${toolDebugSummary}` : ""}${toolDebugPayload ? `\nTool Debug Payload: ${toolDebugPayload}` : ""}`;
        const injectedDebug = debugText ? `\n\n${debugText}` : "";
        errorBody.error.message = rawErrorMessage + debugInfo + injectedDebug;


        if (errorType === "thinking_block_order") {
          const recoveryError = new Error("THINKING_RECOVERY_NEEDED");
          (recoveryError as any).recoveryType = errorType;
          (recoveryError as any).originalError = errorBody;
          (recoveryError as any).debugInfo = debugInfo;
          throw recoveryError;
        }


        const errorMessage = errorBody.error.message?.toLowerCase() || "";
        if (
          errorMessage.includes("prompt is too long") ||
          errorMessage.includes("context length exceeded") ||
          errorMessage.includes("context_length_exceeded") ||
          errorMessage.includes("maximum context length")
        ) {
          headers.set("x-antigravity-context-error", "prompt_too_long");
        }


        if (
          errorMessage.includes("tool_use") &&
          errorMessage.includes("tool_result") &&
          (errorMessage.includes("without") || errorMessage.includes("immediately after"))
        ) {
          headers.set("x-antigravity-context-error", "tool_pairing");
        }

        return new Response(JSON.stringify(errorBody), {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }

      if (errorBody?.error?.details && Array.isArray(errorBody.error.details)) {
        const retryInfo = errorBody.error.details.find(
          (detail: any) => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
        );

        if (retryInfo?.retryDelay) {
          const match = retryInfo.retryDelay.match(/^([\d.]+)s$/);
          if (match && match[1]) {
            const retrySeconds = parseFloat(match[1]);
            if (!isNaN(retrySeconds) && retrySeconds > 0) {
              const retryAfterSec = Math.ceil(retrySeconds).toString();
              const retryAfterMs = Math.ceil(retrySeconds * 1000).toString();
              headers.set('Retry-After', retryAfterSec);
              headers.set('retry-after-ms', retryAfterMs);
            }
          }
        }
      }
    }

    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null;
    const parsed: AntigravityApiBody | null = !streaming || !isEventStreamResponse ? parseAntigravityApiBody(text) : null;
    const patched = parsed ? rewriteAntigravityPreviewAccessError(parsed, response.status, requestedModel) : null;
    const effectiveBody = patched ?? parsed ?? undefined;

    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null);
    

    if (usage && effectiveModel) {
      logCacheStats(
        effectiveModel,
        usage.cachedContentTokenCount ?? 0,
        0, // API doesn't provide cache write tokens separately
        usage.promptTokenCount ?? usage.totalTokenCount ?? 0,
      );
    }
    
    if (usage?.cachedContentTokenCount !== undefined) {
      headers.set("x-antigravity-cached-content-token-count", String(usage.cachedContentTokenCount));
      if (usage.totalTokenCount !== undefined) {
        headers.set("x-antigravity-total-token-count", String(usage.totalTokenCount));
      }
      if (usage.promptTokenCount !== undefined) {
        headers.set("x-antigravity-prompt-token-count", String(usage.promptTokenCount));
      }
      if (usage.candidatesTokenCount !== undefined) {
        headers.set("x-antigravity-candidates-token-count", String(usage.candidatesTokenCount));
      }
    }

    logAntigravityDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered fallback)" : undefined,
      headersOverride: headers,
    });



    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody?.response !== undefined) {
      let responseBody: unknown = effectiveBody.response;

      // Both debug=true and keep_thinking=true use the same path now
      if (debugText) {
        responseBody = injectDebugThinking(responseBody, debugText);
      }
      const transformed = transformThinkingParts(responseBody);
      return new Response(JSON.stringify(transformed), init);
    }

    if (patched) {
      return new Response(JSON.stringify(patched), init);
    }

    return new Response(text, init);
  } catch (error) {
    if (error instanceof Error && error.message === "THINKING_RECOVERY_NEEDED") {
      throw error;
    }

    logAntigravityDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Antigravity response",
    });
    return responseFallback;
  }
}

export const __testExports = {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveConversationKey,
  resolveProjectKey,
  isGeminiToolUsePart,
  isGeminiThinkingPart,
  ensureThoughtSignature,
  hasSignedThinkingPart,
  hasSignedThinkingInContents,
  hasSignedThinkingInMessages,
  hasToolUseInContents,
  hasToolUseInMessages,
  ensureThinkingBeforeToolUseInContents,
  ensureThinkingBeforeToolUseInMessages,
  generateSyntheticProjectId,
  MIN_SIGNATURE_LENGTH,
  transformSseLine,
  transformStreamingPayload,
  createStreamingTransformer,
};
