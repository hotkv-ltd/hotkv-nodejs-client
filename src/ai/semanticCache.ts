// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { SCacheStats } from "../commands/aicache.js";
import { isNotLicensedError } from "../errors.js";
import type { TokenUsage } from "../usage.js";
import type { GetOrCallResult } from "./promptCache.js";

export type SemanticCacheMetric = "cosine" | "l2" | "ip";

/** The subset of a HotKV client SemanticCache needs. HotKV and HotKVCluster both satisfy this. */
export interface SemanticCacheClient {
  scacheCreate(
    ns: string,
    dims: number,
    opts?: { metric?: SemanticCacheMetric; threshold?: number; ttlSeconds?: number },
  ): Promise<void>;
  scacheGet(
    ns: string,
    vector: number[],
    thresholdOverride?: number,
  ): Promise<{ response: string; similarity: number } | null>;
  scacheSet(
    ns: string,
    queryText: string,
    response: string,
    vector: number[],
    ttlSeconds?: number,
    usage?: TokenUsage,
  ): Promise<void>;
  scacheStats(ns: string): Promise<SCacheStats>;
}

export interface SemanticCacheOptions {
  metric?: SemanticCacheMetric;
  /** Minimum similarity (0..1) a stored answer must match to count as a hit. Server default is 0.85. */
  threshold?: number;
  ttlSeconds?: number;
}

function isAlreadyExists(err: unknown): boolean {
  // Structural, not `instanceof ReplyError`: see the comment on
  // replyErrorCode() in errors.ts for why.
  const raw = err instanceof Error ? (err as { raw?: unknown }).raw : undefined;
  return typeof raw === "string" && /already exists/i.test(raw);
}

/**
 * What the caller supplied function passed to getOrCall must return on a
 * miss: just the response, or the response plus its TokenUsage so a
 * later hit can attribute it (see stats()'s usageSaved* fields).
 */
export type SemanticCallResult = string | { response: string; tokenUsage?: TokenUsage };

function normalizeCallResult(result: SemanticCallResult): { response: string; tokenUsage?: TokenUsage } {
  return typeof result === "string" ? { response: result } : result;
}

/**
 * An idiomatic get-or-call cache in front of SCACHE.*: looks up the
 * nearest cached answer to an embedding vector above the namespace's
 * similarity threshold, calling the caller's function only on a miss. It
 * never computes embeddings itself; callers supply vectors from whatever
 * embedding provider they use. Needs LicenseFeature::SemanticCache on the
 * server; if unlicensed, getOrCall degrades to always calling fn.
 */
export class SemanticCache {
  private created = false;

  constructor(
    private readonly client: SemanticCacheClient,
    private readonly namespace: string,
    private readonly dimensions: number,
    private readonly options: SemanticCacheOptions = {},
  ) {}

  /** Ensures the backing SCACHE namespace exists. Safe to call more than once; idempotent. */
  async createNamespace(): Promise<void> {
    if (this.created) return;
    try {
      await this.client.scacheCreate(this.namespace, this.dimensions, this.options);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // "already exists or limit reached": make sure it is really there.
      try {
        await this.client.scacheStats(this.namespace);
      } catch (statsErr) {
        if (/not found/i.test((statsErr as { raw?: string }).raw ?? "")) throw err;
      }
    }
    this.created = true;
  }

  /** This namespace's scacheStats(), including the usageSaved* fields attributed from stored tokenUsage. */
  async stats(): Promise<SCacheStats> {
    return this.client.scacheStats(this.namespace);
  }

  // The server refuses SCACHE.GET/SET on a namespace nobody created, so the
  // first use creates it. An unlicensed server just means no cache.
  private async ensureNamespace(): Promise<void> {
    try {
      await this.createNamespace();
    } catch (err) {
      if (!isNotLicensedError(err)) throw err;
    }
  }

  /**
   * Returns the cached answer for the nearest neighbor of vector above the
   * namespace's similarity threshold, if any; otherwise calls fn, caches
   * (queryText, response, vector), and returns the fresh answer.
   */
  async getOrCall(
    queryText: string,
    vector: number[],
    fn: () => Promise<SemanticCallResult>,
  ): Promise<GetOrCallResult> {
    await this.ensureNamespace();
    try {
      const hit = await this.client.scacheGet(this.namespace, vector);
      if (hit !== null) return { response: hit.response, hit: true };
    } catch (err) {
      if (!isNotLicensedError(err)) throw err;
    }

    const { response, tokenUsage } = normalizeCallResult(await fn());

    try {
      await this.client.scacheSet(this.namespace, queryText, response, vector, this.options.ttlSeconds, tokenUsage);
    } catch (err) {
      if (!isNotLicensedError(err)) throw err;
    }

    return { response, hit: false };
  }
}
