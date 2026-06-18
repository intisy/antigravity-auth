import type { ProviderModel } from "../types";

export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface ModelThinkingConfig {
  thinkingBudget: number;
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel;
  thinkingConfig?: ModelThinkingConfig;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export type ModelModality = "text" | "image" | "pdf";

export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}

export interface OpencodeModelDefinition extends ProviderModel {
  name: string;
  limit: ModelLimit;
  modalities: ModelModalities;
  variants?: Record<string, ModelVariant>;
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;

export const DEFAULT_MODALITIES: ModelModalities = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

// The catalog is now fetched live per account (plugin/models-fetch.ts) and cached
// by core-auth. OpenCode/Claude show no antigravity models until the first
// `oc auth login`; this empty default is the pre-login / fetch-failure fallback.
export const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions = {};
