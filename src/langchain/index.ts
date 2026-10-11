// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// LangChain.js integration, published as the "@hotkv/client/langchain" entry
// point. `@langchain/core` is an optional peer dependency: a plain `@hotkv/client`
// import never pulls this in.

export { HotKVCache } from "./cache.js";
export type { HotKVCacheOptions } from "./cache.js";

export { HotKVSemanticCache } from "./semanticCache.js";
export type { EmbeddingsLike, HotKVSemanticCacheOptions } from "./semanticCache.js";
