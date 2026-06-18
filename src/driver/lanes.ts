// @ts-nocheck
// Lane derivation + rate-limit-reason parsing for antigravity; lanes partition rate-limit state per quota family: claude | gemini-antigravity | gemini-cli.

import { getModelFamily } from "../plugin/transform/model-resolver.js";

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000];
const MODEL_CAPACITY_BASE = 45_000;
const MODEL_CAPACITY_JITTER_MAX = 30_000;   // ±15s
const MIN_BACKOFF_MS = 2_000;
const MAX_EXPONENTIAL_BACKOFF = 60 * 60 * 1000;

function jitter(maxMs) { return Math.random() * maxMs - maxMs / 2; }

// antigravity-* models use the antigravity header style; bare gemini-* use gemini-cli
function isGeminiCliModel(model) {
  return typeof model === "string" && model.startsWith("gemini-");
}

// Partition rate-limit state by REAL quota pool so exhausting one family never
// blocks another: claude | gemini-pro | gemini-flash | gpt-oss | gemini-cli.
// Bare gemini-* ids are the separate (Gemini CLI) free pool; antigravity-*
// (and everything else) split by family.
export function laneFor(model) {
  const raw = String(model || "");
  if (isGeminiCliModel(raw)) return "gemini-cli";
  const lower = raw.replace(/^antigravity-/i, "").toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gpt")) return "gpt-oss";
  if (lower.includes("flash")) return "gemini-flash";
  return "gemini-pro";
}

export function headerStyleFor(model) {
  return isGeminiCliModel(model) ? "gemini-cli" : "antigravity";
}

export function parseRateLimitReason(reason, message, status) {
  if (status === 529 || status === 503) return "MODEL_CAPACITY_EXHAUSTED";
  if (status === 500) return "SERVER_ERROR";
  if (reason) {
    switch (reason.toUpperCase()) {
      case "QUOTA_EXHAUSTED": return "QUOTA_EXHAUSTED";
      case "RATE_LIMIT_EXCEEDED": return "RATE_LIMIT_EXCEEDED";
      case "MODEL_CAPACITY_EXHAUSTED": return "MODEL_CAPACITY_EXHAUSTED";
    }
  }
  if (message) {
    const lower = message.toLowerCase();
    if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("resource exhausted")) return "MODEL_CAPACITY_EXHAUSTED";
    if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("presque")) return "RATE_LIMIT_EXCEEDED";
    if (lower.includes("exhausted") || lower.includes("quota")) return "QUOTA_EXHAUSTED";
  }
  return "UNKNOWN";
}

export function calculateBackoffMs(reason, consecutiveFailures, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) return Math.max(retryAfterMs, MIN_BACKOFF_MS);
  let base;
  switch (reason) {
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(consecutiveFailures || 0, QUOTA_EXHAUSTED_BACKOFFS.length - 1);
      return QUOTA_EXHAUSTED_BACKOFFS[index];
    }
    case "RATE_LIMIT_EXCEEDED": base = 45_000; break;
    case "MODEL_CAPACITY_EXHAUSTED": base = MODEL_CAPACITY_BASE + jitter(MODEL_CAPACITY_JITTER_MAX); break;
    case "SERVER_ERROR": base = 30_000; break;
    default: base = 90_000; break;
  }
  const multiplier = Math.pow(1.5, consecutiveFailures || 0);
  return Math.min(Math.round(base * multiplier), MAX_EXPONENTIAL_BACKOFF);
}

export function resetTimeFor(reason, consecutiveFailures, retryAfterMs) {
  return Date.now() + calculateBackoffMs(reason, consecutiveFailures, retryAfterMs);
}
