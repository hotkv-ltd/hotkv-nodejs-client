// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { hasServer, makeClient, uniquePrefix } from "./helpers.js";

describe.skipIf(!hasServer)("list commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("list");
  });
  afterAll(async () => {
    await client.close();
  });

  it("LPUSH / RPUSH / LRANGE / LLEN", async () => {
    const key = `${p}:basic`;
    await client.rPush(key, "a", "b", "c");
    await client.lPush(key, "z");
    expect(await client.lRange(key, 0, -1)).toEqual(["z", "a", "b", "c"]);
    expect(await client.lLen(key)).toBe(4);
  });

  it("LPOP / RPOP without count", async () => {
    const key = `${p}:pop`;
    await client.rPush(key, "a", "b", "c");
    expect(await client.lPop(key)).toBe("a");
    expect(await client.rPop(key)).toBe("c");
  });

  it("LPOP / RPOP with a count", async () => {
    const key = `${p}:popcount`;
    await client.rPush(key, "a", "b", "c", "d");
    expect(await client.lPop(key, 2)).toEqual(["a", "b"]);
    expect(await client.rPop(key, 2)).toEqual(["d", "c"]);
    // The list is now empty (and gone): a further count pop is a miss (nil).
    expect(await client.lPop(key, 5)).toBeNull();
  });

  it("LINDEX / LSET / LINSERT / LREM / LTRIM", async () => {
    const key = `${p}:mutate`;
    await client.rPush(key, "a", "b", "c");
    expect(await client.lIndex(key, 1)).toBe("b");
    await client.lSet(key, 1, "B");
    expect(await client.lIndex(key, 1)).toBe("B");
    await client.lInsert(key, "AFTER", "B", "B2");
    expect(await client.lRange(key, 0, -1)).toEqual(["a", "B", "B2", "c"]);
    await client.rPush(key, "a");
    expect(await client.lRem(key, 1, "a")).toBe(1);
    await client.lTrim(key, 0, 1);
    expect(await client.lRange(key, 0, -1)).toEqual(["B", "B2"]);
  });

  it("RPOPLPUSH and LMOVE", async () => {
    const src = `${p}:move-src`;
    const dst = `${p}:move-dst`;
    await client.rPush(src, "a", "b");
    await client.rPopLPush(src, dst);
    expect(await client.lRange(dst, 0, -1)).toEqual(["b"]);
    await client.lMove(src, dst, "LEFT", "RIGHT");
    expect(await client.lRange(dst, 0, -1)).toEqual(["b", "a"]);
  });

  it("LPOS finds an element's index", async () => {
    const key = `${p}:pos`;
    await client.rPush(key, "a", "b", "c", "b");
    expect(await client.lPos(key, "b")).toBe(1);
  });

  it("BLPOP returns immediately when data is already present", async () => {
    const key = `${p}:blpop`;
    await client.rPush(key, "ready");
    expect(await client.blPop([key], 1)).toEqual([key, "ready"]);
  });
});

describe.skipIf(!hasServer)("set commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("set");
  });
  afterAll(async () => {
    await client.close();
  });

  it("SADD / SMEMBERS / SCARD / SISMEMBER / SMISMEMBER", async () => {
    const key = `${p}:basic`;
    await client.sAdd(key, "a", "b", "c");
    expect((await client.sMembers(key)).sort()).toEqual(["a", "b", "c"]);
    expect(await client.sCard(key)).toBe(3);
    expect(await client.sIsMember(key, "a")).toBe(true);
    expect(await client.sIsMember(key, "z")).toBe(false);
    expect(await client.sMIsMember(key, "a", "z")).toEqual([true, false]);
  });

  it("SREM removes members", async () => {
    const key = `${p}:rem`;
    await client.sAdd(key, "a", "b");
    expect(await client.sRem(key, "a")).toBe(1);
    expect(await client.sMembers(key)).toEqual(["b"]);
  });

  it("SPOP / SRANDMEMBER with a count", async () => {
    const key = `${p}:pop`;
    await client.sAdd(key, "a", "b", "c");
    const popped = await client.sPop(key, 2);
    expect(Array.isArray(popped)).toBe(true);
    expect(popped as string[]).toHaveLength(2);

    const remaining = await client.sRandMember(key, 5); // fewer members than asked
    expect(remaining).toHaveLength(1);
    const many = await client.sRandMember(key, -5); // negative: repeats allowed
    expect(many).toHaveLength(5);

    // A count-pop past exhaustion (key now gone) is an empty array, not nil.
    await client.sPop(key, 1);
    expect(await client.sPop(key, 1)).toEqual([]);
  });

  it("SMOVE moves a member between sets", async () => {
    const src = `${p}:move-src`;
    const dst = `${p}:move-dst`;
    await client.sAdd(src, "a");
    expect(await client.sMove(src, dst, "a")).toBe(true);
    expect(await client.sIsMember(dst, "a")).toBe(true);
  });

  it("SINTER / SUNION / SDIFF and their *STORE variants", async () => {
    const a = `${p}:a`;
    const b = `${p}:b`;
    await client.sAdd(a, "x", "y");
    await client.sAdd(b, "y", "z");
    expect((await client.sInter(a, b)).sort()).toEqual(["y"]);
    expect((await client.sUnion(a, b)).sort()).toEqual(["x", "y", "z"]);
    expect((await client.sDiff(a, b)).sort()).toEqual(["x"]);
    const dest = `${p}:inter-store`;
    expect(await client.sInterStore(dest, a, b)).toBe(1);
  });

  it("SINTERCARD counts without materializing the result", async () => {
    const a = `${p}:card-a`;
    const b = `${p}:card-b`;
    await client.sAdd(a, "x", "y");
    await client.sAdd(b, "y", "z");
    expect(await client.sInterCard([a, b])).toBe(1);
  });
});

describe.skipIf(!hasServer)("hash commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("hash");
  });
  afterAll(async () => {
    await client.close();
  });

  it("HSET / HGET / HGETALL / HDEL / HLEN", async () => {
    const key = `${p}:basic`;
    expect(await client.hSet(key, { a: "1", b: "2" })).toBe(2);
    expect(await client.hGet(key, "a")).toBe("1");
    expect(await client.hGetAll(key)).toEqual({ a: "1", b: "2" });
    expect(await client.hLen(key)).toBe(2);
    expect(await client.hDel(key, "a")).toBe(1);
  });

  it("HSETNX / HEXISTS", async () => {
    const key = `${p}:setnx`;
    expect(await client.hSetNX(key, "f", "v1")).toBe(true);
    expect(await client.hSetNX(key, "f", "v2")).toBe(false);
    expect(await client.hGet(key, "f")).toBe("v1");
    expect(await client.hExists(key, "f")).toBe(true);
  });

  it("HMGET / HKEYS / HVALS", async () => {
    const key = `${p}:multi`;
    await client.hSet(key, { a: "1", b: "2" });
    expect(await client.hmGet(key, "a", "missing")).toEqual(["1", null]);
    expect((await client.hKeys(key)).sort()).toEqual(["a", "b"]);
    expect((await client.hVals(key)).sort()).toEqual(["1", "2"]);
  });

  it("HINCRBY / HINCRBYFLOAT / HSTRLEN", async () => {
    const key = `${p}:incr`;
    await client.hSet(key, { n: "10" });
    expect(await client.hIncrBy(key, "n", 5)).toBe(15);
    expect(Number(await client.hIncrByFloat(key, "n", 0.5))).toBeCloseTo(15.5);
    expect(await client.hStrLen(key, "n")).toBeGreaterThan(0);
  });

  it("HEXPIRE / HTTL / HPERSIST field level TTLs", async () => {
    const key = `${p}:fieldttl`;
    await client.hSet(key, { f: "v" });
    const set = await client.hExpire(key, 100, ["f"]);
    expect(set).toEqual([1]);
    const ttl = await client.hTtl(key, ["f"]);
    expect((ttl[0] as number) > 0).toBe(true);
    expect(await client.hPersist(key, ["f"])).toEqual([1]);
  });
});

describe.skipIf(!hasServer)("sorted set commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("zset");
  });
  afterAll(async () => {
    await client.close();
  });

  it("ZADD / ZSCORE / ZCARD / ZRANGE", async () => {
    const key = `${p}:basic`;
    await client.zAdd(key, [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    expect(await client.zScore(key, "b")).toBe("2");
    expect(await client.zCard(key)).toBe(3);
    expect(await client.zRange(key, "0", "-1")).toEqual(["a", "b", "c"]);
  });

  it("ZADD NX/XX/GT/LT/CH/INCR modifiers", async () => {
    const key = `${p}:modifiers`;
    await client.zAdd(key, [["m", "5"]]);

    // NX must not touch an existing member, so the score stays 5 and
    // nothing new gets added.
    const nxResult = await client.zAdd(key, [["m", "10"]], { nx: true });
    expect(nxResult).toBe(0);
    expect(await client.zScore(key, "m")).toBe("5");

    const chResult = await client.zAdd(key, [["m", "20"]], { xx: true, ch: true });
    expect(chResult).toBe(1);
    expect(await client.zScore(key, "m")).toBe("20");

    // GT: only updates when the new score is greater.
    expect(await client.zAdd(key, [["m", "5"]], { gt: true, ch: true })).toBe(0);
    expect(await client.zScore(key, "m")).toBe("20");
    expect(await client.zAdd(key, [["m", "30"]], { gt: true, ch: true })).toBe(1);
    expect(await client.zScore(key, "m")).toBe("30");

    // INCR returns the new score directly, and NX+INCR on an existing
    // member aborts (nil) rather than erroring.
    const incrScore = await client.zAdd(key, [["m", "5"]], { incr: true });
    expect(incrScore).toBe(35);
    const aborted = await client.zAdd(key, [["m", "1"]], { nx: true, incr: true });
    expect(aborted).toBeNull();
  });

  it("ZINCRBY / ZRANK / ZREVRANK", async () => {
    const key = `${p}:rank`;
    await client.zAdd(key, [
      ["a", "1"],
      ["b", "2"],
    ]);
    await client.zIncrBy(key, 10, "a");
    expect(await client.zScore(key, "a")).toBe("11");
    expect(await client.zRank(key, "b")).toBe(0);
    expect(await client.zRevRank(key, "b")).toBe(1);
  });

  it("ZRANK WITHSCORE", async () => {
    const key = `${p}:rankscore`;
    await client.zAdd(key, [["a", "5"]]);
    expect(await client.zRank(key, "a", true)).toEqual([0, "5"]);
    expect(await client.zRevRank(key, "a", true)).toEqual([0, "5"]);
    expect(await client.zRank(key, "missing", true)).toBeNull();
  });

  it("ZRANGE BYSCORE / BYLEX / REV / LIMIT / WITHSCORES", async () => {
    const key = `${p}:rangebyscore`;
    await client.zAdd(key, [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    expect(await client.zRange(key, "1", "2", { byScore: true })).toEqual(["a", "b"]);
    expect(await client.zRange(key, "3", "1", { byScore: true, rev: true })).toEqual(["c", "b", "a"]);
    expect(await client.zRange(key, "-", "+", { byLex: true })).toEqual(["a", "b", "c"]);
    expect(await client.zRange(key, "1", "3", { byScore: true, limit: { offset: 1, count: 1 } })).toEqual(["b"]);
    expect(await client.zRange(key, "0", "-1", { withScores: true })).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);

    const rev = await client.zRange(key, "0", "-1", { rev: true });
    expect(rev).toEqual(["c", "b", "a"]);
  });

  it("ZRANGEBYSCORE / ZREVRANGEBYSCORE / ZRANGEBYLEX", async () => {
    const key = `${p}:byscore`;
    await client.zAdd(key, [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    expect(await client.zRangeByScore(key, "1", "2")).toEqual(["a", "b"]);
    expect(await client.zRevRangeByScore(key, "2", "1")).toEqual(["b", "a"]);
  });

  it("ZRANGESTORE BYSCORE / BYLEX / REV / LIMIT", async () => {
    const key = `${p}:rangestore:src`;
    const dest = `${p}:rangestore:dst`;
    await client.zAdd(key, [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
      ["d", "4"],
    ]);

    expect(await client.zRangeStore(dest, key, "0", "-1")).toBe(4);
    expect(await client.zRange(dest, "0", "-1", { withScores: true })).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
      ["d", "4"],
    ]);

    expect(await client.zRangeStore(dest, key, "1", "2", { byScore: true })).toBe(2);
    expect(await client.zRange(dest, "0", "-1")).toEqual(["a", "b"]);

    expect(await client.zRangeStore(dest, key, "+", "-", { byLex: true, rev: true })).toBe(4);
    expect(await client.zRange(dest, "0", "-1")).toEqual(["a", "b", "c", "d"]);

    expect(await client.zRangeStore(dest, key, "4", "1", { byScore: true, rev: true, limit: { offset: 1, count: 2 } })).toBe(2);
    expect(await client.zRange(dest, "0", "-1")).toEqual(["b", "c"]);

    expect(await client.zRangeStore(dest, key, "10", "20", { byScore: true })).toBe(0);
    expect(await client.exists(dest)).toBe(0);
  });

  it("ZRANGESTORE BYSCORE keeps each stored member's score", async () => {
    const src = `${p}:zrs-src`;
    const dst = `${p}:zrs-dst`;
    await client.zAdd(src, [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
      ["d", "4"],
    ]);

    expect(await client.zRangeStore(dst, src, "2", "3", { byScore: true })).toBe(2);
    const stored = await client.zRange(dst, "0", "-1", { withScores: true });
    expect(stored).toHaveLength(2);
    expect(stored).toEqual([
      ["b", "2"],
      ["c", "3"],
    ]);
  });

  it("ZPOPMIN / ZPOPMAX with a count", async () => {
    const key = `${p}:pop`;
    await client.zAdd(key, [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
      ["d", "4"],
    ]);
    expect(await client.zPopMin(key, 2)).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(await client.zPopMax(key, 2)).toEqual([
      ["d", "4"],
      ["c", "3"],
    ]);
    expect(await client.zPopMin(key, 5)).toEqual([]);
  });

  it("ZREMRANGEBYRANK / ZREMRANGEBYSCORE", async () => {
    const key = `${p}:remrange`;
    await client.zAdd(key, [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    expect(await client.zRemRangeByRank(key, 0, 0)).toBe(1);
    expect(await client.zRemRangeByScore(key, "3", "3")).toBe(1);
    expect(await client.zRange(key, "0", "-1")).toEqual(["b"]);
  });

  it("ZDIFF / ZINTER / ZUNION", async () => {
    const a = `${p}:seta`;
    const b = `${p}:setb`;
    await client.zAdd(a, [
      ["x", "1"],
      ["y", "2"],
    ]);
    await client.zAdd(b, [["y", "5"]]);
    expect(await client.zDiff([a, b])).toEqual(["x"]);
    expect(await client.zInter([a, b])).toEqual(["y"]);
    expect((await client.zUnion([a, b])).sort()).toEqual(["x", "y"]);
  });

  it("ZUNIONSTORE / ZINTERSTORE with WEIGHTS and AGGREGATE", async () => {
    const a = `${p}:wa`;
    const b = `${p}:wb`;
    const dest = `${p}:wdest`;
    await client.zAdd(a, [
      ["m", "1"],
      ["onlyA", "1"],
    ]);
    await client.zAdd(b, [["m", "1"]]);

    await client.zUnionStore(dest, [a, b], { weights: [2, 3], aggregate: "MAX" });
    expect(await client.zScore(dest, "m")).toBe("3"); // max(2*1, 3*1)

    await client.zUnionStore(dest, [a, b], { weights: [2, 3], aggregate: "SUM" });
    expect(await client.zScore(dest, "m")).toBe("5"); // 2*1 + 3*1

    await client.zInterStore(dest, [a, b], { weights: [2, 3], aggregate: "MIN" });
    expect(await client.zScore(dest, "m")).toBe("2"); // min(2*1, 3*1)
  });
});
