// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// The token usage group shared by PCACHE.SET, SCACHE.SET, every keyed
// cache SET (TOOL.CACHE/NCACHE/GUARD/RERANK) and LLMBUDGET.CONSUME. Recording it with a cache entry lets a
// later hit attribute the original (uncached) call's tokens, and once the
// model is priced its exact cost, to the namespace's usage_saved_* stats.

import type { CommandArg } from "./resp/types.js";

export interface TokenUsage {
  /** Required: the model name the server prices this usage under. */
  model: string;
  /** Uncached prompt tokens. */
  inputTokens?: number;
  /** Output tokens. */
  outputTokens?: number;
  /** Provider prompt-cache hit tokens. */
  cacheReadTokens?: number;
  /** Anthropic cache-write tokens, 5-minute TTL tier. */
  cacheWrite5mTokens?: number;
  /** Anthropic cache-write tokens, 1-hour TTL tier. */
  cacheWrite1hTokens?: number;
}

/**
 * The `MODEL <model> [INPUT n] [OUTPUT n] [CACHEREAD n] [CACHEWRITE5M n]
 * [CACHEWRITE1H n]` KEY VALUE pairs a TokenUsage adds to a command's
 * trailing options. MODEL is always sent; a zero or omitted count is left
 * off the wire.
 */
export function tokenUsageArgs(usage: TokenUsage): CommandArg[] {
  const args: CommandArg[] = ["MODEL", usage.model];
  if (usage.inputTokens) args.push("INPUT", usage.inputTokens);
  if (usage.outputTokens) args.push("OUTPUT", usage.outputTokens);
  if (usage.cacheReadTokens) args.push("CACHEREAD", usage.cacheReadTokens);
  if (usage.cacheWrite5mTokens) args.push("CACHEWRITE5M", usage.cacheWrite5mTokens);
  if (usage.cacheWrite1hTokens) args.push("CACHEWRITE1H", usage.cacheWrite1hTokens);
  return args;
}
