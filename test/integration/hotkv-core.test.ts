// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { hasServer, makeClient, runOrSkipIfNotLicensed, uniquePrefix } from "./helpers.js";

describe.skipIf(!hasServer)("TAG.* (core)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("tag");
  });
  afterAll(async () => {
    await client.close();
  });

  it("SET / REM / GET / COUNT / EXISTS", async () => {
    const key = `${p}:key1`;
    await client.set(key, "v");
    expect(await client.tagSet(key, "red", "blue")).toBe(2);
    expect((await client.tagGet(key)).sort()).toEqual(["blue", "red"]);
    expect(await client.tagCount(key)).toBe(2);
    expect(await client.tagExists(key, "red")).toBe(true);
    expect(await client.tagExists(key, "green")).toBe(false);
    expect(await client.tagRem(key, "red")).toBe(1);
    expect(await client.tagGet(key)).toEqual(["blue"]);
  });

  it("errors with ERR no such key when the key does not exist", async () => {
    await expect(client.tagSet(`${p}:never-existed`, "x")).rejects.toThrow();
  });

  it("MEMBERS / INTER find keys by tag", async () => {
    const k1 = `${p}:m1`;
    const k2 = `${p}:m2`;
    // Tags are their own global namespace (not scoped by key prefix), so
    // the tag names themselves must be unique to this run too.
    const shared = `${p}:shared`;
    const onlyA = `${p}:onlyA`;
    const onlyB = `${p}:onlyB`;
    await client.set(k1, "v");
    await client.set(k2, "v");
    await client.tagSet(k1, shared, onlyA);
    await client.tagSet(k2, shared, onlyB);
    expect((await client.tagMembers(shared)).sort()).toEqual([k1, k2]);
    expect(await client.tagInter(shared, onlyA)).toEqual([k1]);
  });
});

describe.skipIf(!hasServer)("NEXPIRE / NTTL / NEXPIREAT (core)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("nexpire");
  });
  afterAll(async () => {
    await client.close();
  });

  it("sets and reads a nanosecond resolution TTL", async () => {
    const key = `${p}:key1`;
    await client.set(key, "v");
    expect(await client.nExpire(key, 5_000_000_000n)).toBe(true);
    const ttl = await client.nTtl(key);
    expect(ttl > 0n).toBe(true);
    expect(ttl <= 5_000_000_000n).toBe(true);
  });

  it("NTTL is -2 for a missing key and -1 for no TTL", async () => {
    expect(await client.nTtl(`${p}:missing`)).toBe(-2n);
    const key = `${p}:no-ttl`;
    await client.set(key, "v");
    expect(await client.nTtl(key)).toBe(-1n);
  });

  it("NEXPIREAT sets an absolute nanosecond timestamp", async () => {
    const key = `${p}:at`;
    await client.set(key, "v");
    const future = BigInt(Date.now() + 60_000) * 1_000_000n;
    expect(await client.nExpireAt(key, future)).toBe(true);
    expect((await client.nTtl(key)) > 0n).toBe(true);
  });
});

describe.skipIf(!hasServer)("HOTKEYS (core, admin)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("hotkeys");
  });
  afterAll(async () => {
    await client.close();
  });

  it("TOP returns [key, count] pairs and RESET clears them", async () => {
    const key = `${p}:hot`;
    await client.set(key, "v");
    await client.get(key);
    await client.get(key);
    const top = await client.hotKeysTop(5);
    expect(Array.isArray(top)).toBe(true);
    await client.hotKeysReset();
  });
});

describe.skipIf(!hasServer)("GCRA.* (core rate limiter primitive)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("gcra");
  });
  afterAll(async () => {
    await client.close();
  });

  it("LIMIT allows up to burst then denies, RESET clears state", async () => {
    const key = `${p}:limiter`;
    const first = await client.gcraLimit(key, 60_000, 1);
    expect(first.denied).toBe(false);
    const second = await client.gcraLimit(key, 60_000, 1);
    expect(second.denied).toBe(true);
    expect(second.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(await client.gcraReset(key)).toBe(1);
  });
});

describe.skipIf(!hasServer)("VSIM.* (core except persistence)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("vsim");
  });
  afterAll(async () => {
    await client.close();
  });

  it("CREATEINDEX / SET / GET / SEARCH / DEL / DROPINDEX", async () => {
    const index = `${p}_idx`;
    await client.vsimCreateIndex(index, 3, { metric: "cosine" });
    expect(await client.vsimSet(index, "v1", [1, 0, 0])).toBe(true);
    expect(await client.vsimSet(index, "v2", [0, 1, 0])).toBe(true);

    const got = await client.vsimGet(index, "v1");
    expect(got).toEqual([1, 0, 0]);

    const results = await client.vsimSearch(index, 2, [1, 0, 0]);
    expect(results[0]?.key).toBe("v1");

    expect(await client.vsimDel(index, "v2")).toBe(true);
    expect(await client.vsimGet(index, "v2")).toBeNull();

    await client.vsimDropIndex(index);
  });

  it("SEARCH with FILTER restricts results to tagged keys", async () => {
    const index = `${p}_filter_idx`;
    const vecA = `${p}:vec:a`;
    const vecB = `${p}:vec:b`;
    await client.vsimCreateIndex(index, 2);
    await client.vsimSet(index, vecA, [1, 0]);
    await client.vsimSet(index, vecB, [1, 0]);
    // TAG.SET requires the tagged name to already exist as a real key;
    // a VSIM index entry lives in the vector index, not the keyspace.
    await client.set(vecA, "tag-target");
    await client.tagSet(vecA, "group1");
    const results = await client.vsimSearch(index, 5, [1, 0], { filter: ["group1"] });
    expect(results.map((r) => r.key)).toEqual([vecA]);
    await client.del(vecA);
    await client.vsimDropIndex(index);
  });

  it("INFO reports index configuration", async () => {
    const index = `${p}_info_idx`;
    await client.vsimCreateIndex(index, 4, { metric: "l2", m: 8 });
    const names = await client.vsimInfoNames();
    expect(names).toContain(index);
    const info = await client.vsimInfo(index);
    expect(info.name).toBe(index);
    expect(info.dimensions).toBe(4);
    expect(info.metric).toBe("l2");
    await client.vsimDropIndex(index);
  });

  it("SAVE/LOAD/LIST/DROP need a license with the vsimpersist feature", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      // Snapshot names take letters, digits and a few separators only.
      const name = `${p.replace(/[^A-Za-z0-9_-]/g, "")}_snapshot`;
      const blob = Buffer.from([0, 1, 2, 255, 254, 0, 98, 108, 111, 98]);
      // The reply counts the bytes stored, which include the server's own framing around the blob.
      expect(await client.vsimSave(name, blob)).toBeGreaterThanOrEqual(blob.length);
      expect(await client.vsimList()).toContain(name);
      expect(await client.vsimLoad(name)).toEqual(blob);
      expect(await client.vsimSnapshotDrop(name)).toBe(true);
      expect(await client.vsimLoad(name)).toBeNull();
      expect(await client.vsimList()).not.toContain(name);
      expect(await client.vsimSnapshotDrop(name)).toBe(false);
    });
  });
});
