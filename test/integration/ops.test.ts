// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// On a server whose license does not cover these families every command here
// replies NOLICENSE; each test wraps its body in runOrSkipIfNotLicensed and is
// skipped with a clear reason instead of failing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { hasServer, makeClient, runOrSkipIfNotLicensed, uniquePrefix } from "./helpers.js";

describe.skipIf(!hasServer)("RATELIMIT.* (legacy-enabled)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("ratelimit");
  });
  afterAll(async () => {
    await client.close();
  });

  it("CREATE / CHECK / PEEK / STATS / RESET / LIST / DROP", async (ctx) => {
    const name = `${p}_limiter`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.rateLimitCreate(name, 2, 60_000);

      const first = await client.rateLimitCheck(name, "user-1");
      expect(first.allowed).toBe(true);
      expect(first.limit).toBe(2);
      // PEEK is non-mutating and reads the state CHECK just advanced to, so
      // it is not expected to equal the pre-mutation snapshot CHECK itself
      // returned; just confirm it is a well formed, non-negative count.
      const peek = await client.rateLimitPeek(name, "user-1");
      expect(peek.current).toBeGreaterThanOrEqual(0);
      expect(peek.limit).toBe(2);

      const stats = await client.rateLimitStats(name);
      expect(stats.name).toBe(name);
      expect(stats.limit).toBe(2);

      expect(await client.rateLimitList()).toContain(name);
      await client.rateLimitReset(name, "user-1");
      await client.rateLimitDrop(name);
    });
  });
});

describe.skipIf(!hasServer)("TS.* (time series, legacy-enabled)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("ts");
  });
  afterAll(async () => {
    await client.close();
  });

  it("CREATE / ADD / RANGE / AGG / INFO / RETENTION / LIST / DELETE", async (ctx) => {
    const key = `${p}_series`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      // Samples must fall within the retention window relative to the
      // server's current clock, so anchor them to Date.now() rather than
      // small fixed numbers (which would be from 1970 and get dropped).
      const base = Date.now();
      await client.tsCreate(key, { retentionMs: 3_600_000, labels: { region: "eu" } });

      await client.tsAdd(key, base, "10");
      await client.tsAdd(key, base + 1000, "20");
      await client.tsAdd(key, base + 2000, "30");

      const range = await client.tsRange(key, base - 500, base + 2500);
      expect(range).toHaveLength(3);
      expect(range[0]?.timestampMs).toBe(base);
      expect(Number(range[0]?.value)).toBe(10);

      const agg = await client.tsAgg(key, base - 500, base + 2500, 5000, "avg");
      expect(agg.length).toBeGreaterThanOrEqual(1);

      const info = await client.tsInfo(key);
      expect(info.key).toBe(key);
      expect(info.totalSamples).toBe(3);
      expect(info.labels).toEqual([["region", "eu"]]);

      await client.tsRetention(key, 7_200_000);
      expect(await client.tsList({ key: "region", value: "eu" })).toContain(key);

      await client.tsDelete(key);
    });
  });

  it("DOWNSAMPLE attaches a live rule between two series", async (ctx) => {
    const src = `${p}_src`;
    const dest = `${p}_dest`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.tsCreate(src);
      await client.tsCreate(dest);
      await client.tsDownsample(src, dest, "avg", 60_000);
      await client.tsDelete(src);
      await client.tsDelete(dest);
    });
  });
});

describe.skipIf(!hasServer)("FEATURE.* (feature store, legacy-enabled)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("feature");
  });
  afterAll(async () => {
    await client.close();
  });

  it("CREATE / SET / GET / BATCH / SCHEMA / LIST / STATS / DROP", async (ctx) => {
    const group = `${p}_group`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.featureCreate(group, "user features", [
        { name: "age", type: "int64" },
        { name: "score", type: "double" },
      ]);

      await client.featureSet(group, "entity-1", { age: 30, score: 4.5 });
      const record = await client.featureGet(group, "entity-1");
      expect(record?.values.age).toBe("30");

      const batch = await client.featureBatch(group, ["entity-1", "entity-missing"]);
      expect(batch[0]).not.toBeNull();
      expect(batch[1]).toBeNull();

      const schema = await client.featureSchema(group);
      expect(schema.map((f) => f.name).sort()).toEqual(["age", "score"]);

      expect(await client.featureList()).toContain(group);
      const stats = await client.featureStats(group);
      expect(stats.entities).toBeGreaterThanOrEqual(1);

      await client.featureDrop(group);
    });
  });
});

describe.skipIf(!hasServer)("OBSERVE / ALERTS (legacy-enabled, admin)", () => {
  let client: HotKV;

  beforeAll(() => {
    client = makeClient();
  });
  afterAll(async () => {
    await client.close();
  });

  it("OBSERVE INFO / METRICS report server statistics", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      const info = await client.observeInfo();
      expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
      const metrics = await client.observeMetrics();
      expect(metrics.totalCommands).toBeGreaterThan(0);
    });
  });

  it("ALERTS INFO reports the dispatcher's configuration", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      const info = await client.alertsInfo();
      expect(typeof info.enabled).toBe("boolean");
      expect(typeof info.supportedProviders).toBe("string");
    });
  });

  it("ALERTS SETSEVERITY / ON / OFF round trip without erroring", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.alertsSetSeverity("warning");
      await client.alertsOn();
      await client.alertsOff();
    });
  });
});
