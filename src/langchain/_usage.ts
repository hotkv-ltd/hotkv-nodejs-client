// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Best-effort TokenUsage extraction shared by HotKVCache and
// HotKVSemanticCache, so a cache entry can attribute a real model call's
// savings. Not part of the public API.

import type { Generation } from "@langchain/core/outputs";
import type { TokenUsage } from "../usage.js";

/** A `BaseMessage`-shaped value carrying LangChain.js's standard
 * `usage_metadata`/`response_metadata`, without depending on `AIMessage`
 * directly (a plain `Generation` has no `message` at all). */
interface MessageLike {
  usage_metadata?: { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number } };
  response_metadata?: { model_name?: string; model?: string; [key: string]: unknown };
}

/**
 * Best-effort `TokenUsage` from the first `ChatGeneration` in `generations`
 * whose message carries both a model name (`response_metadata.model_name`/
 * `.model`) and LangChain.js's standard `usage_metadata`. `undefined` when
 * either is missing (a plain text `Generation`, or a model integration
 * that does not populate them), so callers that get `undefined` simply
 * store without usage, exactly as before this existed.
 *
 * `usage_metadata` has no per-tier breakdown for cache-write tokens (only
 * a single combined `input_token_details.cache_creation`, without
 * Anthropic's 5-minute/1-hour split), so only `inputTokens`,
 * `outputTokens` and `input_token_details.cache_read` are mapped;
 * cache-write tokens are left at TokenUsage's default of 0 rather than
 * guessed into the wrong tier.
 */
export function extractUsage(generations: Generation[]): TokenUsage | undefined {
  for (const generation of generations) {
    const message = (generation as { message?: MessageLike }).message;
    const usage = message?.usage_metadata;
    if (!usage) continue;
    const model = message?.response_metadata?.model_name ?? message?.response_metadata?.model;
    if (!model) continue;
    return {
      model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.input_token_details?.cache_read ?? 0,
    };
  }
  return undefined;
}
