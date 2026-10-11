// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Floating-point arguments against a live server: tiny and huge values that
// JavaScript prints in exponent form (1e-7, 1e+21) are sent as plain decimal
// text and read back. The licensed commands skip themselves on NOLICENSE.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { ReplyError } from "../../src/errors.js";
import { hasServer, isCluster, makeClient, runOrSkipIfNotLicensed, uniquePrefix } from "./helpers.js";

describe.skipIf(!hasServer)("float arguments on the wire", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("floats");
  });
  afterAll(async () => {
    await client.close();
  });

  it("ZADD, ZSCORE, ZRANGEBYSCORE with tiny, huge and infinite scores", async () => {
    const key = `${p}:z`;
    await client.zAdd(key, [
      ["tiny", 1e-7],
      ["huge", 1e21],
      ["neg", -2.5e-9],
      ["ninf", -Infinity],
      ["pinf", Infinity],
    ]);
    expect(Number(await client.zScore(key, "tiny"))).toBe(1e-7);
    expect(Number(await client.zScore(key, "huge"))).toBe(1e21);
    expect(Number(await client.zScore(key, "neg"))).toBe(-2.5e-9);
    // Some servers print "inf"; this server prints "Infinity" (checked case-insensitively).
    expect(await client.zScore(key, "pinf")).toMatch(/^inf(inity)?$/i);
    expect(await client.zScore(key, "ninf")).toMatch(/^-inf(inity)?$/i);
    expect(await client.zRangeByScore(key, 1e-8, 1e-6)).toEqual(["tiny"]);
    expect(await client.zRangeByScore(key, -Infinity, 0)).toEqual(["ninf", "neg"]);
    expect(await client.zCount(key, 1e-7, Infinity)).toBe(3);
    expect(Number(await client.zIncrBy(key, 1e-7, "tiny"))).toBeCloseTo(2e-7, 15);
    await client.del(key);
  });

  it("INCRBYFLOAT and HINCRBYFLOAT with tiny and huge increments", async () => {
    const key = `${p}:f`;
    expect(Number(await client.incrByFloat(key, 1e-7))).toBeCloseTo(1e-7, 20);
    expect(Number(await client.incrByFloat(key, 1e21))).toBe(1e21);
    const hash = `${p}:h`;
    expect(Number(await client.hIncrByFloat(hash, "f", 2.5e-8))).toBeCloseTo(2.5e-8, 20);
    await client.del(key, hash);
  });

  it("GEOADD and GEOSEARCH with coordinates and radius that print in exponent form", async () => {
    const key = `${p}:geo`;
    expect(await client.geoAdd(key, [{ longitude: 1e-7, latitude: -2.5e-8, member: "origin" }])).toBe(1);
    const found = await client.geoSearch(key, { fromLonLat: [0, 0], byRadius: { radius: 1e-3, unit: "km" } });
    expect(found.map((r) => r.member)).toEqual(["origin"]);
    await client.del(key);
  });

  it("VSIM vectors with components that print in exponent form", async () => {
    const index = `${p}:vix`;
    await client.vsimCreateIndex(index, 3);
    expect(await client.vsimSet(index, "a", [1e-7, 1, -2.5e-9])).toBe(true);
    const back = await client.vsimGet(index, "a");
    expect(back?.[1]).toBeCloseTo(1, 6);
    expect(Math.abs(back?.[0] ?? 1)).toBeLessThan(1e-6);
    // Below the 32-bit float range the component is flushed to 0, not refused.
    expect(await client.vsimSet(index, "b", [1e-50, 1, 0])).toBe(true);
    const hits = await client.vsimSearch(index, 2, [1e-7, 1, 0]);
    expect(hits.length).toBe(2);
    await client.vsimDropIndex(index);
  });

  it("the client refuses NaN and infinities before sending where the server cannot take them", async () => {
    await expect(client.incrByFloat(`${p}:x`, Number.NaN)).rejects.toThrow(RangeError);
    await expect(client.incrByFloat(`${p}:x`, Infinity)).rejects.toThrow(RangeError);
    await expect(client.zAdd(`${p}:x`, [["m", Number.NaN]])).rejects.toThrow(RangeError);
    await expect(client.set(`${p}:x`, Number.NaN as unknown as string)).rejects.toThrow(RangeError);
  });

  it("LLMBUDGET.SET: a tiny cost limit is sent as a fixed-point dollar amount", async (ctx) => {
    const name = `${p}_tinybudget`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      // The server refuses the exponent form that String(1e-5) produces.
      await expect(client.execute(["LLMBUDGET.SET", name, "100", "1e-5", "60"])).rejects.toBeInstanceOf(ReplyError);
      // And a seventh decimal.
      await expect(client.execute(["LLMBUDGET.SET", name, "100", "0.0000001", "60"])).rejects.toBeInstanceOf(ReplyError);

      await client.llmBudgetSet(name, 100, 1e-5, 60);
      expect((await client.llmBudgetStatus(name)).costLimitUsd).toBeCloseTo(1e-5, 9);
      await client.llmBudgetSet(name, 100, 0.000001, 60);
      expect((await client.llmBudgetStatus(name)).costLimitUsd).toBeCloseTo(1e-6, 9);
      await client.llmBudgetSet(name, 100, 1e-7, 60); // rounds to 0: no cost cap
      expect((await client.llmBudgetStatus(name)).costLimitUsd).toBe(0);
      await client.llmBudgetSet(name, 100, 12345678.123456, 60);
      expect((await client.llmBudgetStatus(name)).costLimitUsd).toBeCloseTo(12345678.123456, 5);
      expect(await client.llmBudgetConsume(name, 1, 1e-7)).toBe(true);
      await client.llmBudgetDrop(name);
    });
  });

  it("LLMSTATS.PRICE SET with a tiny price", async (ctx) => {
    const model = `${p}-tiny-model`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.llmStatsPriceSet(model, 1e-5, 2e-6);
      const price = await client.llmStatsPriceGet(model);
      expect(price.inputUsdPerMtok).toBeCloseTo(1e-5, 9);
      expect(price.outputUsdPerMtok).toBeCloseTo(2e-6, 9);
      await client.llmStatsPriceDel(model);
    });
  });

  it("SCACHE threshold and PCACHE cost per hit that print in exponent form", async (ctx) => {
    const sc = `${p}_sc`;
    const pc = `${p}_pc`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.scacheCreate(sc, 2, { threshold: 1e-7 });
      await client.scacheThreshold(sc, 5e-8);
      await client.scacheSet(sc, "q", "r", [1e-7, 1]);
      expect(await client.scacheGet(sc, [1e-7, 1], 1e-7)).not.toBeNull();
      await client.scacheDrop(sc);
      await client.pcacheCreate(pc, { costPerHitUsd: 1e-7 });
      await client.pcacheDrop(pc);
    });
  });

  it("RATELIMIT.CREATE with a fractional refill rate", async (ctx) => {
    const name = `${p}_rl`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.rateLimitCreate(name, 10, 1000, { algo: "token_bucket", refill: 1e-3 });
      expect((await client.rateLimitCheck(name, "k")).allowed).toBe(true);
      await client.rateLimitDrop(name);
    });
  });

  it.skipIf(isCluster)("SCACHE.SET and PCACHE.SET with an absolute PXAT expiry", async (ctx) => {
    const sc = `${p}_scx`;
    const pc = `${p}_pcx`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      const later = Date.now() + 3_600_000;
      await client.scacheCreate(sc, 2);
      await client.scacheSet(sc, "q", "r", [1, 0], { pxat: later });
      expect((await client.scacheGet(sc, [1, 0]))?.response).toBe("r");
      // An expiry in the past stores nothing.
      await client.scacheSet(sc, "old", "gone", [0, 1], { pxat: Date.now() - 1000 });
      expect(await client.scacheGet(sc, [0, 1])).toBeNull();
      await client.scacheDrop(sc);

      await client.pcacheCreate(pc);
      await client.pcacheSet(pc, "p", "answer", { pxat: later });
      expect(await client.pcacheGet(pc, "p")).toBe("answer");
      await client.pcacheSet(pc, "p2", "gone", { pxat: Date.now() - 1000 });
      expect(await client.pcacheGet(pc, "p2")).toBeNull();
      await client.pcacheDrop(pc);
    });
  });
});
