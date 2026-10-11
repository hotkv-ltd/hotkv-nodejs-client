// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Unit tests for @hotkv/client/ai's usage passthrough and stats() accessors. Uses a small fake client (structurally
// typed, like PromptCache/SemanticCache themselves) instead of a live
// server.

import { describe, expect, it } from "vitest";
import { PromptCache, SemanticCache, type PromptCacheClient, type SemanticCacheClient } from "../../src/ai/index.js";
import type { TokenUsage } from "../../src/usage.js";

const USAGE: TokenUsage = { model: "claude-sonnet-5", inputTokens: 42, outputTokens: 8 };

function fakePromptClient(): PromptCacheClient & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async pcacheCreate() {
      calls.push(["pcacheCreate"]);
    },
    async pcacheGet() {
      calls.push(["pcacheGet"]);
      return null;
    },
    async pcacheSet(ns, prompt, response, opts) {
      calls.push(["pcacheSet", ns, prompt, response, opts]);
    },
    async pcacheStats(ns) {
      calls.push(["pcacheStats", ns]);
      return { entries: 5, usageSavedCostUsd: 0.0012 } as never;
    },
    async llmStatsBucket() {},
    async llmStatsRecord() {},
  };
}

function fakeSemanticClient(): SemanticCacheClient & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async scacheCreate() {
      calls.push(["scacheCreate"]);
    },
    async scacheGet() {
      calls.push(["scacheGet"]);
      return null;
    },
    async scacheSet(ns, queryText, response, vector, ttlSeconds, usage) {
      calls.push(["scacheSet", ns, queryText, response, vector, ttlSeconds, usage]);
    },
    async scacheStats(ns) {
      calls.push(["scacheStats", ns]);
      return { entries: 2 } as never;
    },
  };
}

describe("PromptCache", () => {
  it("getOrCall() stores tokenUsage returned by fn", async () => {
    const client = fakePromptClient();
    const cache = new PromptCache(client, "ns");
    const { response, hit } = await cache.getOrCall(
      { provider: "anthropic", model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], params: {} },
      async () => ({ response: "the answer", tokenUsage: USAGE }),
    );
    expect(hit).toBe(false);
    expect(response).toBe("the answer");
    const setCall = client.calls.find((c) => c[0] === "pcacheSet");
    expect(setCall?.[3]).toBe("the answer");
    expect((setCall?.[4] as { usage?: TokenUsage })?.usage).toEqual(USAGE);
  });

  it("getOrCall() without tokenUsage is unaffected", async () => {
    const client = fakePromptClient();
    const cache = new PromptCache(client, "ns");
    await cache.getOrCall(
      { provider: "anthropic", model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], params: {} },
      async () => ({ response: "plain" }),
    );
    const setCall = client.calls.find((c) => c[0] === "pcacheSet");
    expect((setCall?.[4] as { usage?: TokenUsage })?.usage).toBeUndefined();
  });

  it("stats() delegates to pcacheStats(namespace)", async () => {
    const client = fakePromptClient();
    const cache = new PromptCache(client, "ns");
    const stats = await cache.stats();
    expect(client.calls).toContainEqual(["pcacheStats", "ns"]);
    expect(stats).toEqual({ entries: 5, usageSavedCostUsd: 0.0012 });
  });
});

describe("SemanticCache", () => {
  it("getOrCall() stores tokenUsage returned by fn (object form)", async () => {
    const client = fakeSemanticClient();
    const cache = new SemanticCache(client, "ns", 2);
    const { response, hit } = await cache.getOrCall("q", [1, 0], async () => ({
      response: "semantic answer",
      tokenUsage: USAGE,
    }));
    expect(hit).toBe(false);
    expect(response).toBe("semantic answer");
    const setCall = client.calls.find((c) => c[0] === "scacheSet");
    expect(setCall?.[6]).toEqual(USAGE);
  });

  it("getOrCall() still accepts a plain string return (backward compatible)", async () => {
    const client = fakeSemanticClient();
    const cache = new SemanticCache(client, "ns", 2);
    const { response } = await cache.getOrCall("q", [1, 0], async () => "plain string answer");
    expect(response).toBe("plain string answer");
    const setCall = client.calls.find((c) => c[0] === "scacheSet");
    expect(setCall?.[6]).toBeUndefined();
  });

  it("stats() delegates to scacheStats(namespace)", async () => {
    const client = fakeSemanticClient();
    const cache = new SemanticCache(client, "ns", 2);
    const stats = await cache.stats();
    expect(client.calls).toContainEqual(["scacheStats", "ns"]);
    expect(stats).toEqual({ entries: 2 });
  });
});
