// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { hasServer, makeClient, uniquePrefix } from "./helpers.js";

describe.skipIf(!hasServer)("string commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("str");
  });

  afterAll(async () => {
    await client.close();
  });

  it("SET and GET round trip a value", async () => {
    await client.set(`${p}:a`, "hello");
    expect(await client.get(`${p}:a`)).toBe("hello");
  });

  it("GET on a missing key is null, not an error", async () => {
    expect(await client.get(`${p}:missing`)).toBeNull();
  });

  it("SET NX only sets when absent", async () => {
    const key = `${p}:nx`;
    await client.del(key);
    expect(await client.setNX(key, "one")).toBe(true);
    expect(await client.setNX(key, "two")).toBe(false);
    expect(await client.get(key)).toBe("one");
  });

  it("SET EX attaches an expiring TTL", async () => {
    const key = `${p}:ex`;
    await client.set(key, "v", { ex: 100 });
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it("SET GET returns the previous value", async () => {
    const key = `${p}:setget`;
    await client.set(key, "before");
    const result = await client.set(key, "after", { get: true });
    expect(result).toBe("before");
    expect(await client.get(key)).toBe("after");

    // GET on a key that does not exist yet: nil, but the write still happens.
    const missingKey = `${p}:setget-missing`;
    expect(await client.set(missingKey, "v1", { get: true })).toBeNull();
    expect(await client.get(missingKey)).toBe("v1");
  });

  it("SET KEEPTTL preserves an existing TTL", async () => {
    const key = `${p}:keepttl`;
    await client.set(key, "v1", { ex: 100 });
    await client.set(key, "v2", { keepTtl: true });
    expect(await client.get(key)).toBe("v2");
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);

    // A plain SET with no TTL option clears it.
    await client.set(key, "v3");
    expect(await client.ttl(key)).toBe(-1);
  });

  it("SET EXAT/PXAT set an absolute expiry", async () => {
    const key = `${p}:exat`;
    const futureUnixSeconds = Math.floor(Date.now() / 1000) + 100;
    await client.set(key, "v", { exat: futureUnixSeconds });
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);

    const key2 = `${p}:pxat`;
    const futureUnixMs = (Math.floor(Date.now() / 1000) + 100) * 1000;
    await client.set(key2, "v", { pxat: futureUnixMs });
    const pttl = await client.pTtl(key2);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(100_000);
  });

  it("APPEND grows the string and returns the new length", async () => {
    const key = `${p}:append`;
    await client.set(key, "foo");
    expect(await client.append(key, "bar")).toBe(6);
    expect(await client.get(key)).toBe("foobar");
  });

  it("STRLEN, GETRANGE, SETRANGE", async () => {
    const key = `${p}:range`;
    await client.set(key, "Hello World");
    expect(await client.strLen(key)).toBe(11);
    expect(await client.getRange(key, 0, 4)).toBe("Hello");
    await client.setRange(key, 6, "Redis");
    expect(await client.get(key)).toBe("Hello Redis");
  });

  it("INCR / DECR / INCRBY / DECRBY / INCRBYFLOAT", async () => {
    const key = `${p}:counter`;
    await client.set(key, "10");
    expect(await client.incr(key)).toBe(11);
    expect(await client.decr(key)).toBe(10);
    expect(await client.incrBy(key, 5)).toBe(15);
    expect(await client.decrBy(key, 3)).toBe(12);
    expect(Number(await client.incrByFloat(key, 0.5))).toBeCloseTo(12.5);
  });

  it("GETSET, GETDEL, GETEX", async () => {
    const key = `${p}:getset`;
    await client.set(key, "one");
    expect(await client.getSet(key, "two")).toBe("one");
    expect(await client.get(key)).toBe("two");
    await client.getEX(key, { ex: 50 });
    expect(await client.ttl(key)).toBeGreaterThan(0);
    expect(await client.getDel(key)).toBe("two");
    expect(await client.get(key)).toBeNull();
  });

  it("MGET / MSET / MSETNX", async () => {
    const k1 = `${p}:m1`;
    const k2 = `${p}:m2`;
    const k3 = `${p}:m3-missing`;
    await client.mSet({ [k1]: "a", [k2]: "b" });
    expect(await client.mGet(k1, k2, k3)).toEqual(["a", "b", null]);
    expect(await client.mSetNX({ [k1]: "x", [`${p}:m4`]: "y" })).toBe(false);
  });

  it("binary safe values round trip through Buffers", async () => {
    const key = `${p}:binary`;
    const raw = Buffer.from([0x00, 0x01, 0xff, 0x0d, 0x0a, 0x02]);
    await client.set(key, raw);
    const back = await client.getBuffer(key);
    expect(Buffer.compare(back as Buffer, raw)).toBe(0);
  });
});

describe.skipIf(!hasServer)("generic key commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("gen");
  });

  afterAll(async () => {
    await client.close();
  });

  it("DEL / EXISTS", async () => {
    const key = `${p}:del`;
    await client.set(key, "v");
    expect(await client.exists(key)).toBe(1);
    expect(await client.del(key)).toBe(1);
    expect(await client.exists(key)).toBe(0);
  });

  it("EXPIRE / TTL / PERSIST", async () => {
    const key = `${p}:expire`;
    await client.set(key, "v");
    expect(await client.expire(key, 100)).toBe(true);
    expect(await client.ttl(key)).toBeGreaterThan(0);
    expect(await client.persist(key)).toBe(true);
    expect(await client.ttl(key)).toBe(-1);
  });

  it("PEXPIRE / PTTL", async () => {
    const key = `${p}:pexpire`;
    await client.set(key, "v");
    await client.pExpire(key, 100_000);
    expect(await client.pTtl(key)).toBeGreaterThan(0);
  });

  it("TTL is -2 for a missing key", async () => {
    expect(await client.ttl(`${p}:never-existed`)).toBe(-2);
  });

  it("TYPE reports the value's type", async () => {
    const key = `${p}:type`;
    await client.set(key, "v");
    expect(await client.type(key)).toBe("string");
    expect(await client.type(`${p}:no-such-key`)).toBe("none");
  });

  it("RENAME / RENAMENX", async () => {
    const src = `${p}:rename-src`;
    const dst = `${p}:rename-dst`;
    await client.set(src, "v");
    await client.del(dst);
    await client.rename(src, dst);
    expect(await client.get(dst)).toBe("v");
    await client.set(src, "v2");
    expect(await client.renameNX(src, dst)).toBe(false);
  });

  it("COPY duplicates a key", async () => {
    const src = `${p}:copy-src`;
    const dst = `${p}:copy-dst`;
    await client.set(src, "v");
    await client.del(dst);
    expect(await client.copy(src, dst)).toBe(true);
    expect(await client.get(dst)).toBe("v");
  });

  it("KEYS matches a glob pattern", async () => {
    await client.mSet({ [`${p}:keys:1`]: "a", [`${p}:keys:2`]: "b" });
    const found = (await client.keys(`${p}:keys:*`)).sort();
    expect(found).toEqual([`${p}:keys:1`, `${p}:keys:2`]);
  });

  it("TOUCH refreshes access time and reports how many keys existed", async () => {
    const key = `${p}:touch`;
    await client.set(key, "v");
    expect(await client.touch(key, `${p}:missing-touch`)).toBe(1);
  });

  it("DUMP / RESTORE round trip a value", async () => {
    const src = `${p}:dump-src`;
    const dst = `${p}:dump-dst`;
    await client.set(src, "dumpme");
    const dumped = await client.dump(src);
    await client.del(dst);
    await client.restore(dst, 0, dumped as Buffer);
    expect(await client.get(dst)).toBe("dumpme");
  });

  it("generic command()/execute() escape hatch sends an arbitrary command", async () => {
    const key = `${p}:generic`;
    await client.command("SET", key, "via-generic");
    expect(await client.get(key)).toBe("via-generic");
  });
});
