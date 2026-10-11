// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Embedding-similarity string storage on top of SCACHE.*. Needs
// a server license that includes the semantic-cache feature; on a server with no license at all, get() treats a NOLICENSE
// reply as a miss and set() silently skips storing, so an unlicensed
// server degrades to "never cached" rather than breaking the caller.
//
// Shared by @hotkv/client/ai-sdk's hotkvCache() and @hotkv/client/langchain's
// HotKVSemanticCache; not part of either package's public API.

import type { TokenUsage } from "../usage.js";
import { isAlreadyExistsError, isNotFoundError, isNotLicensedError } from "./errorChecks.js";

export type SemanticCacheMetric = "cosine" | "l2" | "ip";

/** The subset of a HotKV client SemanticCacheBackend needs. `HotKV` and `HotKVCluster` both satisfy this. */
export interface SemanticCacheClient {
  scacheCreate(ns: string, dims: number, opts?: { metric?: SemanticCacheMetric; threshold?: number; ttlSeconds?: number }): Promise<void>;
  scacheGet(ns: string, vector: number[], thresholdOverride?: number): Promise<{ response: string; similarity: number } | null>;
  scacheSet(
    ns: string,
    queryText: string,
    response: string,
    vector: number[],
    ttlSeconds?: number,
    usage?: TokenUsage,
  ): Promise<void>;
  scacheStats?(ns: string): Promise<unknown>;
}

export interface SemanticCacheOptions {
  metric?: SemanticCacheMetric;
  threshold?: number;
  ttlSeconds?: number;
}

export class SemanticCacheBackend {
  private ready = false;

  constructor(
    private readonly client: SemanticCacheClient,
    private readonly namespace: string,
    private readonly options: SemanticCacheOptions = {},
  ) {}

  private async ensure(dims: number): Promise<void> {
    if (this.ready) return;
    try {
      await this.client.scacheCreate(this.namespace, dims, this.options);
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
      // "already exists or limit reached": make sure it is really there.
      try {
        await this.client.scacheStats?.(this.namespace);
      } catch (statsErr) {
        if (isNotFoundError(statsErr)) throw err;
      }
    }
    this.ready = true;
  }

  /** Nearest cached response to `vector` above the namespace's threshold, or `null` on a miss or an unlicensed server. */
  async get(vector: number[]): Promise<string | null> {
    try {
      const hit = await this.client.scacheGet(this.namespace, vector, this.options.threshold);
      return hit ? hit.response : null;
    } catch (err) {
      if (isNotLicensedError(err)) return null;
      throw err;
    }
  }

  /** Cache `response` to `queryText`, indexed by `vector`. `usage`, when
   * given, is recorded with the entry so a later hit attributes it to
   * SCACHE.STATS's usageSaved* fields. Silently skipped on an unlicensed
   * server. */
  async set(queryText: string, response: string, vector: number[], usage?: TokenUsage): Promise<void> {
    try {
      await this.ensure(vector.length);
      await this.client.scacheSet(this.namespace, queryText, response, vector, this.options.ttlSeconds, usage);
    } catch (err) {
      if (!isNotLicensedError(err)) throw err;
    }
  }
}
