// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import type { TokenUsage } from "../../src/usage.js";
import { hasServer, makeClient, runOrSkipIfNotLicensed, uniquePrefix } from "./helpers.js";

const USAGE: TokenUsage = { model: "claude-sonnet-5", inputTokens: 100, outputTokens: 20 };

describe.skipIf(!hasServer)("SCACHE.* (semantic cache)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("scache");
  });
  afterAll(async () => {
    await client.close();
  });

  it("CREATE / SET / GET above threshold / STATS / LIST / THRESHOLD / FLUSH / DROP", async (ctx) => {
    const ns = `${p}_ns`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.scacheCreate(ns, 3, { threshold: 0.5 });
      expect(await client.scacheList()).toContain(ns);

      await client.scacheSet(ns, "what color is the sky", "blue", [1, 0, 0]);
      const hit = await client.scacheGet(ns, [1, 0, 0]);
      expect(hit?.response).toBe("blue");
      expect(hit?.similarity).toBeGreaterThan(0.9);

      const miss = await client.scacheGet(ns, [0, 0, 1], 0.99);
      expect(miss).toBeNull();

      const stats = await client.scacheStats(ns);
      expect(stats.entries).toBeGreaterThanOrEqual(1);

      await client.scacheThreshold(ns, 0.9);
      expect(await client.scacheFlush(ns)).toBe(true);
      expect(await client.scacheDrop(ns)).toBe(true);
    });
  });

  it("SET with usage attributes savings on a hit", async (ctx) => {
    const ns = `${p}_usage_ns`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.scacheCreate(ns, 3, { threshold: 0.5 });
      await client.scacheSet(ns, "what color is the sky", "blue", [1, 0, 0], undefined, USAGE);
      await client.scacheGet(ns, [1, 0, 0]);
      const stats = await client.scacheStats(ns);
      expect(stats.usageSavedRequests).toBeGreaterThanOrEqual(1);
      expect(stats.usageSavedInputTokens).toBeGreaterThanOrEqual(100);
      await client.scacheDrop(ns);
    });
  });
});

describe.skipIf(!hasServer)("PCACHE.* (prompt cache, full license only)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("pcache");
  });
  afterAll(async () => {
    await client.close();
  });

  it("CREATE / SET / GET / GETEX / STATS / CONFIG / LIST / DEL / FLUSH / DROP", async (ctx) => {
    const ns = `${p}_ns`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.pcacheCreate(ns, { maxEntries: 100, ttlSeconds: 60, costPerHitUsd: 0.002 });
      await client.pcacheSet(ns, "prompt-1", "response-1");
      expect(await client.pcacheGet(ns, "prompt-1")).toBe("response-1");
      const getEx = await client.pcacheGetEx(ns, "prompt-1");
      expect(getEx?.response).toBe("response-1");
      const stats = await client.pcacheStats(ns);
      expect(stats.entries).toBeGreaterThanOrEqual(1);
      await client.pcacheConfigSet(ns, "TTL", 120);
      expect(await client.pcacheList()).toContain(ns);
      expect(await client.pcacheDel(ns, "prompt-1")).toBe(true);
      await client.pcacheFlush(ns);
      expect(await client.pcacheDrop(ns)).toBe(true);
    });
  });

  it("SET with usage attributes savings on a hit", async (ctx) => {
    const ns = `${p}_usage_ns`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.pcacheCreate(ns);
      await client.pcacheSet(ns, "prompt-1", "response-1", { usage: USAGE });
      expect(await client.pcacheGet(ns, "prompt-1")).toBe("response-1");
      const stats = await client.pcacheStats(ns);
      expect(stats.usageSavedRequests).toBeGreaterThanOrEqual(1);
      expect(stats.usageSavedInputTokens).toBeGreaterThanOrEqual(100);
      expect(stats.usageSavedOutputTokens).toBeGreaterThanOrEqual(20);
      await client.pcacheDrop(ns);
    });
  });
});

describe.skipIf(!hasServer)("keyed AI caches: TOOL.CACHE / NCACHE / GUARD / RERANK (full license only)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("keyedcache");
  });
  afterAll(async () => {
    await client.close();
  });

  const families: Array<{
    name: string;
    create: (ns: string) => Promise<void>;
    set: (ns: string, key: string, value: string, usage?: TokenUsage) => Promise<void>;
    get: (ns: string, key: string) => Promise<string | null>;
    stats: (ns: string) => Promise<{ entries: number; usageSavedRequests: number; usageSavedInputTokens: number }>;
    list: () => Promise<string[]>;
    del: (ns: string, key: string) => Promise<boolean>;
    drop: (ns: string) => Promise<boolean>;
    flush: (ns: string) => Promise<number>;
  }> = [];

  beforeAll(() => {
    families.push(
      {
        name: "TOOL.CACHE",
        create: (ns) => client.toolCacheCreate(ns),
        set: (ns, k, v, usage) => client.toolCacheSet(ns, k, v, { usage }),
        get: (ns, k) => client.toolCacheGet(ns, k),
        stats: (ns) => client.toolCacheStats(ns),
        list: () => client.toolCacheList(),
        del: (ns, k) => client.toolCacheDel(ns, k),
        drop: (ns) => client.toolCacheDrop(ns),
        flush: (ns) => client.toolCacheFlush(ns),
      },
      {
        name: "NCACHE",
        create: (ns) => client.nCacheCreate(ns),
        set: (ns, k, v, usage) => client.nCacheSet(ns, k, v, { usage }),
        get: (ns, k) => client.nCacheGet(ns, k),
        stats: (ns) => client.nCacheStats(ns),
        list: () => client.nCacheList(),
        del: (ns, k) => client.nCacheDel(ns, k),
        drop: (ns) => client.nCacheDrop(ns),
        flush: (ns) => client.nCacheFlush(ns),
      },
      {
        name: "GUARD",
        create: (ns) => client.guardCreate(ns),
        set: (ns, k, v, usage) => client.guardSet(ns, k, v, { usage }),
        get: (ns, k) => client.guardGet(ns, k),
        stats: (ns) => client.guardStats(ns),
        list: () => client.guardList(),
        del: (ns, k) => client.guardDel(ns, k),
        drop: (ns) => client.guardDrop(ns),
        flush: (ns) => client.guardFlush(ns),
      },
      {
        name: "RERANK",
        create: (ns) => client.rerankCreate(ns),
        set: (ns, k, v, usage) => client.rerankSet(ns, k, v, { usage }),
        get: (ns, k) => client.rerankGet(ns, k),
        stats: (ns) => client.rerankStats(ns),
        list: () => client.rerankList(),
        del: (ns, k) => client.rerankDel(ns, k),
        drop: (ns) => client.rerankDrop(ns),
        flush: (ns) => client.rerankFlush(ns),
      },
    );
  });

  for (const name of ["TOOL.CACHE", "NCACHE", "GUARD", "RERANK"]) {
    it(`${name}.CREATE/SET/GET/STATS/LIST/DEL/DROP`, async (ctx) => {
      const family = families.find((f) => f.name === name);
      if (!family) throw new Error(`missing family fixture for ${name}`);
      const ns = `${p}_${name.replace(".", "_")}`;
      await runOrSkipIfNotLicensed(ctx, async () => {
        await family.create(ns);
        await family.set(ns, "k1", "v1", USAGE);
        expect(await family.get(ns, "k1")).toBe("v1");
        const stats = await family.stats(ns);
        expect(stats.entries).toBeGreaterThanOrEqual(1);
        expect(stats.usageSavedRequests).toBeGreaterThanOrEqual(1);
        expect(stats.usageSavedInputTokens).toBeGreaterThanOrEqual(100);
        expect(await family.list()).toContain(ns);
        await family.set(ns, "k2", "v2");
        expect(await family.flush(ns)).toBeGreaterThanOrEqual(2);
        expect(await family.get(ns, "k1")).toBeNull();
        expect(await family.get(ns, "k2")).toBeNull();
        await family.set(ns, "k1", "v1");
        expect(await family.del(ns, "k1")).toBe(true);
        expect(await family.del(ns, "k1")).toBe(false);
        expect(await family.drop(ns)).toBe(true);
      });
    });
  }
});

describe.skipIf(!hasServer)("LLMSTATS.* (full license only)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("llmstats");
  });
  afterAll(async () => {
    await client.close();
  });

  it("BUCKET / RECORD / GET / RESET / DROP / LIST", async (ctx) => {
    const bucket = `${p}_bucket`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.llmStatsBucket(bucket);
      await client.llmStatsRecord(bucket, 100, 50, 0, 0.01, 250);
      const snapshot = await client.llmStatsGet(bucket);
      expect(snapshot.requests).toBeGreaterThanOrEqual(1);
      expect(typeof snapshot.cacheWrite5mTokens).toBe("number");
      expect(typeof snapshot.unpricedRequests).toBe("number");
      expect(await client.llmStatsList()).toContain(bucket);
      expect(await client.llmStatsReset(bucket)).toBe(true);
      expect(await client.llmStatsDrop(bucket)).toBe(true);
    });
  });

  it("RECORD with model is priced by the server", async (ctx) => {
    const bucket = `${p}_priced_bucket`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.llmStatsBucket(bucket);
      await client.llmStatsRecord(bucket, 1_000_000, 0, 0, 0, 10.0, { model: "claude-sonnet-5" });
      const snapshot = await client.llmStatsGet(bucket);
      expect(snapshot.requests).toBe(1);
      expect(snapshot.costUsd).toBeGreaterThanOrEqual(0);
      await client.llmStatsDrop(bucket);
    });
  });

  it("PRICE SET / GET / LIST / DEL", async (ctx) => {
    const model = `${p}_custom_model`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.llmStatsPriceSet(model, 3, 15, { cacheReadUsdPerMtok: 0.3 });
      const price = await client.llmStatsPriceGet(model);
      expect(price.model).toBe(model);
      expect(price.source).toBe("custom");
      expect(price.priced).toBe(true);
      expect(price.inputUsdPerMtok).toBe(3);
      expect(price.outputUsdPerMtok).toBe(15);
      expect(price.cacheReadUsdPerMtok).toBe(0.3);
      // Omitted cache-write tiers default to 1.25x/2x the input price.
      expect(price.cacheWrite5mUsdPerMtok).toBe(3.75);
      expect(price.cacheWrite1hUsdPerMtok).toBe(6);

      const allPrices = await client.llmStatsPriceList();
      expect(allPrices.some((p2) => p2.model === model)).toBe(true);

      const unknown = await client.llmStatsPriceGet(`${p}_no_such_model_at_all`);
      expect(unknown.source).toBe("unpriced");
      expect(unknown.priced).toBe(false);

      expect(await client.llmStatsPriceDel(model)).toBe(true);
      expect(await client.llmStatsPriceDel(model)).toBe(false);
    });
  });
});

describe.skipIf(!hasServer)("LLMBUDGET.* (full license only)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("llmbudget");
  });
  afterAll(async () => {
    await client.close();
  });

  it("SET / CONSUME / STATUS / RESET / DROP / LIST", async (ctx) => {
    const name = `${p}_budget`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.llmBudgetSet(name, 1000, 1.0, 3600);
      expect(await client.llmBudgetConsume(name, 100, 0.05)).toBe(true);
      const status = await client.llmBudgetStatus(name);
      expect(status.tokenLimit).toBe(1000);
      expect(typeof status.unpricedRequests).toBe("number");
      expect(await client.llmBudgetList()).toContain(name);
      expect(await client.llmBudgetReset(name)).toBe(true);
      expect(await client.llmBudgetDrop(name)).toBe(true);
    });
  });

  it("CONSUME with usage is priced by the server", async (ctx) => {
    const name = `${p}_usage_budget`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.llmBudgetSet(name, 1_000_000, 100.0, 3600);
      expect(await client.llmBudgetConsume(name, undefined, undefined, USAGE)).toBe(true);
      const status = await client.llmBudgetStatus(name);
      expect(status.tokensUsed).toBeGreaterThanOrEqual(100);
      await client.llmBudgetDrop(name);
    });
  });
});

describe.skipIf(!hasServer)("PROMPT.* (versioned prompt registry, full license only)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("prompt");
  });
  afterAll(async () => {
    await client.close();
  });

  it("PUT / GET / LATEST / SETACTIVE / VERSIONS / LIST / DROP", async (ctx) => {
    const name = `${p}_template`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      const v1 = await client.promptPut(name, "Hello {{name}}");
      expect(v1).toBe(1);
      const v2 = await client.promptPut(name, "Hi {{name}}!");
      expect(v2).toBe(2);

      const latest = await client.promptLatest(name);
      expect(latest?.version).toBe(2);

      const first = await client.promptGet(name, 1);
      expect(first?.content).toBe("Hello {{name}}");

      await client.promptSetActive(name, 1);
      expect(await client.promptVersions(name)).toEqual([1, 2]);
      expect(await client.promptList()).toContain(name);
      expect(await client.promptDrop(name)).toBe(true);
    });
  });
});

describe.skipIf(!hasServer)("EMBED.DEDUP.* (full license only)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("embeddedup");
  });
  afterAll(async () => {
    await client.close();
  });

  it("PUT / GET / RELEASE / STATS / PURGE / DROP / LIST", async (ctx) => {
    const ns = `${p}_ns`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      const hash = "deadbeef";
      expect(await client.embedDedupPut(ns, hash, "text-embedding-3", "0.1,0.2,0.3")).toBe(true);
      expect(await client.embedDedupPut(ns, hash, "text-embedding-3", "0.1,0.2,0.3")).toBe(false);
      expect(await client.embedDedupGet(ns, hash)).toBe("0.1,0.2,0.3");
      const stats = await client.embedDedupStats(ns);
      expect(stats.entries).toBeGreaterThanOrEqual(1);
      expect(await client.embedDedupList()).toContain(ns);
      expect(await client.embedDedupRelease(ns, hash)).toBe(true);
      await client.embedDedupPurge(ns);
      expect(await client.embedDedupDrop(ns)).toBe(true);
    });
  });
});
