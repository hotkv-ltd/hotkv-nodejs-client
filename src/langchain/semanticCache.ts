// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { createHash } from "node:crypto";
import { BaseCache, deserializeStoredGeneration, serializeGeneration } from "@langchain/core/caches";
import type { Generation } from "@langchain/core/outputs";
import { SemanticCacheBackend, type SemanticCacheClient, type SemanticCacheMetric } from "../internal/semanticCache.js";
import { extractUsage } from "./_usage.js";

/** The subset of a LangChain.js `Embeddings` instance this cache needs. */
export interface EmbeddingsLike {
  embedQuery(text: string): Promise<number[]>;
}

export interface HotKVSemanticCacheOptions {
  namespace?: string;
  metric?: SemanticCacheMetric;
  /** Minimum similarity (0..1) a stored answer must match to count as a hit. Server default is 0.85. */
  threshold?: number;
  ttlSeconds?: number;
}

/**
 * Similarity based LLM response cache for LangChain.js, on top of `SCACHE.*`.
 *
 * ```ts
 * import { HotKV } from "@hotkv/client";
 * import { HotKVSemanticCache } from "@hotkv/client/langchain";
 * import { OpenAIEmbeddings } from "@langchain/openai";
 * import { ChatOpenAI } from "@langchain/openai";
 *
 * const client = new HotKV({ url: process.env.HOTKV_URL });
 * const cache = new HotKVSemanticCache(client, new OpenAIEmbeddings(), { threshold: 0.86 });
 * const model = new ChatOpenAI({ cache });
 * ```
 *
 * `lookup()` embeds the prompt with the given `Embeddings` object and
 * returns the nearest cached answer above `threshold`, if any; `update()`
 * embeds and stores it. Every distinct `llmKey` (which LangChain.js
 * derives from the model class and every invocation parameter) gets its
 * own `SCACHE.*` namespace, so a semantically similar prompt sent to a
 * different model, or the same model with different parameters, never
 * returns another model's answer.
 */
export class HotKVSemanticCache extends BaseCache<Generation[]> {
  private readonly client: SemanticCacheClient;
  private readonly embeddings: EmbeddingsLike;
  private readonly namespace: string;
  private readonly options: HotKVSemanticCacheOptions;
  private readonly backends = new Map<string, SemanticCacheBackend>();

  constructor(client: SemanticCacheClient, embeddings: EmbeddingsLike, options: HotKVSemanticCacheOptions = {}) {
    super();
    this.client = client;
    this.embeddings = embeddings;
    this.namespace = options.namespace ?? "langchain-semantic-cache";
    this.options = options;
  }

  private backendFor(llmKey: string): SemanticCacheBackend {
    const suffix = createHash("sha256").update(llmKey, "utf8").digest("hex").slice(0, 16);
    const namespace = `${this.namespace}:${suffix}`;
    let backend = this.backends.get(namespace);
    if (!backend) {
      backend = new SemanticCacheBackend(this.client, namespace, this.options);
      this.backends.set(namespace, backend);
    }
    return backend;
  }

  async lookup(prompt: string, llmKey: string): Promise<Generation[] | null> {
    const vector = await this.embeddings.embedQuery(prompt);
    const raw = await this.backendFor(llmKey).get(vector);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as Parameters<typeof deserializeStoredGeneration>[0][];
    return stored.map((g) => deserializeStoredGeneration(g)) as Generation[];
  }

  async update(prompt: string, llmKey: string, value: Generation[]): Promise<void> {
    const vector = await this.embeddings.embedQuery(prompt);
    const serialized = value.map((g) => serializeGeneration(g));
    // See HotKVCache.update(): stored only when the response reliably
    // carries a model name and LangChain.js's usage_metadata.
    await this.backendFor(llmKey).set(prompt, JSON.stringify(serialized), vector, extractUsage(value));
  }
}
