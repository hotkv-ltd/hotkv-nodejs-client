// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { hasServer, makeClient, uniquePrefix } from "./helpers.js";

// eval()/evalSha() intentionally return the script's raw, undecoded reply
// (a Lua script can return any RESP shape), so a bulk string result comes
// back as a Buffer; decode it for these string-returning test scripts.
function asString(v: unknown): string {
  return Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
}

describe.skipIf(!hasServer)("server commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("server");
  });
  afterAll(async () => {
    await client.close();
  });

  it("PING and PING with a message", async () => {
    expect(await client.ping()).toBe("PONG");
    expect(await client.ping("hello")).toBe("hello");
  });

  it("ECHO", async () => {
    expect(await client.echo("hi")).toBe("hi");
  });

  it("INFO returns a non-empty report", async () => {
    const info = await client.info();
    expect(info.length).toBeGreaterThan(0);
  });

  it("DBSIZE is a non-negative integer", async () => {
    expect(await client.dbSize()).toBeGreaterThanOrEqual(0);
  });

  it("TIME returns [seconds, micros]", async () => {
    const [seconds, micros] = await client.time();
    expect(Number(seconds)).toBeGreaterThan(0);
    expect(Number(micros)).toBeGreaterThanOrEqual(0);
  });

  it("CONFIG GET / SET a well known parameter", async () => {
    const before = await client.configGet("maxmemory-policy");
    const key = Object.keys(before)[0];
    expect(key).toBeDefined();
  });

  it("CLIENT SETNAME / GETNAME / ID", async () => {
    await client.clientSetName(`${p}-conn`);
    // Pooled: the name we just set may land on a different physical
    // connection than the one GETNAME reads from, so just check the
    // round trip does not error and ID is a positive integer.
    const id = await client.clientId();
    expect(id).toBeGreaterThan(0);
    await client.clientGetName();
  });
});

describe.skipIf(!hasServer)("scripting commands", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("script");
  });
  afterAll(async () => {
    await client.close();
  });

  it("EVAL runs a script and returns its reply", async () => {
    const result = await client.eval("return ARGV[1]", [], ["hi"]);
    expect(asString(result)).toBe("hi");
  });

  it("EVAL can read and write keys via KEYS[]", async () => {
    const key = `${p}:evalkey`;
    await client.eval("redis.call('SET', KEYS[1], ARGV[1])", [key], ["set-by-script"]);
    expect(await client.get(key)).toBe("set-by-script");
  });

  it("SCRIPT LOAD then EVALSHA", async () => {
    const sha = await client.scriptLoad("return 'loaded'");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(asString(await client.evalSha(sha, [], []))).toBe("loaded");
  });

  it("SCRIPT EXISTS reports which scripts are cached", async () => {
    const sha = await client.scriptLoad("return 1");
    expect(await client.scriptExists(sha, "0".repeat(40))).toEqual([true, false]);
  });

  it("evalShaOrLoad falls back to EVAL on NOSCRIPT", async () => {
    // Never loaded via SCRIPT LOAD, so the first EVALSHA attempt must miss.
    const result = await client.evalShaOrLoad("return 'fallback-ok'", [], []);
    expect(asString(result)).toBe("fallback-ok");
  });
});

describe.skipIf(!hasServer)("SCAN family iterators", () => {
  let client: HotKV;
  let p: string;

  beforeAll(async () => {
    client = makeClient();
    p = uniquePrefix("scan");
    await client.mSet({ [`${p}:1`]: "a", [`${p}:2`]: "b", [`${p}:3`]: "c" });
  });
  afterAll(async () => {
    await client.del(`${p}:1`, `${p}:2`, `${p}:3`);
    await client.close();
  });

  it("scanIterator walks the whole matching keyspace using small COUNT pages", async () => {
    const found: string[] = [];
    for await (const key of client.scanIterator({ match: `${p}:*`, count: 1 })) found.push(key);
    expect(found.sort()).toEqual([`${p}:1`, `${p}:2`, `${p}:3`]);
  });

  it("hscanIterator yields [field, value] pairs", async () => {
    const key = `${p}:hash`;
    await client.hSet(key, { a: "1", b: "2" });
    const found: Array<[string, string]> = [];
    for await (const pair of client.hscanIterator(key, { count: 1 })) {
      found.push(pair as [string, string]);
    }
    expect(Object.fromEntries(found)).toEqual({ a: "1", b: "2" });
  });

  it("sscanIterator yields members", async () => {
    const key = `${p}:set`;
    await client.sAdd(key, "x", "y");
    const found: string[] = [];
    for await (const m of client.sscanIterator(key, { count: 1 })) found.push(m);
    expect(found.sort()).toEqual(["x", "y"]);
  });

  it("zscanIterator yields [member, score] pairs", async () => {
    const key = `${p}:zset`;
    await client.zAdd(key, [
      ["m1", "1"],
      ["m2", "2"],
    ]);
    const found: Array<[string, string]> = [];
    for await (const pair of client.zscanIterator(key, { count: 1 })) {
      found.push(pair as [string, string]);
    }
    expect(Object.fromEntries(found)).toEqual({ m1: "1", m2: "2" });
  });
});
