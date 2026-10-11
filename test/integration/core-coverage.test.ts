// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Live calls of the typed core methods the other integration files do not
// reach. Each test checks the reply value, not only that the call did not
// throw.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import type { PubSubMessage } from "../../src/pubsub.js";
import { hasServer, isCluster, makeClient, sleep, uniquePrefix } from "./helpers.js";

describe.skipIf(!hasServer)("typed core methods, live", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("core");
  });
  afterAll(async () => {
    await client.close();
  });

  it("SETEX, PSETEX, EXPIREAT, PEXPIREAT, EXPIRETIME, PEXPIRETIME, UNLINK", async () => {
    const a = `${p}:a`;
    const b = `${p}:b`;
    await client.setEX(a, 100, "v");
    expect(await client.get(a)).toBe("v");
    const ttl = await client.ttl(a);
    expect(ttl).toBeGreaterThan(90);
    expect(ttl).toBeLessThanOrEqual(100);
    await client.pSetEX(b, 100_000, "w");
    const pttl = await client.pTtl(b);
    expect(pttl).toBeGreaterThan(90_000);
    expect(pttl).toBeLessThanOrEqual(100_000);

    const at = Math.floor(Date.now() / 1000) + 500;
    expect(await client.expireAt(a, at)).toBe(true);
    expect(await client.expireTime(a)).toBe(at);
    const atMs = Date.now() + 700_000;
    expect(await client.pExpireAt(b, atMs)).toBe(true);
    expect(await client.pExpireTime(b)).toBe(atMs);
    expect(await client.expireAt(`${p}:missing`, at)).toBe(false);
    expect(await client.expireTime(`${p}:missing`)).toBe(-2);

    expect(await client.unlink(a, b, `${p}:missing`)).toBe(2);
    expect(await client.exists(a, b)).toBe(0);
  });

  it("RANDOMKEY, MOVE, FLUSHDB, SELECT, LASTSAVE", async () => {
    const other = makeClient({ db: 11 });
    try {
      await other.flushDB();
      expect(await other.dbSize()).toBe(0);
      expect(await other.randomKey()).toBeNull();
      await other.set(`${p}:only`, "1");
      expect(await other.randomKey()).toBe(`${p}:only`);
      expect(await other.dbSize()).toBe(1);
      expect(await other.move(`${p}:only`, 12)).toBe(true);
      expect(await other.exists(`${p}:only`)).toBe(0);
      expect(await other.move(`${p}:only`, 12)).toBe(false);
      await other.select(12);
      expect(await other.get(`${p}:only`)).toBe("1");
      await other.flushDB();
      expect(await other.dbSize()).toBe(0);
    } finally {
      await other.close();
    }
    const stamp = await client.lastSave();
    expect(Number.isInteger(stamp)).toBe(true);
    expect(stamp).toBeGreaterThan(1_600_000_000);
  });

  it("LPUSHX, RPUSHX, BRPOP, BLMOVE", async () => {
    const l = `${p}:l`;
    expect(await client.lPushX(l, "x")).toBe(0);
    expect(await client.rPushX(l, "x")).toBe(0);
    await client.rPush(l, "m");
    expect(await client.lPushX(l, "a", "b")).toBe(3);
    expect(await client.rPushX(l, "z")).toBe(4);
    expect(await client.lRange(l, 0, -1)).toEqual(["b", "a", "m", "z"]);
    expect(await client.brPop([l], 1)).toEqual([l, "z"]);
    expect(await client.brPop([`${p}:nolist`], 1)).toBeNull();
    const dst = `${p}:l2`;
    expect(await client.blMove(l, dst, "LEFT", "RIGHT", 1)).toBe("b");
    expect(await client.lRange(dst, 0, -1)).toEqual(["b"]);
    expect(await client.blMove(`${p}:nolist`, dst, "LEFT", "RIGHT", 1)).toBeNull();
    await client.del(l, dst);
  });

  it("SDIFFSTORE, SUNIONSTORE", async () => {
    const s1 = `${p}:s1`;
    const s2 = `${p}:s2`;
    await client.sAdd(s1, "a", "b", "c");
    await client.sAdd(s2, "b", "d");
    expect(await client.sDiffStore(`${p}:diff`, s1, s2)).toBe(2);
    expect((await client.sMembers(`${p}:diff`)).sort()).toEqual(["a", "c"]);
    expect(await client.sUnionStore(`${p}:uni`, s1, s2)).toBe(4);
    expect((await client.sMembers(`${p}:uni`)).sort()).toEqual(["a", "b", "c", "d"]);
    await client.del(s1, s2, `${p}:diff`, `${p}:uni`);
  });

  it("sorted set: ZREM, ZMSCORE, ZLEXCOUNT, ZRANDMEMBER, ZRANGEBYLEX, ZREVRANGEBYLEX, ZREMRANGEBYLEX, ZREVRANGE, ZDIFFSTORE, ZINTERCARD", async () => {
    const z = `${p}:z`;
    await client.zAdd(z, [["a", 0], ["b", 0], ["c", 0], ["d", 0], ["e", 0]]);
    expect(await client.zLexCount(z, "-", "+")).toBe(5);
    expect(await client.zLexCount(z, "[b", "(d")).toBe(2);
    expect(await client.zRangeByLex(z, "[b", "[d")).toEqual(["b", "c", "d"]);
    expect(await client.zRangeByLex(z, "-", "+", { offset: 1, count: 2 })).toEqual(["b", "c"]);
    expect(await client.zRevRangeByLex(z, "[d", "[b")).toEqual(["d", "c", "b"]);
    expect(await client.zRemRangeByLex(z, "[d", "+")).toBe(2);
    expect(await client.zRem(z, "a", "nope")).toBe(1);
    expect(await client.zCard(z)).toBe(2);

    const s = `${p}:zs`;
    await client.zAdd(s, [["x", 1], ["y", 2], ["w", 3]]);
    expect(await client.zmScore(s, "x", "nope", "w")).toEqual(["1", null, "3"]);
    expect(await client.zRevRange(s, 0, -1)).toEqual(["w", "y", "x"]);
    expect(await client.zRevRange(s, 0, 0, true)).toEqual([["w", "3"]]);
    expect(await client.zRandMember(s)).toMatch(/^[xyw]$/);
    const rand = (await client.zRandMember(s, 2)) as string[];
    expect(rand).toHaveLength(2);
    const randScores = (await client.zRandMember(s, -4, true)) as Array<[string, string]>;
    expect(randScores).toHaveLength(4);
    expect(await client.zRandMember(`${p}:nozset`)).toBeNull();

    const t = `${p}:zt`;
    await client.zAdd(t, [["y", 5], ["q", 1]]);
    expect(await client.zInterCard([s, t])).toBe(1);
    expect(await client.zInterCard([s, t], 1)).toBe(1);
    expect(await client.zDiffStore(`${p}:zd`, [s, t])).toBe(2);
    expect(await client.zRange(`${p}:zd`, 0, -1)).toEqual(["x", "w"]);
    await client.del(z, s, t, `${p}:zd`);
  });

  it("BZPOPMIN, BZPOPMAX", async () => {
    const z = `${p}:bz`;
    await client.zAdd(z, [["lo", 1], ["hi", 9]]);
    expect(await client.bzPopMin([z], 1)).toEqual([z, "lo", "1"]);
    expect(await client.bzPopMax([z], 1)).toEqual([z, "hi", "9"]);
    expect(await client.bzPopMin([z], 1)).toBeNull();
    expect(await client.bzPopMax([z], 1)).toBeNull();
  });

  it("GEOHASH", async () => {
    const g = `${p}:geo`;
    await client.geoAdd(g, [{ longitude: 13.361389, latitude: 38.115556, member: "Palermo" }]);
    expect(await client.geoHash(g, "Palermo", "nobody")).toEqual(["sqc8b49rny0", null]);
    await client.del(g);
  });

  it("hash field expiry: HPEXPIRE, HEXPIREAT, HPEXPIREAT, HEXPIRETIME, HPEXPIRETIME, HPTTL, HRANDFIELD", async () => {
    const h = `${p}:h`;
    await client.hSet(h, { f1: "1", f2: "2", f3: "3" });
    expect(await client.hpExpire(h, 100_000, ["f1"])).toEqual([1]);
    const pttl = (await client.hpTtl(h, ["f1", "f2", "nope"])) as number[];
    expect(pttl[0]).toBeGreaterThan(90_000);
    expect(pttl[1]).toBe(-1);
    expect(pttl[2]).toBe(-2);
    const sec = Math.floor(Date.now() / 1000) + 500;
    expect(await client.hExpireAt(h, sec, ["f2"])).toEqual([1]);
    expect(await client.hExpireTime(h, ["f2", "f3"])).toEqual([sec, -1]);
    const ms = Date.now() + 800_000;
    expect(await client.hpExpireAt(h, ms, ["f3"])).toEqual([1]);
    expect(await client.hpExpireTime(h, ["f3"])).toEqual([ms]);

    expect(["f1", "f2", "f3"]).toContain(await client.hRandField(h));
    expect(((await client.hRandField(h, 2)) as string[]).length).toBe(2);
    const withValues = (await client.hRandField(h, 3, true)) as Array<[string, string]>;
    expect(withValues.map(([f]) => f).sort()).toEqual(["f1", "f2", "f3"]);
    expect(await client.hRandField(`${p}:nohash`)).toBeNull();
    await client.del(h);
  });

  it("streams: XREVRANGE, XGROUP CREATECONSUMER / DELCONSUMER / SETID, XINFO CONSUMERS", async () => {
    const s = `${p}:stream`;
    const id1 = await client.xAdd(s, { n: "1" });
    const id2 = await client.xAdd(s, { n: "2" });
    const rev = await client.xRevRange(s, "+", "-");
    expect(rev.map((e) => e.id)).toEqual([id2, id1]);
    expect(rev[0]?.fields).toEqual({ n: "2" });
    expect(await client.xRevRange(s, "+", "-", 1)).toHaveLength(1);

    await client.xGroupCreate(s, "g", "0");
    expect(await client.xGroupCreateConsumer(s, "g", "c1")).toBe(true);
    expect(await client.xGroupCreateConsumer(s, "g", "c1")).toBe(false);
    const consumers = await client.xInfoConsumers(s, "g");
    expect(consumers).toHaveLength(1);
    expect(String(consumers[0]?.name)).toBe("c1");
    await client.xGroupSetId(s, "g", "$");
    expect(await client.xGroupDelConsumer(s, "g", "c1")).toBe(0);
    expect(await client.xInfoConsumers(s, "g")).toHaveLength(0);
    await client.del(s);
  });

  it("SCRIPT FLUSH", async () => {
    const sha = await client.scriptLoad("return 7");
    expect(await client.scriptExists(sha)).toEqual([true]);
    await client.scriptFlush();
    expect(await client.scriptExists(sha)).toEqual([false]);
  });

  it("PUBSUB CHANNELS / NUMSUB / NUMPAT, and the PubSub unsubscribe calls", async () => {
    if (isCluster) return;
    const channel = `${p}:ch`;
    const pattern = `${p}:pat:*`;
    const sub = client.subscribe(channel);
    const psub = client.psubscribe(pattern);
    try {
      await sleep(100);
      expect(await client.pubsubChannels(`${p}:*`)).toContain(channel);
      expect(await client.pubsubNumSub(channel, `${p}:none`)).toEqual({ [channel]: 1, [`${p}:none`]: 0 });
      expect(await client.pubsubNumPat()).toBeGreaterThanOrEqual(1);

      const got: PubSubMessage[] = [];
      sub.on("message", (m: PubSubMessage) => got.push(m));
      expect(await client.publish(channel, "one")).toBe(1);
      await sleep(100);
      expect(got.map((m) => m.message)).toEqual(["one"]);
      await sub.unsubscribe(channel);
      expect(await client.publish(channel, "two")).toBe(0);
      await psub.punsubscribe(pattern);
      expect(await client.publish(`${p}:pat:x`, "three")).toBe(0);
    } finally {
      await sub.close();
      await psub.close();
    }
  });

  it("SSUBSCRIBE, SPUBLISH, SUNSUBSCRIBE", async () => {
    if (isCluster) return;
    const channel = `${p}:shard`;
    const sub = client.ssubscribe(channel);
    try {
      const received = new Promise<PubSubMessage>((resolve) => sub.once("smessage", resolve));
      await sleep(100);
      expect(await client.sPublish(channel, "sharded")).toBe(1);
      const msg = await received;
      expect(msg.channel).toBe(channel);
      expect(msg.message).toBe("sharded");
      await sub.sunsubscribe(channel);
      expect(await client.sPublish(channel, "again")).toBe(0);
    } finally {
      await sub.close();
    }
  });

  it("CONFIG SET round trips a value on the test server", async () => {
    if (isCluster) return;
    const before = (await client.configGet("slowlog-max-len"))["slowlog-max-len"];
    expect(before).toBeDefined();
    await client.configSet("slowlog-max-len", "77");
    expect((await client.configGet("slowlog-max-len"))["slowlog-max-len"]).toBe("77");
    await client.configSet("slowlog-max-len", before as string);
    expect((await client.configGet("slowlog-max-len"))["slowlog-max-len"]).toBe(before);
  });
});
