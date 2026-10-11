// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { PCacheStats } from "../commands/aicache.js";
import { isNotLicensedError } from "../errors.js";
import type { TokenUsage } from "../usage.js";
import { buildPromptCacheKey, type PromptCacheKeyInput } from "./cacheKey.js";

/** The subset of a HotKV client PromptCache needs. HotKV and HotKVCluster both satisfy this. */
export interface PromptCacheClient {
  pcacheCreate(
    ns: string,
    opts?: { maxEntries?: number; ttlSeconds?: number; costPerHitUsd?: number },
  ): Promise<void>;
  pcacheGet(ns: string, prompt: string): Promise<string | null>;
  pcacheSet(
    ns: string,
    prompt: string,
    response: string,
    opts?: { ttlSeconds?: number; meta?: string; usage?: TokenUsage },
  ): Promise<void>;
  pcacheStats(ns: string): Promise<PCacheStats>;
  llmStatsBucket(name: string): Promise<void>;
  llmStatsRecord(
    bucket: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
    costUsd: number,
    latencyMs: number,
    opts?: { error?: boolean },
  ): Promise<void>;
}

export interface PromptCacheOptions {
  /** Default TTL for stored entries, in seconds. Omit for no expiry. */
  ttlSeconds?: number;
  maxEntries?: number;
  costPerHitUsd?: number;
  /** When set, every getOrCall records hit/miss token and cost accounting to this LLMSTATS bucket. */
  statsBucket?: string;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

/** What the caller supplied function passed to getOrCall must return on a miss. */
export interface LLMCallResult {
  response: string;
  usage?: LLMUsage;
  /**
   * The original (uncached) call's token usage, if you have it (for
   * example from the provider's own response). Stored with the cache
   * entry so a later hit attributes it, and once the model is priced its
   * cost, to stats()'s usageSaved* fields. Distinct from `usage` above,
   * which only feeds `statsBucket`'s LLMSTATS.RECORD accounting.
   */
  tokenUsage?: TokenUsage;
}

export interface GetOrCallResult {
  response: string;
  /** Whether the response came from the cache (true) or was just produced by calling the LLM (false). */
  hit: boolean;
}

function isAlreadyExists(err: unknown): boolean {
  // Structural, not `instanceof ReplyError`: see the comment on
  // replyErrorCode() in errors.ts for why.
  const raw = err instanceof Error ? (err as { raw?: unknown }).raw : undefined;
  return typeof raw === "string" && /already exists/i.test(raw);
}

/**
 * An idiomatic get-or-call cache in front of PCACHE.*: on a hit it returns
 * the stored response without invoking the LLM; on a miss it calls the
 * caller's function, stores the result, and returns it. Needs
 * LicenseFeature::PromptCache on the server; if the cache itself is
 * unlicensed, getOrCall degrades to always calling fn rather than failing.
 */
export class PromptCache {
  private created = false;

  constructor(
    private readonly client: PromptCacheClient,
    private readonly namespace: string,
    private readonly options: PromptCacheOptions = {},
  ) {}

  /** Ensures the backing PCACHE namespace exists. Safe to call more than once; idempotent. */
  async createNamespace(): Promise<void> {
    if (this.created) return;
    try {
      await this.client.pcacheCreate(this.namespace, {
        maxEntries: this.options.maxEntries,
        ttlSeconds: this.options.ttlSeconds,
        costPerHitUsd: this.options.costPerHitUsd,
      });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // "already exists or limit reached": make sure it is really there.
      try {
        await this.client.pcacheStats(this.namespace);
      } catch (statsErr) {
        if (/not found/i.test((statsErr as { raw?: string }).raw ?? "")) throw err;
      }
    }
    this.created = true;
  }

  /**
   * This namespace's pcacheStats(), including the usageSaved* fields attributed from stored tokenUsage.
   * A namespace nothing has used yet is reported as not found: asking never creates it.
   */
  async stats(): Promise<PCacheStats> {
    return this.client.pcacheStats(this.namespace);
  }

  // The server refuses PCACHE.GET/SET on a namespace nobody created, so the
  // first use creates it. An unlicensed server just means no cache.
  private async ensureNamespace(): Promise<void> {
    try {
      await this.createNamespace();
    } catch (err) {
      if (!isNotLicensedError(err)) throw err;
    }
  }

  /**
   * Returns the cached response for this exact (provider, model, system,
   * messages, params) tuple if present; otherwise calls fn, caches its
   * response, and returns that. The LLM call happens only on a miss.
   */
  async getOrCall(input: PromptCacheKeyInput, fn: () => Promise<LLMCallResult>): Promise<GetOrCallResult> {
    const key = buildPromptCacheKey(input);
    const start = Date.now();
    await this.ensureNamespace();

    try {
      const cached = await this.client.pcacheGet(this.namespace, key);
      if (cached !== null) {
        await this.record({ latencyMs: Date.now() - start }, true);
        return { response: cached, hit: true };
      }
    } catch (err) {
      if (!isNotLicensedError(err)) throw err;
      // The cache itself is unavailable, not the LLM: fall through to fn().
    }

    const result = await fn();

    try {
      await this.client.pcacheSet(this.namespace, key, result.response, {
        ttlSeconds: this.options.ttlSeconds,
        usage: result.tokenUsage,
      });
    } catch (err) {
      if (!isNotLicensedError(err)) throw err;
    }
    await this.record(result.usage ?? {}, false);

    return { response: result.response, hit: false };
  }

  private async record(usage: LLMUsage, hit: boolean): Promise<void> {
    if (!this.options.statsBucket) return;
    const inputTokens = hit ? 0 : (usage.inputTokens ?? 0);
    const outputTokens = hit ? 0 : (usage.outputTokens ?? 0);
    const cachedTokens = hit ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : 0;
    const costUsd = hit ? 0 : (usage.costUsd ?? 0);
    try {
      await this.client.llmStatsRecord(
        this.options.statsBucket,
        inputTokens,
        outputTokens,
        cachedTokens,
        costUsd,
        usage.latencyMs ?? 0,
      );
    } catch (err) {
      if (!isNotLicensedError(err)) throw err;
    }
  }
}
