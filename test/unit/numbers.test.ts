// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Floating-point arguments leave the client as plain decimal text, never in
// exponent form ("1e-7", "1e+21"), because not every HotKV parser takes an
// exponent (LLMBUDGET.SET reads a fixed-point dollar amount with at most six
// decimals). Unit tests of the formatters and of the exact bytes the typed
// methods put on the wire. No server needed.

import { describe, expect, it } from "vitest";
import { formatFloat, formatNumberArg, formatScore, formatUsd, formatVectorComponent } from "../../src/internal/numbers.js";
import { encodeCommand } from "../../src/resp/writer.js";
import { keySlot } from "../../src/crc16.js";
import { ProtocolError } from "../../src/errors.js";
import { makeRecordingClient as recordingClient, type RecordingClient } from "./helpers.js";

/**
 * A recording client whose methods ignore a ProtocolError from decoding the
 * canned (empty) reply: these tests only look at the arguments that were sent.
 */
function makeRecordingClient(): RecordingClient {
  const target = recordingClient();
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop) as unknown;
      if (typeof value !== "function" || prop === "execute" || prop === "when") return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => unknown).apply(t, args);
        } catch (err) {
          if (err instanceof ProtocolError) return undefined;
          throw err;
        }
      };
    },
  });
}

/** The bulk strings of an encoded command, as the server reads them. */
function wire(args: readonly (string | number | bigint | Buffer)[]): string[] {
  const buf = encodeCommand(args);
  const out: string[] = [];
  let at = 0;
  const lineEnd = () => buf.indexOf("\r\n", at);
  expect(buf[0]).toBe(0x2a);
  const count = Number(buf.subarray(1, lineEnd()).toString());
  at = lineEnd() + 2;
  for (let i = 0; i < count; i++) {
    const len = Number(buf.subarray(at + 1, lineEnd()).toString());
    at = lineEnd() + 2;
    out.push(buf.subarray(at, at + len).toString("utf8"));
    at += len + 2;
  }
  return out;
}

const SAMPLES = [
  0, 1, -1, 0.5, -0.5, 3, 1e-5, 1e-6, 1e-7, 1.5e-7, 1e-10, 1e-300, 5e-324, 123456.789e-12, 1e20, 1e21, 1.5e21, 1.2345e25,
  1e100, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, 0.1 + 0.2, 1 / 3, 2 ** 53, 2 ** 70, -1e-7, -1e22, Math.PI,
];

describe("formatFloat", () => {
  it("never prints an exponent and reads back as the same double", () => {
    for (const x of SAMPLES) {
      const text = formatFloat(x);
      expect(text, `${x}`).toMatch(/^-?\d+(\.\d+)?$/);
      expect(Number(text), `${x} -> ${text}`).toBe(x);
    }
  });

  it("tiny values", () => {
    expect(formatFloat(1e-5)).toBe("0.00001");
    expect(formatFloat(1e-7)).toBe("0.0000001");
    expect(formatFloat(1.5e-7)).toBe("0.00000015");
    expect(formatFloat(-2.5e-9)).toBe("-0.0000000025");
    expect(formatFloat(1e-300)).toBe(`0.${"0".repeat(299)}1`);
  });

  it("huge values", () => {
    expect(formatFloat(1e21)).toBe("1000000000000000000000");
    expect(formatFloat(1.5e21)).toBe("1500000000000000000000");
    expect(formatFloat(1.2345e25)).toBe("12345000000000000000000000");
    expect(formatFloat(-1e22)).toBe("-10000000000000000000000");
    expect(formatFloat(Number.MAX_VALUE)).toHaveLength(309);
  });

  it("integral and ordinary values", () => {
    expect(formatFloat(3)).toBe("3");
    expect(formatFloat(-3)).toBe("-3");
    expect(formatFloat(0.25)).toBe("0.25");
    expect(formatFloat(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(formatFloat(100)).toBe("100");
    expect(formatFloat(1e20)).toBe("100000000000000000000");
  });

  it("both zeros are 0", () => {
    expect(formatFloat(0)).toBe("0");
    expect(formatFloat(-0)).toBe("0");
  });

  it("refuses NaN and the infinities", () => {
    expect(() => formatFloat(Number.NaN)).toThrow(RangeError);
    expect(() => formatFloat(Infinity)).toThrow(RangeError);
    expect(() => formatFloat(-Infinity)).toThrow(RangeError);
    expect(() => formatFloat("1" as unknown as number)).toThrow(RangeError);
  });
});

describe("formatScore", () => {
  it("plain decimal for finite values, inf and -inf for the infinities, NaN refused", () => {
    expect(formatScore(1e-7)).toBe("0.0000001");
    expect(formatScore(1e21)).toBe("1000000000000000000000");
    expect(formatScore(-4.5)).toBe("-4.5");
    expect(formatScore(Infinity)).toBe("inf");
    expect(formatScore(-Infinity)).toBe("-inf");
    expect(() => formatScore(Number.NaN)).toThrow(RangeError);
  });
});

describe("formatVectorComponent", () => {
  it("plain decimal, refuses values outside the 32-bit float range, flushes underflow to 0", () => {
    expect(formatVectorComponent(0.25)).toBe("0.25");
    expect(formatVectorComponent(1e-7)).toBe("0.0000001");
    expect(formatVectorComponent(1e-50)).toBe("0");
    expect(formatVectorComponent(3e38)).toBe("300000000000000000000000000000000000000");
    expect(() => formatVectorComponent(1e39)).toThrow(RangeError);
    expect(() => formatVectorComponent(Number.NaN)).toThrow(RangeError);
    expect(() => formatVectorComponent(Infinity)).toThrow(RangeError);
  });
});

describe("formatUsd", () => {
  it("plain decimal with at most six decimals, trailing zeros dropped", () => {
    expect(formatUsd(0)).toBe("0");
    expect(formatUsd(-0)).toBe("0");
    expect(formatUsd(5)).toBe("5");
    expect(formatUsd(1.5)).toBe("1.5");
    expect(formatUsd(0.000001)).toBe("0.000001");
    expect(formatUsd(1e-6)).toBe("0.000001");
    expect(formatUsd(0.1 + 0.2)).toBe("0.3");
    expect(formatUsd(12.345678)).toBe("12.345678");
  });

  it("rounds half up on the decimal digits", () => {
    expect(formatUsd(5e-7)).toBe("0.000001");
    expect(formatUsd(4e-7)).toBe("0");
    expect(formatUsd(1e-5)).toBe("0.00001");
    expect(formatUsd(1e-7)).toBe("0");
    expect(formatUsd(0.9999995)).toBe("1");
    expect(formatUsd(1.0000005)).toBe("1.000001");
    expect(formatUsd(9.9999996)).toBe("10");
    expect(formatUsd(1e-300)).toBe("0");
  });

  it("huge amounts up to what 64 bits of micro-dollars hold", () => {
    expect(formatUsd(1e12)).toBe("1000000000000");
    expect(formatUsd(1.8e13)).toBe("18000000000000");
    expect(() => formatUsd(1e14)).toThrow(RangeError);
    expect(() => formatUsd(1e21)).toThrow(RangeError);
    expect(() => formatUsd(Number.MAX_VALUE)).toThrow(RangeError);
  });

  it("refuses negative, NaN and infinite amounts", () => {
    expect(() => formatUsd(-0.01)).toThrow(RangeError);
    expect(() => formatUsd(Number.NaN)).toThrow(RangeError);
    expect(() => formatUsd(Infinity)).toThrow(RangeError);
  });

  it("checks a string and passes it through unchanged", () => {
    expect(formatUsd("3.50")).toBe("3.50");
    expect(formatUsd("0.000001")).toBe("0.000001");
    for (const bad of ["1e-5", "-1", "+1", ".5", "5.", "1.1234567", " 1", "1 ", "", "abc", "1,5"]) {
      expect(() => formatUsd(bad), bad).toThrow(RangeError);
    }
  });
});

describe("formatNumberArg", () => {
  it("integers stay integers, floats are plain decimal, infinities are inf, NaN is refused", () => {
    expect(formatNumberArg(42)).toBe("42");
    expect(formatNumberArg(-7)).toBe("-7");
    expect(formatNumberArg(0)).toBe("0");
    expect(formatNumberArg(-0)).toBe("0");
    expect(formatNumberArg(2 ** 53)).toBe("9007199254740992");
    expect(formatNumberArg(1e21)).toBe("1000000000000000000000");
    expect(formatNumberArg(1e-7)).toBe("0.0000001");
    expect(formatNumberArg(Infinity)).toBe("inf");
    expect(formatNumberArg(-Infinity)).toBe("-inf");
    expect(() => formatNumberArg(Number.NaN)).toThrow(RangeError);
  });
});

describe("the writer", () => {
  it("encodes number arguments as plain decimal text", () => {
    expect(wire(["ZADD", "z", 1e-7, "a", 1e21, "b", -Infinity, "c", Infinity, "d"])).toEqual([
      "ZADD", "z", "0.0000001", "a", "1000000000000000000000", "b", "-inf", "c", "inf", "d",
    ]);
    expect(wire(["SET", "k", 5, 10n, Buffer.from([0xff, 0x00])]).slice(0, 4)).toEqual(["SET", "k", "5", "10"]);
  });

  it("refuses NaN", () => {
    expect(() => encodeCommand(["SET", "k", Number.NaN])).toThrow(RangeError);
  });

  it("a numeric key hashes to the slot of the text the writer sends", () => {
    expect(keySlot(1e21)).toBe(keySlot("1000000000000000000000"));
    expect(keySlot(1e-7)).toBe(keySlot("0.0000001"));
  });
});

describe("typed commands put plain decimals on the wire", () => {
  it("LLMBUDGET.SET: the cost limit is a fixed-point dollar amount", async () => {
    const client = makeRecordingClient();
    await client.llmBudgetSet("b", 1000, 1e-5, 60);
    expect(wire(client.lastCall)).toEqual(["LLMBUDGET.SET", "b", "1000", "0.00001", "60"]);
    await client.llmBudgetSet("b", 1000, 0.000001, 60);
    expect(wire(client.lastCall)).toEqual(["LLMBUDGET.SET", "b", "1000", "0.000001", "60"]);
    await client.llmBudgetSet("b", 0, 25, 3600);
    expect(wire(client.lastCall)).toEqual(["LLMBUDGET.SET", "b", "0", "25", "3600"]);
    await client.llmBudgetSet("b", 1, 2.5e-9, 60);
    expect(wire(client.lastCall)[3]).toBe("0");
    await expect(client.llmBudgetSet("b", 1, -1, 60)).rejects.toThrow(RangeError);
    await expect(client.llmBudgetSet("b", 1, Number.NaN, 60)).rejects.toThrow(RangeError);
    await expect(client.llmBudgetSet("b", 1, 1e30, 60)).rejects.toThrow(RangeError);
  });

  it("LLMBUDGET.CONSUME and LLMSTATS.RECORD cost", async () => {
    const client = makeRecordingClient();
    await client.llmBudgetConsume("b", 10, 1e-7);
    expect(wire(client.lastCall)).toEqual(["LLMBUDGET.CONSUME", "b", "10", "0.0000001"]);
    await client.llmStatsRecord("bk", 1, 2, 3, 2.5e-6, 12.7);
    expect(wire(client.lastCall)).toEqual(["LLMSTATS.RECORD", "bk", "1", "2", "3", "0.0000025", "13"]);
    await expect(client.llmBudgetConsume("b", 1, Infinity)).rejects.toThrow(RangeError);
  });

  it("LLMSTATS.PRICE SET: prices are dollar amounts with at most six decimals", async () => {
    const client = makeRecordingClient();
    await client.llmStatsPriceSet("m", 1e-5, 15, { cacheReadUsdPerMtok: 0.3 });
    expect(wire(client.lastCall)).toEqual(["LLMSTATS.PRICE", "SET", "m", "INPUT", "0.00001", "OUTPUT", "15", "CACHEREAD", "0.3"]);
    await expect(client.llmStatsPriceSet("m", "1e-5", 15)).rejects.toThrow(RangeError);
  });

  it("SCACHE and PCACHE thresholds and costs", async () => {
    const client = makeRecordingClient();
    await client.scacheCreate("ns", 4, { threshold: 1e-7 });
    expect(wire(client.lastCall)).toEqual(["SCACHE.CREATE", "ns", "4", "THRESHOLD", "0.0000001"]);
    await client.scacheGet("ns", [1e-7, 1], 0.85);
    expect(wire(client.lastCall)).toEqual(["SCACHE.GET", "ns", "0.0000001", "1", "THRESHOLD", "0.85"]);
    await client.scacheThreshold("ns", 5e-8);
    expect(wire(client.lastCall)).toEqual(["SCACHE.THRESHOLD", "ns", "0.00000005"]);
    await client.pcacheCreate("ns", { costPerHitUsd: 1e-6 });
    expect(wire(client.lastCall)).toEqual(["PCACHE.CREATE", "ns", "COST_PER_HIT", "0.000001"]);
    await expect(client.scacheThreshold("ns", Number.NaN)).rejects.toThrow(RangeError);
    await expect(client.scacheGet("ns", [Infinity], undefined)).rejects.toThrow(RangeError);
  });

  it("RATELIMIT.CREATE REFILL and DRAIN", async () => {
    const client = makeRecordingClient();
    await client.rateLimitCreate("rl", 10, 1000, { algo: "token_bucket", refill: 1e-3, drain: 2.5e-7 });
    expect(wire(client.lastCall)).toEqual([
      "RATELIMIT.CREATE", "rl", "10", "1000", "ALGO", "token_bucket", "REFILL", "0.001", "DRAIN", "0.00000025",
    ]);
  });

  it("vectors: VSIM, AMEM", async () => {
    const client = makeRecordingClient();
    await client.vsimSet("ix", "k", [1e-7, -2.5e-9, 0.5]);
    expect(wire(client.lastCall)).toEqual(["VSIM.SET", "ix", "k", "0.0000001", "-0.0000000025", "0.5"]);
    await client.vsimSearch("ix", 3, [1e-7, 1]);
    expect(wire(client.lastCall)).toEqual(["VSIM.SEARCH", "ix", "3", "0.0000001", "1"]);
    await client.amemSemStore("a", "k", "c", [1e-7, 1]);
    expect(wire(client.lastCall)).toEqual(["AMEM.SEM.STORE", "a", "k", "c", "0.0000001", "1"]);
  });

  it("ZADD scores, score ranges, ZINCRBY, weights", async () => {
    const client = makeRecordingClient();
    await client.zAdd("z", [["a", 1e-7], ["b", 1e21], ["c", -Infinity], ["d", "2.5"]]);
    expect(wire(client.lastCall)).toEqual(["ZADD", "z", "0.0000001", "a", "1000000000000000000000", "b", "-inf", "c", "2.5", "d"]);
    await client.zRangeByScore("z", -Infinity, 1e21, { withScores: true });
    expect(wire(client.lastCall)).toEqual(["ZRANGEBYSCORE", "z", "-inf", "1000000000000000000000", "WITHSCORES"]);
    await client.zCount("z", 1e-7, Infinity);
    expect(wire(client.lastCall)).toEqual(["ZCOUNT", "z", "0.0000001", "inf"]);
    await client.zIncrBy("z", 1e-7, "a");
    expect(wire(client.lastCall)).toEqual(["ZINCRBY", "z", "0.0000001", "a"]);
    await client.zUnionStore("d", ["a", "b"], { weights: [1e-7, 2] });
    expect(wire(client.lastCall)).toEqual(["ZUNIONSTORE", "d", "2", "a", "b", "WEIGHTS", "0.0000001", "2"]);
    // The recording executor does not encode; the writer refuses NaN.
    await client.zAdd("z", [["a", Number.NaN]]);
    expect(() => encodeCommand(client.lastCall)).toThrow(RangeError);
  });

  it("INCRBYFLOAT, HINCRBYFLOAT", async () => {
    const client = makeRecordingClient();
    await client.incrByFloat("k", 1e-7);
    expect(wire(client.lastCall)).toEqual(["INCRBYFLOAT", "k", "0.0000001"]);
    await client.incrByFloat("k", -1e21);
    expect(wire(client.lastCall)).toEqual(["INCRBYFLOAT", "k", "-1000000000000000000000"]);
    await client.hIncrByFloat("h", "f", 2.5e-8);
    expect(wire(client.lastCall)).toEqual(["HINCRBYFLOAT", "h", "f", "0.000000025"]);
    await expect(client.incrByFloat("k", Infinity)).rejects.toThrow(RangeError);
    await expect(client.incrByFloat("k", Number.NaN)).rejects.toThrow(RangeError);
  });

  it("GEOADD and GEOSEARCH", async () => {
    const client = makeRecordingClient();
    await client.geoAdd("g", [{ longitude: 1e-7, latitude: -2.5e-8, member: "m" }]);
    expect(wire(client.lastCall)).toEqual(["GEOADD", "g", "0.0000001", "-0.000000025", "m"]);
    await client.geoSearch("g", { fromLonLat: [1e-7, 2], byRadius: { radius: 1e-3, unit: "km" } });
    expect(wire(client.lastCall)).toEqual(["GEOSEARCH", "g", "FROMLONLAT", "0.0000001", "2", "BYRADIUS", "0.001", "km"]);
    await client.geoSearch("g", { fromMember: "m", byBox: { width: 1e-3, height: 2e21, unit: "m" } });
    expect(wire(client.lastCall)).toEqual([
      "GEOSEARCH", "g", "FROMMEMBER", "m", "BYBOX", "0.001", "2000000000000000000000", "m",
    ]);
  });

  it("TS.ADD and FEATURE.SET values", async () => {
    const client = makeRecordingClient();
    await client.tsAdd("ts", 1000, 1e-7);
    expect(wire(client.lastCall)).toEqual(["TS.ADD", "ts", "1000", "0.0000001"]);
    await client.featureSet("g", "e", { f: 2.5e-7 });
    expect(wire(client.lastCall)).toEqual(["FEATURE.SET", "g", "e", "f", "0.00000025"]);
  });
});

describe("PXAT", () => {
  it("SCACHE.SET, PCACHE.SET, keyed caches and AMEM take an absolute expiry", async () => {
    const client = makeRecordingClient();
    await client.scacheSet("ns", "q", "r", [1], { pxat: 1893456000000 });
    expect(wire(client.lastCall)).toEqual(["SCACHE.SET", "ns", "q", "r", "1", "PXAT", "1893456000000"]);
    await client.pcacheSet("ns", "p", "r", { pxat: 1893456000000, meta: "m" });
    expect(wire(client.lastCall)).toEqual(["PCACHE.SET", "ns", "p", "r", "PXAT", "1893456000000", "META", "m"]);
    await client.toolCacheSet("ns", "k", "v", { pxat: 1893456000000 });
    expect(wire(client.lastCall)).toEqual(["TOOL.CACHE.SET", "ns", "k", "v", "PXAT", "1893456000000"]);
    await client.amemConvCreate("s", { window: 5, pxat: 1893456000000 });
    expect(wire(client.lastCall)).toEqual(["AMEM.CONV.CREATE", "s", "WINDOW", "5", "PXAT", "1893456000000"]);
    await client.amemSemStore("a", "k", "c", [1], { pxat: 1893456000000 });
    expect(wire(client.lastCall)).toEqual(["AMEM.SEM.STORE", "a", "k", "c", "1", "PXAT", "1893456000000"]);
    await client.amemWorkSet("s", "k", "v", { pxat: 1893456000000 });
    expect(wire(client.lastCall)).toEqual(["AMEM.WORK.SET", "s", "k", "v", "PXAT", "1893456000000"]);
  });
});
