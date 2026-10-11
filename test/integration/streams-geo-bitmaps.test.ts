// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { hasServer, makeClient, uniquePrefix } from "./helpers.js";

describe.skipIf(!hasServer)("stream commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("stream");
  });
  afterAll(async () => {
    await client.close();
  });

  it("XADD / XLEN / XRANGE / XDEL", async () => {
    const key = `${p}:basic`;
    const id1 = await client.xAdd(key, { field: "v1" });
    await client.xAdd(key, { field: "v2" });
    expect(await client.xLen(key)).toBe(2);
    const range = await client.xRange(key, "-", "+");
    expect(range).toHaveLength(2);
    expect(range[0]?.fields.field).toBe("v1");
    expect(await client.xDel(key, id1)).toBe(1);
    expect(await client.xLen(key)).toBe(1);
  });

  it("XTRIM trims to a MAXLEN", async () => {
    const key = `${p}:trim`;
    for (let i = 0; i < 5; i++) await client.xAdd(key, { i: String(i) });
    await client.xTrim(key, { strategy: "MAXLEN", threshold: 2 });
    expect(await client.xLen(key)).toBe(2);
  });

  it("XREAD reads new entries by id", async () => {
    const key = `${p}:read`;
    await client.xAdd(key, { a: "1" });
    const result = await client.xRead({ [key]: "0" });
    expect(result?.[key]).toHaveLength(1);
  });

  it("consumer groups: XGROUP CREATE, XREADGROUP, XACK, XPENDING", async () => {
    const key = `${p}:group`;
    const group = "g1";
    await client.xAdd(key, { a: "1" });
    await client.xGroupCreate(key, group, "0");
    const read = await client.xReadGroup(group, "consumer-1", { [key]: ">" });
    expect(read?.[key]).toHaveLength(1);
    const entryId = read?.[key]?.[0]?.id as string;

    const summary = await client.xPending(key, group);
    expect(summary.count).toBe(1);

    expect(await client.xAck(key, group, entryId)).toBe(1);
    const summaryAfter = await client.xPending(key, group);
    expect(summaryAfter.count).toBe(0);

    expect(await client.xGroupDestroy(key, group)).toBe(true);
  });

  it("XCLAIM and XAUTOCLAIM transfer pending ownership", async () => {
    const key = `${p}:claim`;
    const group = "g-claim";
    const id = await client.xAdd(key, { a: "1" });
    await client.xGroupCreate(key, group, "0");
    await client.xReadGroup(group, "consumer-a", { [key]: ">" });

    const claimed = await client.xClaim(key, group, "consumer-b", 0, [id]);
    expect(claimed).toHaveLength(1);

    const auto = await client.xAutoClaim(key, group, "consumer-c", 0, "0");
    expect(auto.cursor).toBeDefined();
    expect(auto.entries).toHaveLength(1);
  });

  it("XINFO STREAM / GROUPS", async () => {
    const key = `${p}:info`;
    await client.xAdd(key, { a: "1" });
    const info = await client.xInfoStream(key);
    expect(info.length).toBe(1);
    await client.xGroupCreate(key, "gi", "0");
    const groups = await client.xInfoGroups(key);
    expect(groups.length).toBe(1);
  });
});

describe.skipIf(!hasServer)("geospatial commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("geo");
  });
  afterAll(async () => {
    await client.close();
  });

  it("GEOADD / GEOPOS / GEODIST / GEOSEARCH", async () => {
    const key = `${p}:cities`;
    await client.geoAdd(key, [
      { longitude: 13.361389, latitude: 38.115556, member: "Palermo" },
      { longitude: 15.087269, latitude: 37.502669, member: "Catania" },
    ]);
    const pos = await client.geoPos(key, "Palermo");
    expect(pos[0]).not.toBeNull();
    const dist = await client.geoDist(key, "Palermo", "Catania", "km");
    expect(Number(dist)).toBeGreaterThan(100);

    const results = await client.geoSearch(key, {
      fromMember: "Palermo",
      byRadius: { radius: 300, unit: "km" },
      asc: true,
    });
    expect(results.map((r) => r.member)).toContain("Palermo");
    expect(results.map((r) => r.member)).toContain("Catania");
  });
});

describe.skipIf(!hasServer)("bitmap commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("bitmap");
  });
  afterAll(async () => {
    await client.close();
  });

  it("SETBIT / GETBIT / BITCOUNT / BITPOS", async () => {
    const key = `${p}:bits`;
    await client.setBit(key, 7, 1);
    expect(await client.getBit(key, 7)).toBe(1);
    expect(await client.getBit(key, 6)).toBe(0);
    expect(await client.bitCount(key)).toBe(1);
    expect(await client.bitPos(key, 1)).toBe(7);
  });

  it("BITOP combines keys", async () => {
    const a = `${p}:opa`;
    const b = `${p}:opb`;
    const dest = `${p}:opdest`;
    await client.setBit(a, 0, 1);
    await client.setBit(b, 1, 1);
    await client.bitOp("OR", dest, a, b);
    expect(await client.getBit(dest, 0)).toBe(1);
    expect(await client.getBit(dest, 1)).toBe(1);
  });

  it("BITFIELD gets and sets packed integers", async () => {
    const key = `${p}:field`;
    const result = await client.bitField(key, [{ op: "SET", type: "u8", offset: "0", value: 255 }]);
    expect(result).toEqual([0]);
    const got = await client.bitField(key, [{ op: "GET", type: "u8", offset: "0" }]);
    expect(got).toEqual([255]);
  });
});

describe.skipIf(!hasServer)("hyperloglog commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("hll");
  });
  afterAll(async () => {
    await client.close();
  });

  it("PFADD / PFCOUNT / PFMERGE", async () => {
    const a = `${p}:a`;
    const b = `${p}:b`;
    const dest = `${p}:dest`;
    await client.pfAdd(a, "x", "y", "z");
    await client.pfAdd(b, "z", "w");
    expect(await client.pfCount(a)).toBeGreaterThanOrEqual(2);
    await client.pfMerge(dest, a, b);
    expect(await client.pfCount(dest)).toBeGreaterThanOrEqual(3);
  });
});
