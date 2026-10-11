// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Provider neutral AI caching helpers, published as the "@hotkv/client/ai" entry
// point. Nothing here depends on any specific LLM or embedding provider's
// SDK: callers supply prompts/messages and (for SemanticCache) vectors,
// and these helpers handle the HotKV side.

export { buildPromptCacheKey, canonicalPromptCacheJSON } from "./cacheKey.js";
export type { PromptCacheKeyInput, PromptMessage } from "./cacheKey.js";

export { PromptCache } from "./promptCache.js";
export type { GetOrCallResult, LLMCallResult, LLMUsage, PromptCacheClient, PromptCacheOptions } from "./promptCache.js";

export { SemanticCache } from "./semanticCache.js";
export type { SemanticCacheClient, SemanticCacheMetric, SemanticCacheOptions, SemanticCallResult } from "./semanticCache.js";
