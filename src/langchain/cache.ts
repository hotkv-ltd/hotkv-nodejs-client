// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { BaseCache, deserializeStoredGeneration, serializeGeneration } from "@langchain/core/caches";
import type { Generation } from "@langchain/core/outputs";
import { ExactCacheBackend, type ExactCacheClient } from "../internal/exactCache.js";
import { extractUsage } from "./_usage.js";

export interface HotKVCacheOptions {
  /** PCACHE.* namespace (or core key prefix, unlicensed). Default "langchain-cache". */
  namespace?: string;
  /** TTL applied to stored entries, in seconds. Omit for no expiry. */
  ttlSeconds?: number;
}

/**
 * Exact-match LLM response cache for LangChain.js, on top of `PCACHE.*`.
 *
 * ```ts
 * import { HotKV } from "@hotkv/client";
 * import { HotKVCache } from "@hotkv/client/langchain";
 * import { ChatOpenAI } from "@langchain/openai";
 *
 * const client = new HotKV({ url: process.env.HOTKV_URL });
 * const model = new ChatOpenAI({ cache: new HotKVCache(client, { namespace: "chat-responses", ttlSeconds: 3600 }) });
 * ```
 *
 * Once installed, an identical `(prompt, llmKey)` pair (the same model,
 * the same generation parameters, the same rendered prompt) is served
 * from HotKV instead of calling the model again; `llmKey` already comes
 * from LangChain.js itself, encoding the model class and every
 * invocation parameter, so two different models (or the same model with
 * different parameters) never share an entry. Falls back to core
 * `GET`/`SET` (a SHA-256 key, honoring `ttlSeconds`) the first time the
 * server answers `PCACHE.*` with `NOLICENSE`, so this works unlicensed
 * (Starter plan) too, just without `PCACHE.STATS`/eviction accounting.
 *
 * When the cached `AIMessage` carries a model name and LangChain.js's
 * standard `usage_metadata`, `update()` stores it with the entry (a
 * `TokenUsage`) so a later hit attributes its tokens and cost to
 * `PCACHE.STATS`'s `usageSaved*` fields; when it does not (a plain text
 * `Generation`, or a model integration that leaves them unset), entries
 * are stored exactly as before.
 */
export class HotKVCache extends BaseCache<Generation[]> {
  private readonly backend: ExactCacheBackend;

  constructor(client: ExactCacheClient, options: HotKVCacheOptions = {}) {
    super();
    this.backend = new ExactCacheBackend(client, options.namespace ?? "langchain-cache", options.ttlSeconds);
  }

  async lookup(prompt: string, llmKey: string): Promise<Generation[] | null> {
    const raw = await this.backend.get(this.keyEncoder(prompt, llmKey));
    if (raw === null) return null;
    const stored = JSON.parse(raw) as Parameters<typeof deserializeStoredGeneration>[0][];
    return stored.map((g) => deserializeStoredGeneration(g)) as Generation[];
  }

  async update(prompt: string, llmKey: string, value: Generation[]): Promise<void> {
    const serialized = value.map((g) => serializeGeneration(g));
    // When the cached AIMessage carries a model name and LangChain.js's
    // standard usage_metadata, it is stored with the entry so a later hit
    // attributes it to PCACHE.STATS's usageSaved* fields.
    await this.backend.set(
      this.keyEncoder(prompt, llmKey),
      JSON.stringify(serialized),
      undefined,
      extractUsage(value),
    );
  }
}
