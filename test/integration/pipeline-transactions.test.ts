// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { hasServer, makeClient, uniquePrefix, isCluster } from "./helpers.js";

describe.skipIf(!hasServer || isCluster)("pipeline", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("pipe");
  });
  afterAll(async () => {
    await client.close();
  });

  it("sends every queued command in one round trip, in order", async () => {
    const pipeline = client.pipeline();
    pipeline.set(`${p}:a`, "1");
    pipeline.set(`${p}:b`, "2");
    pipeline.incr(`${p}:a`);
    const results = await pipeline.exec();
    expect(results.map(([err, value]) => (err ? "ERR" : value))).toEqual(["OK", "OK", 2]);
  });

  it("surfaces a per-command error without failing the rest of the batch", async () => {
    const key = `${p}:notanumber`;
    await client.set(key, "not-a-number");

    const pipeline = client.pipeline();
    pipeline.set(`${p}:ok1`, "x");
    const badPromise = pipeline.incr(key); // INCR on a non-numeric string -> ERR
    pipeline.set(`${p}:ok2`, "y");
    const results = await pipeline.exec();

    expect(results[0]).toEqual([null, "OK"]);
    expect(results[1]?.[0]).toBeInstanceOf(Error);
    expect(results[2]).toEqual([null, "OK"]);
    await expect(badPromise).rejects.toThrow();
  });

  it("the individual queued promise resolves to the same value exec() reports", async () => {
    const pipeline = client.pipeline();
    const getPromise = pipeline.set(`${p}:individual`, "value");
    await pipeline.exec();
    expect(await getPromise).toBe("OK");
  });

  it("clear() drops queued commands before exec()", async () => {
    const pipeline = client.pipeline();
    pipeline.set(`${p}:cleared`, "should-not-run");
    pipeline.clear();
    const results = await pipeline.exec();
    expect(results).toEqual([]);
    expect(await client.get(`${p}:cleared`)).toBeNull();
  });
});

describe.skipIf(!hasServer || isCluster)("transactions (MULTI/EXEC/DISCARD, WATCH/UNWATCH)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("tx");
  });
  afterAll(async () => {
    await client.close();
  });

  it("MULTI/EXEC runs queued commands atomically and returns their results", async () => {
    const key = `${p}:counter`;
    await client.set(key, "0");
    const multi = client.multi();
    multi.incr(key);
    multi.incr(key);
    const results = await multi.exec();
    expect(results).not.toBeNull();
    expect(results?.map(([, v]) => v)).toEqual([1, 2]);
    expect(await client.get(key)).toBe("2");
  });

  it("EXEC returns null when a watched key changed (aborted transaction)", async () => {
    const key = `${p}:watched`;
    await client.set(key, "0");

    const watchedMulti = await client.watch(key);
    await client.set(key, "changed-from-elsewhere");
    watchedMulti.incr(key);
    const results = await watchedMulti.exec();

    expect(results).toBeNull();
    expect(await client.get(key)).toBe("changed-from-elsewhere");
  });

  it("EXEC succeeds when the watched key was not touched", async () => {
    const key = `${p}:watched-ok`;
    await client.set(key, "5");

    const watchedMulti = await client.watch(key);
    watchedMulti.incr(key);
    const results = await watchedMulti.exec();

    expect(results).not.toBeNull();
    expect(await client.get(key)).toBe("6");
  });

  it("discard() releases a WATCH without running the transaction", async () => {
    const key = `${p}:discarded`;
    await client.set(key, "1");
    const watchedMulti = await client.watch(key);
    watchedMulti.incr(key);
    await watchedMulti.discard();
    // The key must be untouched: the transaction never ran.
    expect(await client.get(key)).toBe("1");
  });

  it("a failing command inside MULTI/EXEC surfaces as a per-command error, not a thrown exec()", async () => {
    const notNumberKey = `${p}:tx-notanumber`;
    await client.set(notNumberKey, "not-a-number");

    const multi = client.multi();
    multi.set(`${p}:tx-ok`, "v");
    multi.incr(notNumberKey); // ERR value is not an integer, inside the transaction
    const results = await multi.exec();

    expect(results).not.toBeNull();
    expect(results?.[0]).toEqual([null, "OK"]);
    expect(results?.[1]?.[0]).toBeInstanceOf(Error);
  });
});
