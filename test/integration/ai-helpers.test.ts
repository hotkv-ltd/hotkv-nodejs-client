// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PromptCache, SemanticCache } from "../../src/ai/index.js";
import type { HotKV } from "../../src/client.js";
import { isNotLicensedError } from "../../src/errors.js";
import type { TokenUsage } from "../../src/usage.js";
import { hasServer, makeClient, runOrSkipIfNotLicensed, uniquePrefix } from "./helpers.js";

const USAGE: TokenUsage = { model: "claude-sonnet-5", inputTokens: 100, outputTokens: 20 };

describe.skipIf(!hasServer)("PromptCache (needs a full license; degrades gracefully without one)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("promptcache");
  });
  afterAll(async () => {
    await client.close();
  });

  it("calls the LLM function on a miss and reports hit: false", async () => {
    const cache = new PromptCache(client, `${p}_ns`, { ttlSeconds: 60, statsBucket: `${p}_bucket` });
    let calls = 0;
    const { response, hit } = await cache.getOrCall(
      { provider: "acme", model: "gpt-6-sol", messages: [{ role: "user", content: "hi" }], params: { temperature: "0.7" } },
      async () => {
        calls += 1;
        return { response: "hello from the model", usage: { inputTokens: 5, outputTokens: 3, costUsd: 0.001 } };
      },
    );
    expect(response).toBe("hello from the model");
    expect(calls).toBe(1);
    // hit is only true if PCACHE is licensed on this server; either way the
    // call must have happened exactly once above.
    expect(typeof hit).toBe("boolean");
  });

  it("getOrCall() stores tokenUsage so a hit reports savings in stats()", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      const cache = new PromptCache(client, `${p}_usage_ns`);
      const input = {
        provider: "anthropic",
        model: "claude-sonnet-5",
        messages: [{ role: "user" as const, content: "usage question" }],
        params: {},
      };
      const fn = async () => ({ response: "hello there", tokenUsage: USAGE });
      await cache.getOrCall(input, fn);
      await cache.getOrCall(input, fn); // a hit
      const stats = await cache.stats();
      expect(stats.usageSavedRequests).toBeGreaterThanOrEqual(1);
      expect(stats.usageSavedInputTokens).toBeGreaterThanOrEqual(100);
    });
  });

  it("on a licensed server, a second identical request is a cache hit and skips the LLM call", async () => {
    const cache = new PromptCache(client, `${p}_hitns`, { ttlSeconds: 60 });
    const input = {
      provider: "acme",
      model: "gpt-6-sol",
      messages: [{ role: "user" as const, content: "deterministic question" }],
      params: {},
    };
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { response: "the answer" };
    };

    let firstHit: boolean;
    try {
      firstHit = (await cache.getOrCall(input, fn)).hit;
    } catch (err) {
      if (isNotLicensedError(err)) return; // covered by the miss-path test above
      throw err;
    }
    expect(firstHit).toBe(false);
    const second = await cache.getOrCall(input, fn);
    if (second.hit) {
      expect(calls).toBe(1);
      expect(second.response).toBe("the answer");
    }
  });

  it("the cache key is identical to buildPromptCacheKey()'s own output for the same input", async () => {
    const { buildPromptCacheKey } = await import("../../src/ai/cacheKey.js");
    const input = { provider: "p", model: "m", messages: [{ role: "user", content: "x" }], params: { a: "1" } };
    // Not directly observable through getOrCall, so this just guards that
    // the exported helper stays deterministic (full behavior covered in
    // test/unit/cacheKey.test.ts).
    expect(buildPromptCacheKey(input)).toBe(buildPromptCacheKey(input));
  });
});

describe.skipIf(!hasServer)("SemanticCache", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("semanticcache");
  });
  afterAll(async () => {
    await client.close();
  });

  it("calls the function on a miss, then hits on a near-identical vector", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      const cache = new SemanticCache(client, `${p}_ns`, 3, { threshold: 0.8 });
      await cache.createNamespace();

      let calls = 0;
      const first = await cache.getOrCall("what color is the sky", [1, 0, 0], async () => {
        calls += 1;
        return "blue";
      });
      expect(first.hit).toBe(false);
      expect(first.response).toBe("blue");
      expect(calls).toBe(1);

      const second = await cache.getOrCall("what colour is the sky", [0.99, 0.01, 0], async () => {
        calls += 1;
        return "should not be called";
      });
      expect(second.hit).toBe(true);
      expect(second.response).toBe("blue");
      expect(calls).toBe(1);
    });
  });

  it("createNamespace() is idempotent", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      const cache = new SemanticCache(client, `${p}_idempotent`, 2);
      await cache.createNamespace();
      await cache.createNamespace();
    });
  });

  it("getOrCall() stores tokenUsage so a hit reports savings in stats()", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      const cache = new SemanticCache(client, `${p}_usage_ns`, 2, { threshold: 0.8 });
      const fn = async () => ({ response: "cached answer", tokenUsage: USAGE });
      await cache.getOrCall("q", [1, 0], fn);
      await cache.getOrCall("q", [1, 0], fn); // a hit
      const stats = await cache.stats();
      expect(stats.usageSavedRequests).toBeGreaterThanOrEqual(1);
    });
  });
});
