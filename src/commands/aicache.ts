// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Typed wrappers for HotKV's AI caching command families: SCACHE.*
// (semantic cache), PCACHE.* (prompt/LLM response cache), the four
// identical keyed cache families (TOOL.CACHE.*, NCACHE.*, GUARD.*,
// RERANK.*), LLMSTATS.*, LLMBUDGET.*, PROMPT.* and EMBED.DEDUP.*. These
// commands need a server license that includes the matching feature; a
// server whose license does not cover it replies NOLICENSE, surfaced as
// NotLicensedError.

import type { Executor } from "../executor.js";
import { formatFloat, formatUsd, formatVectorComponent, requireFinite } from "../internal/numbers.js";
import { arr, num, numField, pairsToObject, str, strArr, strField, strOrNull } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";
import type { TokenUsage } from "../usage.js";
import { tokenUsageArgs } from "../usage.js";
import type { VectorMetric } from "./hotkvcore.js";

function vecArgs(values: number[]): CommandArg[] {
  return values.map((v) => formatVectorComponent(v));
}

/** The 6 `usage_saved_*` fields appended to SCACHE.STATS, PCACHE.STATS
 * and every keyed cache's STATS reply. */
export interface UsageSavedStats {
  usageSavedRequests: number;
  usageSavedInputTokens: number;
  usageSavedOutputTokens: number;
  usageSavedCacheReadTokens: number;
  usageSavedCacheWriteTokens: number;
  usageSavedCostUsd: number;
}

function decodeUsageSavedStats(o: Record<string, RespValue>): UsageSavedStats {
  return {
    usageSavedRequests: numField(o, "usage_saved_requests"),
    usageSavedInputTokens: numField(o, "usage_saved_input_tokens"),
    usageSavedOutputTokens: numField(o, "usage_saved_output_tokens"),
    usageSavedCacheReadTokens: numField(o, "usage_saved_cache_read_tokens"),
    usageSavedCacheWriteTokens: numField(o, "usage_saved_cache_write_tokens"),
    usageSavedCostUsd: numField(o, "usage_saved_cost_usd"),
  };
}

// ---------------------------------------------------------------------------
// SCACHE.* (semantic cache)

export interface SCacheCreateOptions {
  metric?: VectorMetric;
  threshold?: number;
  ttlSeconds?: number;
}

export interface SCacheStats extends UsageSavedStats {
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
  p50Us: number;
}

export interface SCacheHit {
  response: string;
  similarity: number;
}

// ---------------------------------------------------------------------------
// PCACHE.* (prompt / LLM response cache)

export interface PCacheCreateOptions {
  maxEntries?: number;
  ttlSeconds?: number;
  costPerHitUsd?: number;
}

export interface PCacheStats extends UsageSavedStats {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  memoryBytes: number;
  hitRate: number;
  p50Ns: number;
  p95Ns: number;
  p99Ns: number;
  costSavedUsd: number;
}

export interface PCacheHit {
  response: string;
  metadata: string;
  hitCount: number;
}

// ---------------------------------------------------------------------------
// The four identical keyed cache families.

export interface KeyedCacheStats extends UsageSavedStats {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  memoryBytes: number;
}

function decodeKeyedStats(v: RespValue): KeyedCacheStats {
  const o = pairsToObject(v);
  return {
    entries: numField(o, "entries"),
    hits: numField(o, "hits"),
    misses: numField(o, "misses"),
    evictions: numField(o, "evictions"),
    memoryBytes: numField(o, "memory_bytes"),
    ...decodeUsageSavedStats(o),
  };
}

function installKeyedCacheFamily(proto: object, wireCommand: string, methodPrefix: string): void {
  const cmd = (suffix: string) => `${wireCommand}.${suffix}`;
  Object.assign(proto, {
    [`${methodPrefix}Create`]: async function (
      this: Executor,
      ns: string,
      opts?: { maxEntries?: number; ttlSeconds?: number },
    ) {
      const args: CommandArg[] = [cmd("CREATE"), ns];
      if (opts?.maxEntries !== undefined) args.push("MAX_ENTRIES", opts.maxEntries);
      if (opts?.ttlSeconds !== undefined) args.push("TTL", opts.ttlSeconds);
      await this.execute(args);
    },
    [`${methodPrefix}Set`]: async function (
      this: Executor,
      ns: string,
      key: string,
      value: CommandArg,
      opts?: { ttlSeconds?: number; pxat?: number; meta?: string; usage?: TokenUsage },
    ) {
      const args: CommandArg[] = [cmd("SET"), ns, key, value];
      if (opts?.ttlSeconds !== undefined) args.push("TTL", opts.ttlSeconds);
      if (opts?.pxat !== undefined) args.push("PXAT", opts.pxat);
      if (opts?.meta !== undefined) args.push("META", opts.meta);
      if (opts?.usage) args.push(...tokenUsageArgs(opts.usage));
      await this.execute(args);
    },
    [`${methodPrefix}Get`]: async function (this: Executor, ns: string, key: string) {
      return strOrNull(await this.execute([cmd("GET"), ns, key]));
    },
    [`${methodPrefix}Del`]: async function (this: Executor, ns: string, key: string) {
      return num(await this.execute([cmd("DEL"), ns, key])) === 1;
    },
    [`${methodPrefix}Stats`]: async function (this: Executor, ns: string) {
      return decodeKeyedStats(await this.execute([cmd("STATS"), ns]));
    },
    [`${methodPrefix}Flush`]: async function (this: Executor, ns: string) {
      return num(await this.execute([cmd("FLUSH"), ns]));
    },
    [`${methodPrefix}Drop`]: async function (this: Executor, ns: string) {
      return num(await this.execute([cmd("DROP"), ns])) === 1;
    },
    [`${methodPrefix}List`]: async function (this: Executor) {
      return strArr(await this.execute([cmd("LIST")]));
    },
  });
}

// ---------------------------------------------------------------------------
// LLMSTATS.*

export interface LLMStatsSnapshot {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  requests1m: number;
  tokens1m: number;
  costUsd1m: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Calls recorded with `model` but no matching price table entry: tokens recorded, cost 0. */
  unpricedRequests: number;
}

export interface LLMStatsRecordOptions {
  error?: boolean;
  /** With `model`, the server prices this call from its price table and ignores `costUsd` (pass `0`). */
  model?: string;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

/** `source`: "default" (built in), "custom" (`llmStatsPriceSet()`) or "unpriced" (no price table entry; every price is 0). */
export type LLMPriceSource = "default" | "custom" | "unpriced";

/** Reply of `llmStatsPriceGet()`/one element of `llmStatsPriceList()`. Prices are USD per 1,000,000 tokens. */
export interface LLMPrice {
  model: string;
  source: LLMPriceSource | string;
  priced: boolean;
  retired: boolean;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
  cacheWrite5mUsdPerMtok: number;
  cacheWrite1hUsdPerMtok: number;
}

/** A price in USD per 1,000,000 tokens: a number, or a caller supplied decimal string (sent verbatim). */
export type PriceUsdPerMtok = number | string;

export interface LLMStatsPriceSetOptions {
  cacheReadUsdPerMtok?: PriceUsdPerMtok;
  /** Defaults to 1.25x `inputUsdPerMtok` when omitted. */
  cacheWrite5mUsdPerMtok?: PriceUsdPerMtok;
  /** Defaults to 2x `inputUsdPerMtok` when omitted. */
  cacheWrite1hUsdPerMtok?: PriceUsdPerMtok;
}

function decodeLLMPrice(v: RespValue): LLMPrice {
  const o = pairsToObject(v);
  return {
    model: strField(o, "model"),
    source: strField(o, "source"),
    priced: numField(o, "priced") === 1,
    retired: numField(o, "retired") === 1,
    inputUsdPerMtok: numField(o, "input_usd_per_mtok"),
    outputUsdPerMtok: numField(o, "output_usd_per_mtok"),
    cacheReadUsdPerMtok: numField(o, "cache_read_usd_per_mtok"),
    cacheWrite5mUsdPerMtok: numField(o, "cache_write_5m_usd_per_mtok"),
    cacheWrite1hUsdPerMtok: numField(o, "cache_write_1h_usd_per_mtok"),
  } satisfies LLMPrice;
}

/**
 * Formats a price as the plain decimal string `LLMSTATS.PRICE SET` requires
 * (no exponent, no sign, at most 6 fractional digits, no trailing zeros): a
 * number is rounded half up to 6 decimals, a `string` is the caller's own
 * decimal and is checked, not changed. See formatUsd.
 */
function formatPrice(value: PriceUsdPerMtok, what: string): string {
  return formatUsd(value, what);
}

// ---------------------------------------------------------------------------
// LLMBUDGET.*

export interface LLMBudgetStatus {
  tokensUsed: number;
  tokenLimit: number;
  costUsedUsd: number;
  costLimitUsd: number;
  windowSeconds: number;
  windowRemaining: number;
  requestsAllowed: number;
  requestsRejected: number;
  /** Calls consumed with `usage` but no matching price table entry. */
  unpricedRequests: number;
}

// ---------------------------------------------------------------------------
// PROMPT.*

export interface PromptVersion {
  version: number;
  content: string;
  metadata: string;
  createdUnix: number;
}

// ---------------------------------------------------------------------------
// EMBED.DEDUP.*

export interface EmbedDedupStats {
  hits: number;
  misses: number;
  entries: number;
}

export interface AICacheCommands {
  // SCACHE.*
  scacheCreate(ns: string, dims: number, opts?: SCacheCreateOptions): Promise<void>;
  /** `usage`, if given, records the original (uncached) call's tokens so a later hit attributes them (and their cost, once priced) to `scacheStats()`'s `usageSaved*` fields. */
  scacheSet(
    ns: string,
    queryText: string,
    response: string,
    vector: number[],
    ttlSeconds?: number | { pxat: number },
    usage?: TokenUsage,
  ): Promise<void>;
  scacheGet(ns: string, vector: number[], thresholdOverride?: number): Promise<SCacheHit | null>;
  scacheStats(ns: string): Promise<SCacheStats>;
  scacheFlush(ns: string): Promise<boolean>;
  scacheDrop(ns: string): Promise<boolean>;
  scacheList(): Promise<string[]>;
  scacheThreshold(ns: string, value: number): Promise<void>;

  // PCACHE.*
  pcacheCreate(ns: string, opts?: PCacheCreateOptions): Promise<void>;
  /** `opts.usage`, if given, records the original (uncached) call's tokens so a later hit attributes them (and their cost, once priced) to `pcacheStats()`'s `usageSaved*` fields. */
  pcacheSet(
    ns: string,
    prompt: string,
    response: string,
    opts?: { ttlSeconds?: number; pxat?: number; meta?: string; usage?: TokenUsage },
  ): Promise<void>;
  pcacheGet(ns: string, prompt: string): Promise<string | null>;
  pcacheGetEx(ns: string, prompt: string): Promise<PCacheHit | null>;
  pcacheDel(ns: string, prompt: string): Promise<boolean>;
  pcacheStats(ns: string): Promise<PCacheStats>;
  pcacheFlush(ns: string): Promise<number>;
  pcacheDrop(ns: string): Promise<boolean>;
  pcacheList(): Promise<string[]>;
  pcacheConfigSet(ns: string, key: "MAX_ENTRIES" | "TTL" | "COST_PER_HIT", value: CommandArg): Promise<void>;

  // TOOL.CACHE.*
  toolCacheCreate(ns: string, opts?: { maxEntries?: number; ttlSeconds?: number }): Promise<void>;
  toolCacheSet(ns: string, key: string, value: CommandArg, opts?: { ttlSeconds?: number; pxat?: number; meta?: string; usage?: TokenUsage }): Promise<void>;
  toolCacheGet(ns: string, key: string): Promise<string | null>;
  toolCacheDel(ns: string, key: string): Promise<boolean>;
  toolCacheStats(ns: string): Promise<KeyedCacheStats>;
  toolCacheFlush(ns: string): Promise<number>;
  toolCacheDrop(ns: string): Promise<boolean>;
  toolCacheList(): Promise<string[]>;

  // NCACHE.*
  nCacheCreate(ns: string, opts?: { maxEntries?: number; ttlSeconds?: number }): Promise<void>;
  nCacheSet(ns: string, key: string, value: CommandArg, opts?: { ttlSeconds?: number; pxat?: number; meta?: string; usage?: TokenUsage }): Promise<void>;
  nCacheGet(ns: string, key: string): Promise<string | null>;
  nCacheDel(ns: string, key: string): Promise<boolean>;
  nCacheStats(ns: string): Promise<KeyedCacheStats>;
  nCacheFlush(ns: string): Promise<number>;
  nCacheDrop(ns: string): Promise<boolean>;
  nCacheList(): Promise<string[]>;

  // GUARD.*
  guardCreate(ns: string, opts?: { maxEntries?: number; ttlSeconds?: number }): Promise<void>;
  guardSet(ns: string, key: string, value: CommandArg, opts?: { ttlSeconds?: number; pxat?: number; meta?: string; usage?: TokenUsage }): Promise<void>;
  guardGet(ns: string, key: string): Promise<string | null>;
  guardDel(ns: string, key: string): Promise<boolean>;
  guardStats(ns: string): Promise<KeyedCacheStats>;
  guardFlush(ns: string): Promise<number>;
  guardDrop(ns: string): Promise<boolean>;
  guardList(): Promise<string[]>;

  // RERANK.*
  rerankCreate(ns: string, opts?: { maxEntries?: number; ttlSeconds?: number }): Promise<void>;
  rerankSet(ns: string, key: string, value: CommandArg, opts?: { ttlSeconds?: number; pxat?: number; meta?: string; usage?: TokenUsage }): Promise<void>;
  rerankGet(ns: string, key: string): Promise<string | null>;
  rerankDel(ns: string, key: string): Promise<boolean>;
  rerankStats(ns: string): Promise<KeyedCacheStats>;
  rerankFlush(ns: string): Promise<number>;
  rerankDrop(ns: string): Promise<boolean>;
  rerankList(): Promise<string[]>;

  // LLMSTATS.*
  llmStatsBucket(name: string): Promise<void>;
  /** `cachedTokens` is cache-READ tokens. With `opts.model`, the server prices the call from its price table and ignores `costUsd` (pass `0`); an unpriced model still records tokens, at cost 0, counted in `unpricedRequests`. For OpenAI, pass `promptTokens - cachedTokens` as `inputTokens`. */
  llmStatsRecord(
    bucket: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
    costUsd: number,
    latencyMs: number,
    opts?: LLMStatsRecordOptions,
  ): Promise<void>;
  llmStatsGet(bucket: string): Promise<LLMStatsSnapshot>;
  llmStatsReset(bucket: string): Promise<boolean>;
  llmStatsDrop(bucket: string): Promise<boolean>;
  llmStatsList(): Promise<string[]>;

  // LLMSTATS.PRICE (per model price table)
  /** Sets a custom USD-per-1,000,000-token price for `model`, used by `llmStatsRecord(..., { model })` and `llmBudgetConsume(..., { usage })`. Omitted cache prices default to 0.1x/1.25x/2x `inputUsdPerMtok`. */
  llmStatsPriceSet(
    model: string,
    inputUsdPerMtok: PriceUsdPerMtok,
    outputUsdPerMtok: PriceUsdPerMtok,
    opts?: LLMStatsPriceSetOptions,
  ): Promise<void>;
  /** `model`'s price table entry. An unknown model comes back with `source: "unpriced"` and every price 0, not an error. */
  llmStatsPriceGet(model: string): Promise<LLMPrice>;
  /** Every known model's price table entry (built in and custom). */
  llmStatsPriceList(): Promise<LLMPrice[]>;
  /** Removes `model`'s custom price override, if any (`false` if there was none). */
  llmStatsPriceDel(model: string): Promise<boolean>;

  // LLMBUDGET.*
  llmBudgetSet(name: string, tokenLimit: number, costLimitUsd: number, windowSeconds: number): Promise<void>;
  /** Pass `usage` to have the server compute both tokens and cost from its price table instead (this sends `tokens`/`costUsd` as `0`/`0`, since the server ignores them). */
  llmBudgetConsume(name: string, tokens?: number, costUsd?: number, usage?: TokenUsage): Promise<boolean>;
  llmBudgetStatus(name: string): Promise<LLMBudgetStatus>;
  llmBudgetReset(name: string): Promise<boolean>;
  llmBudgetDrop(name: string): Promise<boolean>;
  llmBudgetList(): Promise<string[]>;

  // PROMPT.*
  promptPut(name: string, content: string, meta?: string): Promise<number>;
  promptGet(name: string, version?: number): Promise<PromptVersion | null>;
  promptLatest(name: string): Promise<PromptVersion | null>;
  promptSetActive(name: string, version: number): Promise<void>;
  promptVersions(name: string): Promise<number[]>;
  promptDrop(name: string): Promise<boolean>;
  promptList(): Promise<string[]>;

  // EMBED.DEDUP.*
  embedDedupPut(ns: string, hash: string, model: string, embedding: string): Promise<boolean>;
  embedDedupGet(ns: string, hash: string): Promise<string | null>;
  embedDedupRelease(ns: string, hash: string): Promise<boolean>;
  embedDedupStats(ns: string): Promise<EmbedDedupStats>;
  embedDedupDrop(ns: string): Promise<boolean>;
  embedDedupPurge(ns: string): Promise<boolean>;
  embedDedupList(): Promise<string[]>;
}

export function installAICacheCommands(proto: object): void {
  Object.assign(proto, {
    async scacheCreate(this: Executor, ns: string, dims: number, opts?: SCacheCreateOptions) {
      const args: CommandArg[] = ["SCACHE.CREATE", ns, dims];
      if (opts?.metric) args.push("METRIC", opts.metric);
      if (opts?.threshold !== undefined) args.push("THRESHOLD", formatFloat(opts.threshold, "threshold"));
      if (opts?.ttlSeconds !== undefined) args.push("TTL", opts.ttlSeconds);
      await this.execute(args);
    },
    async scacheSet(
      this: Executor,
      ns: string,
      queryText: string,
      response: string,
      vector: number[],
      ttlSeconds?: number | { pxat: number },
      usage?: TokenUsage,
    ) {
      const args: CommandArg[] = ["SCACHE.SET", ns, queryText, response, ...vecArgs(vector)];
      if (typeof ttlSeconds === "object") args.push("PXAT", ttlSeconds.pxat);
      else if (ttlSeconds !== undefined) args.push("TTL", ttlSeconds);
      if (usage) args.push(...tokenUsageArgs(usage));
      await this.execute(args);
    },
    async scacheGet(this: Executor, ns: string, vector: number[], thresholdOverride?: number) {
      const args: CommandArg[] = ["SCACHE.GET", ns, ...vecArgs(vector)];
      if (thresholdOverride !== undefined) args.push("THRESHOLD", formatFloat(thresholdOverride, "thresholdOverride"));
      const reply = await this.execute(args);
      if (reply === null) return null;
      const [response, similarity] = arr(reply);
      return { response: str(response as RespValue), similarity: num(similarity as RespValue) } satisfies SCacheHit;
    },
    async scacheStats(this: Executor, ns: string) {
      const o = pairsToObject(await this.execute(["SCACHE.STATS", ns]));
      return {
        entries: numField(o, "entries"),
        hits: numField(o, "hits"),
        misses: numField(o, "misses"),
        hitRate: numField(o, "hit_rate"),
        p50Us: numField(o, "p50_us"),
        ...decodeUsageSavedStats(o),
      } satisfies SCacheStats;
    },
    async scacheFlush(this: Executor, ns: string) {
      return num(await this.execute(["SCACHE.FLUSH", ns])) === 1;
    },
    async scacheDrop(this: Executor, ns: string) {
      return num(await this.execute(["SCACHE.DROP", ns])) === 1;
    },
    async scacheList(this: Executor) {
      return strArr(await this.execute(["SCACHE.LIST"]));
    },
    async scacheThreshold(this: Executor, ns: string, value: number) {
      await this.execute(["SCACHE.THRESHOLD", ns, formatFloat(value, "threshold")]);
    },

    async pcacheCreate(this: Executor, ns: string, opts?: PCacheCreateOptions) {
      const args: CommandArg[] = ["PCACHE.CREATE", ns];
      if (opts?.maxEntries !== undefined) args.push("MAX_ENTRIES", opts.maxEntries);
      if (opts?.ttlSeconds !== undefined) args.push("TTL", opts.ttlSeconds);
      if (opts?.costPerHitUsd !== undefined) args.push("COST_PER_HIT", formatFloat(opts.costPerHitUsd, "costPerHitUsd"));
      await this.execute(args);
    },
    async pcacheSet(
      this: Executor,
      ns: string,
      prompt: string,
      response: string,
      opts?: { ttlSeconds?: number; pxat?: number; meta?: string; usage?: TokenUsage },
    ) {
      const args: CommandArg[] = ["PCACHE.SET", ns, prompt, response];
      if (opts?.ttlSeconds !== undefined) args.push("TTL", opts.ttlSeconds);
      if (opts?.pxat !== undefined) args.push("PXAT", opts.pxat);
      if (opts?.meta !== undefined) args.push("META", opts.meta);
      if (opts?.usage) args.push(...tokenUsageArgs(opts.usage));
      await this.execute(args);
    },
    async pcacheGet(this: Executor, ns: string, prompt: string) {
      return strOrNull(await this.execute(["PCACHE.GET", ns, prompt]));
    },
    async pcacheGetEx(this: Executor, ns: string, prompt: string) {
      const reply = await this.execute(["PCACHE.GETEX", ns, prompt]);
      if (reply === null) return null;
      const [response, metadata, hitCount] = arr(reply);
      return {
        response: str(response as RespValue),
        metadata: str(metadata as RespValue),
        hitCount: num(hitCount as RespValue),
      } satisfies PCacheHit;
    },
    async pcacheDel(this: Executor, ns: string, prompt: string) {
      return num(await this.execute(["PCACHE.DEL", ns, prompt])) === 1;
    },
    async pcacheStats(this: Executor, ns: string) {
      const o = pairsToObject(await this.execute(["PCACHE.STATS", ns]));
      return {
        entries: numField(o, "entries"),
        hits: numField(o, "hits"),
        misses: numField(o, "misses"),
        evictions: numField(o, "evictions"),
        memoryBytes: numField(o, "memory_bytes"),
        hitRate: numField(o, "hit_rate"),
        p50Ns: numField(o, "p50_ns"),
        p95Ns: numField(o, "p95_ns"),
        p99Ns: numField(o, "p99_ns"),
        costSavedUsd: numField(o, "cost_saved_usd"),
        ...decodeUsageSavedStats(o),
      } satisfies PCacheStats;
    },
    async pcacheFlush(this: Executor, ns: string) {
      return num(await this.execute(["PCACHE.FLUSH", ns]));
    },
    async pcacheDrop(this: Executor, ns: string) {
      return num(await this.execute(["PCACHE.DROP", ns])) === 1;
    },
    async pcacheList(this: Executor) {
      return strArr(await this.execute(["PCACHE.LIST"]));
    },
    async pcacheConfigSet(this: Executor, ns: string, key: "MAX_ENTRIES" | "TTL" | "COST_PER_HIT", value: CommandArg) {
      await this.execute(["PCACHE.CONFIG", ns, "SET", key, value]);
    },

    async llmStatsBucket(this: Executor, name: string) {
      await this.execute(["LLMSTATS.BUCKET", name]);
    },
    async llmStatsRecord(
      this: Executor,
      bucket: string,
      inputTokens: number,
      outputTokens: number,
      cachedTokens: number,
      costUsd: number,
      latencyMs: number,
      opts?: LLMStatsRecordOptions,
    ) {
      // The server takes token counts and the latency as whole numbers (a
      // measured latency such as performance.now()'s 12.7 is an error to it).
      const whole = (n: number) => Math.max(0, Math.round(n));
      const args: CommandArg[] = [
        "LLMSTATS.RECORD",
        bucket,
        whole(inputTokens),
        whole(outputTokens),
        whole(cachedTokens),
        requireFinite(costUsd, "costUsd"),
        whole(latencyMs),
      ];
      if (opts?.error !== undefined) args.push("ERROR", opts.error ? 1 : 0);
      if (opts?.model !== undefined) args.push("MODEL", opts.model);
      if (opts?.cacheWrite5mTokens !== undefined) args.push("CACHEWRITE5M", whole(opts.cacheWrite5mTokens));
      if (opts?.cacheWrite1hTokens !== undefined) args.push("CACHEWRITE1H", whole(opts.cacheWrite1hTokens));
      await this.execute(args);
    },
    async llmStatsGet(this: Executor, bucket: string) {
      const o = pairsToObject(await this.execute(["LLMSTATS.GET", bucket]));
      return {
        requests: numField(o, "requests"),
        errors: numField(o, "errors"),
        inputTokens: numField(o, "input_tokens"),
        outputTokens: numField(o, "output_tokens"),
        cachedTokens: numField(o, "cached_tokens"),
        costUsd: numField(o, "cost_usd"),
        avgLatencyMs: numField(o, "avg_latency_ms"),
        requests1m: numField(o, "requests_1m"),
        tokens1m: numField(o, "tokens_1m"),
        costUsd1m: numField(o, "cost_usd_1m"),
        cacheWrite5mTokens: numField(o, "cache_write_5m_tokens"),
        cacheWrite1hTokens: numField(o, "cache_write_1h_tokens"),
        unpricedRequests: numField(o, "unpriced_requests"),
      } satisfies LLMStatsSnapshot;
    },
    async llmStatsReset(this: Executor, bucket: string) {
      return num(await this.execute(["LLMSTATS.RESET", bucket])) === 1;
    },
    async llmStatsDrop(this: Executor, bucket: string) {
      return num(await this.execute(["LLMSTATS.DROP", bucket])) === 1;
    },
    async llmStatsList(this: Executor) {
      return strArr(await this.execute(["LLMSTATS.LIST"]));
    },

    async llmStatsPriceSet(
      this: Executor,
      model: string,
      inputUsdPerMtok: PriceUsdPerMtok,
      outputUsdPerMtok: PriceUsdPerMtok,
      opts?: LLMStatsPriceSetOptions,
    ) {
      const args: CommandArg[] = [
        "LLMSTATS.PRICE",
        "SET",
        model,
        "INPUT",
        formatPrice(inputUsdPerMtok, "inputUsdPerMtok"),
        "OUTPUT",
        formatPrice(outputUsdPerMtok, "outputUsdPerMtok"),
      ];
      if (opts?.cacheReadUsdPerMtok !== undefined) args.push("CACHEREAD", formatPrice(opts.cacheReadUsdPerMtok, "cacheReadUsdPerMtok"));
      if (opts?.cacheWrite5mUsdPerMtok !== undefined) args.push("CACHEWRITE5M", formatPrice(opts.cacheWrite5mUsdPerMtok, "cacheWrite5mUsdPerMtok"));
      if (opts?.cacheWrite1hUsdPerMtok !== undefined) args.push("CACHEWRITE1H", formatPrice(opts.cacheWrite1hUsdPerMtok, "cacheWrite1hUsdPerMtok"));
      await this.execute(args);
    },
    async llmStatsPriceGet(this: Executor, model: string) {
      return decodeLLMPrice(await this.execute(["LLMSTATS.PRICE", "GET", model]));
    },
    async llmStatsPriceList(this: Executor) {
      return arr(await this.execute(["LLMSTATS.PRICE", "LIST"])).map(decodeLLMPrice);
    },
    async llmStatsPriceDel(this: Executor, model: string) {
      return num(await this.execute(["LLMSTATS.PRICE", "DEL", model])) === 1;
    },

    async llmBudgetSet(this: Executor, name: string, tokenLimit: number, costLimitUsd: number, windowSeconds: number) {
      await this.execute(["LLMBUDGET.SET", name, tokenLimit, formatUsd(costLimitUsd, "costLimitUsd"), windowSeconds]);
    },
    async llmBudgetConsume(this: Executor, name: string, tokens = 0, costUsd = 0, usage?: TokenUsage) {
      const args: CommandArg[] = ["LLMBUDGET.CONSUME", name, tokens, requireFinite(costUsd, "costUsd")];
      if (usage) args.push(...tokenUsageArgs(usage));
      return num(await this.execute(args)) === 1;
    },
    async llmBudgetStatus(this: Executor, name: string) {
      const o = pairsToObject(await this.execute(["LLMBUDGET.STATUS", name]));
      return {
        tokensUsed: numField(o, "tokens_used"),
        tokenLimit: numField(o, "token_limit"),
        costUsedUsd: numField(o, "cost_used_usd"),
        costLimitUsd: numField(o, "cost_limit_usd"),
        windowSeconds: numField(o, "window_seconds"),
        windowRemaining: numField(o, "window_remaining"),
        unpricedRequests: numField(o, "unpriced_requests"),
        requestsAllowed: numField(o, "requests_allowed"),
        requestsRejected: numField(o, "requests_rejected"),
      } satisfies LLMBudgetStatus;
    },
    async llmBudgetReset(this: Executor, name: string) {
      return num(await this.execute(["LLMBUDGET.RESET", name])) === 1;
    },
    async llmBudgetDrop(this: Executor, name: string) {
      return num(await this.execute(["LLMBUDGET.DROP", name])) === 1;
    },
    async llmBudgetList(this: Executor) {
      return strArr(await this.execute(["LLMBUDGET.LIST"]));
    },

    async promptPut(this: Executor, name: string, content: string, meta?: string) {
      const args: CommandArg[] = ["PROMPT.PUT", name, content];
      if (meta !== undefined) args.push("META", meta);
      return num(await this.execute(args));
    },
    async promptGet(this: Executor, name: string, version?: number) {
      const args: CommandArg[] = version === undefined ? ["PROMPT.GET", name] : ["PROMPT.GET", name, version];
      const reply = await this.execute(args);
      if (reply === null) return null;
      const [v, content, metadata, created] = arr(reply);
      return {
        version: num(v as RespValue),
        content: str(content as RespValue),
        metadata: str(metadata as RespValue),
        createdUnix: num(created as RespValue),
      } satisfies PromptVersion;
    },
    async promptLatest(this: Executor, name: string) {
      const reply = await this.execute(["PROMPT.LATEST", name]);
      if (reply === null) return null;
      const [v, content, metadata, created] = arr(reply);
      return {
        version: num(v as RespValue),
        content: str(content as RespValue),
        metadata: str(metadata as RespValue),
        createdUnix: num(created as RespValue),
      } satisfies PromptVersion;
    },
    async promptSetActive(this: Executor, name: string, version: number) {
      await this.execute(["PROMPT.SETACTIVE", name, version]);
    },
    async promptVersions(this: Executor, name: string) {
      return arr(await this.execute(["PROMPT.VERSIONS", name])).map(num);
    },
    async promptDrop(this: Executor, name: string) {
      return num(await this.execute(["PROMPT.DROP", name])) === 1;
    },
    async promptList(this: Executor) {
      return strArr(await this.execute(["PROMPT.LIST"]));
    },

    async embedDedupPut(this: Executor, ns: string, hash: string, model: string, embedding: string) {
      return num(await this.execute(["EMBED.DEDUP.PUT", ns, hash, model, embedding])) === 1;
    },
    async embedDedupGet(this: Executor, ns: string, hash: string) {
      return strOrNull(await this.execute(["EMBED.DEDUP.GET", ns, hash]));
    },
    async embedDedupRelease(this: Executor, ns: string, hash: string) {
      return num(await this.execute(["EMBED.DEDUP.RELEASE", ns, hash])) === 1;
    },
    async embedDedupStats(this: Executor, ns: string) {
      const o = pairsToObject((await this.execute(["EMBED.DEDUP.STATS", ns])));
      return {
        hits: numField(o, "hits"),
        misses: numField(o, "misses"),
        entries: numField(o, "entries"),
      } satisfies EmbedDedupStats;
    },
    async embedDedupDrop(this: Executor, ns: string) {
      return num(await this.execute(["EMBED.DEDUP.DROP", ns])) === 1;
    },
    async embedDedupPurge(this: Executor, ns: string) {
      return num(await this.execute(["EMBED.DEDUP.PURGE", ns])) === 1;
    },
    async embedDedupList(this: Executor) {
      return strArr(await this.execute(["EMBED.DEDUP.LIST"]));
    },
  });

  installKeyedCacheFamily(proto, "TOOL.CACHE", "toolCache");
  installKeyedCacheFamily(proto, "NCACHE", "nCache");
  installKeyedCacheFamily(proto, "GUARD", "guard");
  installKeyedCacheFamily(proto, "RERANK", "rerank");
}
