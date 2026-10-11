// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { createHash } from "node:crypto";
import type { TokenUsage } from "../usage.js";

/** Recursively sorts object keys so the same logical call always
 * stringifies identically, regardless of the property insertion order
 * the AI SDK (or a provider) happened to build its params object in. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Builds the cache key for one `wrapGenerate()`/`wrapStream()` call: the
 * SHA-256 hex digest of a canonical (sorted keys, compact) JSON encoding
 * of the model's provider id, model id, and every call parameter
 * (prompt, temperature, tools, and so on). Two calls only share a key
 * when they are identical in everything that could change the answer.
 */
export function buildCacheKey(model: { provider: string; modelId: string }, params: unknown): string {
  const payload = JSON.stringify(
    sortKeysDeep({ provider: model.provider, modelId: model.modelId, params }),
  );
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** A minimal, structural shape for one `LanguageModelV#Message`: enough
 * to pull the text out of a prompt without depending on `@ai-sdk/provider`
 * types directly. */
interface TextLikePart {
  type?: unknown;
  text?: unknown;
}

interface MessageLike {
  content?: unknown;
}

/**
 * Concatenates every text part of every message in a `doGenerate()`/
 * `doStream()` prompt into one string, for embedding when semantic
 * caching is enabled. Non-text parts (files, tool calls, ...) are
 * skipped: they do not carry text a similarity search can act on.
 */
export function extractPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const raw of prompt as MessageLike[]) {
    const content = raw?.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content as TextLikePart[]) {
        if (part && part.type === "text" && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.join("\n");
}

/** True for a stream part shaped like `{ type: "error", ... }`. */
export function isErrorPart(part: unknown): boolean {
  return Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "error");
}

/** True for a stream part shaped like `{ type: "finish", usage, ... }`. */
export function isFinishPart(part: unknown): part is { type: "finish"; usage: AiSdkUsage } {
  return Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "finish");
}

/** The subset of `doGenerate()`/a `"finish"` stream part's `usage` this SDK maps to a `TokenUsage`. */
export interface AiSdkUsage {
  inputTokens: {
    noCache?: number;
    cacheRead?: number;
  };
  outputTokens: {
    total?: number;
  };
}

/**
 * `TokenUsage` for a `doGenerate()` result (or a stream's `"finish"`
 * part): `model.modelId` is always present, so this always returns a
 * value, with any token count the provider did not report left at 0
 * (never fabricated). `inputTokens.noCache` maps to `inputTokens` (HotKV's
 * `INPUT` is specifically uncached prompt tokens; `inputTokens.total`
 * would double count `cacheRead`). The AI SDK's `usage` combines cache
 * writes into one count with no 5-minute/1-hour tier (unlike LangChain's,
 * it does not even report a combined count at all), so
 * `cacheWrite5mTokens`/`cacheWrite1hTokens` are always left at their
 * `TokenUsage` default of 0 rather than guessed into the wrong tier.
 */
export function usageFromAiSdk(model: { modelId: string }, usage: AiSdkUsage): TokenUsage {
  return {
    model: model.modelId,
    inputTokens: usage.inputTokens.noCache ?? 0,
    outputTokens: usage.outputTokens.total ?? 0,
    cacheReadTokens: usage.inputTokens.cacheRead ?? 0,
  };
}
