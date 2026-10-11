// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Unit tests for SCACHE.*, PCACHE.*, the keyed caches, LLMSTATS.* and
// LLMBUDGET.*: exact wire argument lists for every option (and combinations of them), and name-based parsing of
// canned RESP2 flat arrays and RESP3 maps. No server needed.

import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../../src/usage.js";
import { makeRecordingClient } from "./helpers.js";

const USAGE_FULL: TokenUsage = {
  model: "claude-sonnet-5",
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWrite5mTokens: 7,
  cacheWrite1hTokens: 9,
};
const USAGE_MODEL_ONLY: TokenUsage = { model: "gpt-6-sol" };

describe("SCACHE.SET", () => {
  it("without usage", async () => {
    const client = makeRecordingClient();
    await client.scacheSet("ns", "q", "r", [1, 0]);
    expect(client.lastCall).toEqual(["SCACHE.SET", "ns", "q", "r", "1", "0"]);
  });

  it("with ttl and full usage", async () => {
    const client = makeRecordingClient();
    await client.scacheSet("ns", "q", "r", [1, 0], 60, USAGE_FULL);
    expect(client.lastCall).toEqual([
      "SCACHE.SET", "ns", "q", "r", "1", "0", "TTL", 60,
      "MODEL", "claude-sonnet-5", "INPUT", 100, "OUTPUT", 20,
      "CACHEREAD", 5, "CACHEWRITE5M", 7, "CACHEWRITE1H", 9,
    ]);
  });

  it("with usage only (no ttl)", async () => {
    const client = makeRecordingClient();
    await client.scacheSet("ns", "q", "r", [1], undefined, USAGE_MODEL_ONLY);
    expect(client.lastCall).toEqual(["SCACHE.SET", "ns", "q", "r", "1", "MODEL", "gpt-6-sol"]);
  });
});

describe("PCACHE.SET", () => {
  it("bare", async () => {
    const client = makeRecordingClient();
    await client.pcacheSet("ns", "prompt", "resp");
    expect(client.lastCall).toEqual(["PCACHE.SET", "ns", "prompt", "resp"]);
  });

  it("ttl, meta and usage together", async () => {
    const client = makeRecordingClient();
    await client.pcacheSet("ns", "prompt", "resp", { ttlSeconds: 3600, meta: '{"k":1}', usage: USAGE_MODEL_ONLY });
    expect(client.lastCall).toEqual([
      "PCACHE.SET", "ns", "prompt", "resp", "TTL", 3600, "META", '{"k":1}', "MODEL", "gpt-6-sol",
    ]);
  });
});

describe("keyed cache SET (TOOL.CACHE / NCACHE / GUARD / RERANK)", () => {
  it("every family sends its own wire prefix with usage", async () => {
    const client = makeRecordingClient();
    const setters: Array<[string, () => Promise<void>]> = [
      ["TOOL.CACHE.SET", () => client.toolCacheSet("ns", "k", "v", { ttlSeconds: 60, meta: "m", usage: USAGE_MODEL_ONLY })],
      ["NCACHE.SET", () => client.nCacheSet("ns", "k", "v", { ttlSeconds: 60, meta: "m", usage: USAGE_MODEL_ONLY })],
      ["GUARD.SET", () => client.guardSet("ns", "k", "v", { ttlSeconds: 60, meta: "m", usage: USAGE_MODEL_ONLY })],
      ["RERANK.SET", () => client.rerankSet("ns", "k", "v", { ttlSeconds: 60, meta: "m", usage: USAGE_MODEL_ONLY })],
    ];
    for (const [expectedName, call] of setters) {
      await call();
      expect(client.lastCall).toEqual([expectedName, "ns", "k", "v", "TTL", 60, "META", "m", "MODEL", "gpt-6-sol"]);
    }
  });

  it("without any options", async () => {
    const client = makeRecordingClient();
    await client.guardSet("ns", "k", "v");
    expect(client.lastCall).toEqual(["GUARD.SET", "ns", "k", "v"]);
  });
});

describe("LLMSTATS.RECORD", () => {
  it("bare", async () => {
    const client = makeRecordingClient();
    await client.llmStatsRecord("bucket", 100, 50, 0, 0.002, 120);
    expect(client.lastCall).toEqual(["LLMSTATS.RECORD", "bucket", 100, 50, 0, 0.002, 120]);
  });

  it("sends token counts and the latency as whole numbers, which the server requires", async () => {
    const client = makeRecordingClient();
    // performance.now() differences are fractional; the server answers "invalid numeric argument" to them.
    await client.llmStatsRecord("bucket", 10.4, 5.5, 0.2, 0.01, 12.7, { cacheWrite5mTokens: 1.6, cacheWrite1hTokens: 3.2 });
    expect(client.lastCall).toEqual([
      "LLMSTATS.RECORD", "bucket", 10, 6, 0, 0.01, 13, "CACHEWRITE5M", 2, "CACHEWRITE1H", 3,
    ]);
    await client.llmStatsRecord("bucket", 1, 1, 0, 0, -4.2);
    expect(client.lastCall).toEqual(["LLMSTATS.RECORD", "bucket", 1, 1, 0, 0, 0]);
  });

  it("every new option, in order", async () => {
    const client = makeRecordingClient();
    await client.llmStatsRecord("bucket", 100, 50, 10, 0, 5, {
      error: true,
      model: "claude-sonnet-5",
      cacheWrite5mTokens: 7,
      cacheWrite1hTokens: 9,
    });
    expect(client.lastCall).toEqual([
      "LLMSTATS.RECORD", "bucket", 100, 50, 10, 0, 5,
      "ERROR", 1, "MODEL", "claude-sonnet-5", "CACHEWRITE5M", 7, "CACHEWRITE1H", 9,
    ]);
  });

  it("error: false is still sent explicitly", async () => {
    const client = makeRecordingClient();
    await client.llmStatsRecord("bucket", 1, 1, 0, 0, 1, { error: false });
    expect(client.lastCall).toEqual(["LLMSTATS.RECORD", "bucket", 1, 1, 0, 0, 1, "ERROR", 0]);
  });
});

describe("LLMSTATS.PRICE", () => {
  it("SET with only the required prices", async () => {
    const client = makeRecordingClient();
    await client.llmStatsPriceSet("gpt-6-sol", 3, 15);
    expect(client.lastCall).toEqual(["LLMSTATS.PRICE", "SET", "gpt-6-sol", "INPUT", "3", "OUTPUT", "15"]);
  });

  it("SET with every cache tier and a string price passed through as-is", async () => {
    const client = makeRecordingClient();
    await client.llmStatsPriceSet("claude-sonnet-5", "3.00", 15, {
      cacheReadUsdPerMtok: 0.3,
      cacheWrite5mUsdPerMtok: 3.75,
      cacheWrite1hUsdPerMtok: 6,
    });
    expect(client.lastCall).toEqual([
      "LLMSTATS.PRICE", "SET", "claude-sonnet-5",
      "INPUT", "3.00", "OUTPUT", "15",
      "CACHEREAD", "0.3", "CACHEWRITE5M", "3.75", "CACHEWRITE1H", "6",
    ]);
  });

  it("SET formats numbers without exponent notation or excess decimals", async () => {
    const client = makeRecordingClient();
    await client.llmStatsPriceSet("m", 0.0000001, 1234567.891234);
    const [, , , , inputPrice, , outputPrice] = client.lastCall;
    expect(String(inputPrice).toLowerCase()).not.toContain("e");
    expect(inputPrice).toBe("0");
    expect(outputPrice).toBe("1234567.891234");
  });

  it("GET parses a flat array", async () => {
    const client = makeRecordingClient();
    client.when("LLMSTATS.PRICE GET", [
      "model", "claude-sonnet-5",
      "source", "default",
      "priced", 1,
      "retired", 0,
      "input_usd_per_mtok", "3.000000",
      "output_usd_per_mtok", "15.000000",
      "cache_read_usd_per_mtok", "0.300000",
      "cache_write_5m_usd_per_mtok", "3.750000",
      "cache_write_1h_usd_per_mtok", "6.000000",
    ]);
    const price = await client.llmStatsPriceGet("claude-sonnet-5");
    expect(client.lastCall).toEqual(["LLMSTATS.PRICE", "GET", "claude-sonnet-5"]);
    expect(price).toEqual({
      model: "claude-sonnet-5",
      source: "default",
      priced: true,
      retired: false,
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
      cacheReadUsdPerMtok: 0.3,
      cacheWrite5mUsdPerMtok: 3.75,
      cacheWrite1hUsdPerMtok: 6,
    });
  });

  it("GET parses a native RESP3 map for an unknown (unpriced) model", async () => {
    const client = makeRecordingClient();
    client.when(
      "LLMSTATS.PRICE GET",
      new Map<string, unknown>([
        ["model", "no-such-model"],
        ["source", "unpriced"],
        ["priced", 0],
        ["retired", 0],
        ["input_usd_per_mtok", "0.000000"],
        ["output_usd_per_mtok", "0.000000"],
        ["cache_read_usd_per_mtok", "0.000000"],
        ["cache_write_5m_usd_per_mtok", "0.000000"],
        ["cache_write_1h_usd_per_mtok", "0.000000"],
      ]),
    );
    const price = await client.llmStatsPriceGet("no-such-model");
    expect(price.source).toBe("unpriced");
    expect(price.priced).toBe(false);
    expect(price.inputUsdPerMtok).toBe(0);
  });

  it("LIST parses an array of arrays", async () => {
    const client = makeRecordingClient();
    const one = [
      "model", "a", "source", "custom", "priced", 1, "retired", 1,
      "input_usd_per_mtok", "1.000000", "output_usd_per_mtok", "2.000000",
      "cache_read_usd_per_mtok", "0.100000", "cache_write_5m_usd_per_mtok", "1.250000",
      "cache_write_1h_usd_per_mtok", "2.000000",
    ];
    const two = [
      "model", "b", "source", "default", "priced", 1, "retired", 0,
      "input_usd_per_mtok", "3.000000", "output_usd_per_mtok", "4.000000",
      "cache_read_usd_per_mtok", "0.300000", "cache_write_5m_usd_per_mtok", "3.750000",
      "cache_write_1h_usd_per_mtok", "6.000000",
    ];
    client.when("LLMSTATS.PRICE LIST", [one, two]);
    const prices = await client.llmStatsPriceList();
    expect(client.lastCall).toEqual(["LLMSTATS.PRICE", "LIST"]);
    expect(prices.map((p) => p.model)).toEqual(["a", "b"]);
    expect(prices[0]?.retired).toBe(true);
    expect(prices[1]?.retired).toBe(false);
  });

  it("DEL returns whether a custom override was removed", async () => {
    const client = makeRecordingClient();
    client.when("LLMSTATS.PRICE DEL", 1);
    expect(await client.llmStatsPriceDel("custom-model")).toBe(true);
    expect(client.lastCall).toEqual(["LLMSTATS.PRICE", "DEL", "custom-model"]);

    client.when("LLMSTATS.PRICE DEL", 0);
    expect(await client.llmStatsPriceDel("custom-model")).toBe(false);
  });
});

describe("LLMBUDGET.CONSUME", () => {
  it("plain tokens and cost", async () => {
    const client = makeRecordingClient();
    client.when("LLMBUDGET.CONSUME", 1);
    await client.llmBudgetConsume("name", 100, 0.05);
    expect(client.lastCall).toEqual(["LLMBUDGET.CONSUME", "name", 100, 0.05]);
  });

  it("with usage sends zero tokens and cost", async () => {
    const client = makeRecordingClient();
    client.when("LLMBUDGET.CONSUME", 1);
    await client.llmBudgetConsume("name", undefined, undefined, USAGE_FULL);
    expect(client.lastCall).toEqual([
      "LLMBUDGET.CONSUME", "name", 0, 0,
      "MODEL", "claude-sonnet-5", "INPUT", 100, "OUTPUT", 20,
      "CACHEREAD", 5, "CACHEWRITE5M", 7, "CACHEWRITE1H", 9,
    ]);
  });
});

describe("STATS parsing: RESP2 flat arrays and RESP3 maps, by field name", () => {
  it("SCACHE.STATS parses the 11-field flat array", async () => {
    const client = makeRecordingClient();
    client.when("SCACHE.STATS", [
      "entries", 3, "hits", 7, "misses", 2, "hit_rate", "0.777778", "p50_us", 150,
      "usage_saved_requests", 7, "usage_saved_input_tokens", 700,
      "usage_saved_output_tokens", 140, "usage_saved_cache_read_tokens", 0,
      "usage_saved_cache_write_tokens", 0, "usage_saved_cost_usd", "0.000160",
    ]);
    const stats = await client.scacheStats("ns");
    expect(stats.entries).toBe(3);
    expect(stats.hitRate).toBeCloseTo(0.777778);
    expect(stats.usageSavedRequests).toBe(7);
    expect(stats.usageSavedCostUsd).toBeCloseTo(0.00016);
  });

  it("PCACHE.STATS parses the 16-field native RESP3 map", async () => {
    const client = makeRecordingClient();
    client.when(
      "PCACHE.STATS",
      new Map<string, unknown>([
        ["entries", 1], ["hits", 4], ["misses", 1], ["evictions", 0], ["memory_bytes", 512],
        ["hit_rate", "0.8"], ["p50_ns", 900], ["p95_ns", 1200], ["p99_ns", 1500],
        ["cost_saved_usd", "0.004000"],
        ["usage_saved_requests", 4], ["usage_saved_input_tokens", 400],
        ["usage_saved_output_tokens", 80], ["usage_saved_cache_read_tokens", 0],
        ["usage_saved_cache_write_tokens", 0], ["usage_saved_cost_usd", "0.000600"],
      ]),
    );
    const stats = await client.pcacheStats("ns");
    expect(stats.costSavedUsd).toBeCloseTo(0.004);
    expect(stats.usageSavedCostUsd).toBeCloseTo(0.0006);
    expect(stats.usageSavedOutputTokens).toBe(80);
  });

  it("keyed cache STATS parses the 11-field flat array", async () => {
    const client = makeRecordingClient();
    client.when("TOOL.CACHE.STATS", [
      "entries", 2, "hits", 1, "misses", 1, "evictions", 0, "memory_bytes", 64,
      "usage_saved_requests", 1, "usage_saved_input_tokens", 50,
      "usage_saved_output_tokens", 10, "usage_saved_cache_read_tokens", 0,
      "usage_saved_cache_write_tokens", 0, "usage_saved_cost_usd", "0.000010",
    ]);
    const stats = await client.toolCacheStats("ns");
    expect(stats.entries).toBe(2);
    expect(stats.usageSavedCostUsd).toBeCloseTo(0.00001);
  });

  it("LLMSTATS.GET parses the 13-field reply, including unpriced_requests", async () => {
    const client = makeRecordingClient();
    client.when("LLMSTATS.GET", [
      "requests", 10, "errors", 1, "input_tokens", 1000, "output_tokens", 200,
      "cached_tokens", 50, "cost_usd", "0.005000", "avg_latency_ms", "120.500000",
      "requests_1m", 2, "tokens_1m", 300, "cost_usd_1m", "0.001000",
      "cache_write_5m_tokens", 7, "cache_write_1h_tokens", 9, "unpriced_requests", 1,
    ]);
    const stats = await client.llmStatsGet("bucket");
    expect(stats.costUsd).toBeCloseTo(0.005);
    expect(stats.cacheWrite5mTokens).toBe(7);
    expect(stats.unpricedRequests).toBe(1);
  });

  it("LLMBUDGET.STATUS parses the 9-field reply", async () => {
    const client = makeRecordingClient();
    client.when("LLMBUDGET.STATUS", [
      "tokens_used", 100, "token_limit", 1000, "cost_used_usd", "0.050000",
      "cost_limit_usd", "1.000000", "window_seconds", 3600, "window_remaining", 3000,
      "requests_allowed", 5, "requests_rejected", 0, "unpriced_requests", 2,
    ]);
    const status = await client.llmBudgetStatus("name");
    expect(status.costUsedUsd).toBeCloseTo(0.05);
    expect(status.unpricedRequests).toBe(2);
  });

  it("tolerates missing and unknown fields (defaults to 0, never throws)", async () => {
    const client = makeRecordingClient();
    client.when("SCACHE.STATS", ["entries", 1, "totally_new_field", "x"]);
    const stats = await client.scacheStats("ns");
    expect(stats.entries).toBe(1);
    expect(stats.hitRate).toBe(0);
  });
});
