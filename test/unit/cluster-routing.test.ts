// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { describe, expect, it } from "vitest";
import { commandName, fanoutKind, mergeReplies, routingKey } from "../../src/clusterRouting.js";
import { keySlot } from "../../src/crc16.js";

const keyOf = (...args: Array<string | number>) => routingKey(args);

describe("routingKey", () => {
  it.each([
    [["GET", "k"], "k"],
    [["get", "k"], "k"],
    [["SET", "k", "v"], "k"],
    [["MGET", "a", "b"], "a"],
    [["PCACHE.GET", "ns", "prompt"], "ns"],
    [["SCACHE.SET", "ns", "q", "r", "0.1"], "ns"],
    [["VSIM.SEARCH", "idx", 3, 0.1, 0.2], "idx"],
    [["VSIM.CREATEINDEX", "idx", 4], "idx"],
    [["VSIM.INFO", "idx"], "idx"],
    [["LLMBUDGET.CONSUME", "b", 10], "b"],
    [["AMEM.CONV.APPEND", "sess", "user", "hi"], "sess"],
    [["TS.ADD", "series", "*", 1], "series"],
    [["EVAL", "return 1", 2, "k1", "k2"], "k1"],
    [["EVALSHA", "abc", 1, "k1"], "k1"],
    [["FCALL", "fn", 1, "k1"], "k1"],
    [["EVAL", "return 1", 0], undefined],
    [["ZUNION", 2, "z1", "z2"], "z1"],
    [["ZINTERCARD", 2, "z1", "z2"], "z1"],
    [["LMPOP", 1, "list", "LEFT"], "list"],
    [["BLMPOP", 0, 1, "list", "LEFT"], "list"],
    [["SINTERCARD", 2, "s1", "s2"], "s1"],
    [["OBJECT", "ENCODING", "k"], "k"],
    [["MEMORY", "USAGE", "k"], "k"],
    [["MEMORY", "STATS"], undefined],
    [["XINFO", "STREAM", "s"], "s"],
    [["XGROUP", "CREATE", "s", "g", "$"], "s"],
    [["BITOP", "AND", "dest", "a", "b"], "dest"],
    [["XREAD", "COUNT", 2, "STREAMS", "s1", "s2", 0, 0], "s1"],
    [["XREADGROUP", "GROUP", "g", "c", "STREAMS", "s1", ">"], "s1"],
    [["PING"], undefined],
    [["INFO", "keyspace"], undefined],
    [["CONFIG", "GET", "maxmemory"], undefined],
    [["CLUSTER", "SLOTS"], undefined],
    [["SCAN", 0], undefined],
    [["LLMSTATS.PRICE", "GET", "model"], undefined],
    [["TENANT.CREATE", "acme"], undefined],
    [["PCACHE.LIST"], undefined],
    [["TAG.MEMBERS", "tag"], undefined],
    [["VSIM.INFO"], undefined],
  ] as Array<[Array<string | number>, string | undefined]>)("%j", (args, expected) => {
    expect(keyOf(...args)).toBe(expected);
  });
});

describe("fanoutKind", () => {
  it.each([
    "SCACHE.LIST",
    "PCACHE.LIST",
    "NCACHE.LIST",
    "TOOL.CACHE.LIST",
    "GUARD.LIST",
    "RERANK.LIST",
    "LLMSTATS.LIST",
    "LLMBUDGET.LIST",
    "RATELIMIT.LIST",
    "PROMPT.LIST",
    "EMBED.DEDUP.LIST",
    "FEATURE.LIST",
    "RAG.LIST",
    "VSIM.LIST",
    "AMEM.SUMMARY.LIST",
    "TS.LIST",
    "TAG.MEMBERS",
    "TAG.INTER",
    "KEYS",
  ])("%s is listed from every primary and merged", (name) => {
    expect(fanoutKind([name])).toBe("union");
  });

  it("covers the counting and flushing commands and leaves keyed ones alone", () => {
    expect(fanoutKind(["DBSIZE"])).toBe("sum");
    expect(fanoutKind(["FLUSHALL"])).toBe("all");
    expect(fanoutKind(["SCRIPT", "LOAD", "return 1"])).toBe("all");
    expect(fanoutKind(["SCRIPT", "EXISTS", "abc"])).toBeUndefined();
    expect(fanoutKind(["FUNCTION", "LOAD", "#!lua name=lib"])).toBe("all");
    expect(fanoutKind(["FUNCTION", "delete", "lib"])).toBe("all");
    expect(fanoutKind(["FUNCTION", "LIST"])).toBeUndefined();
    expect(fanoutKind(["GET", "k"])).toBeUndefined();
    expect(fanoutKind(["VSIM.INFO"])).toBe("union");
    expect(fanoutKind(["VSIM.INFO", "idx"])).toBeUndefined();
    expect(fanoutKind(["AMEM.SEM.LIST", "agent"])).toBeUndefined();
  });
});

describe("mergeReplies", () => {
  it("keeps each element of a union once, in first seen order", () => {
    const merged = mergeReplies("union", [
      [Buffer.from("a"), Buffer.from("b")],
      [Buffer.from("b"), "c"],
      null,
      [],
    ]);
    expect((merged as Array<Buffer | string>).map((v) => v.toString())).toEqual(["a", "b", "c"]);
  });

  it("merges nested replies by value", () => {
    const merged = mergeReplies("union", [[[Buffer.from("s1"), 1]], [[Buffer.from("s1"), 1], [Buffer.from("s2"), 2]]]);
    expect(merged).toHaveLength(2);
  });

  it("sums counts and returns the first reply of an 'all' command", () => {
    expect(mergeReplies("sum", [3, 4, 5])).toBe(12);
    expect(mergeReplies("all", ["OK", "OK"])).toBe("OK");
    expect(mergeReplies("union", [])).toEqual([]);
    expect(mergeReplies("sum", [])).toBe(0);
  });
});

describe("commandName and keySlot", () => {
  it("upper-cases a name given as a string or a buffer", () => {
    expect(commandName(["pcache.list"])).toBe("PCACHE.LIST");
    expect(commandName([Buffer.from("get"), "k"])).toBe("GET");
  });

  it("hashes a Buffer key the way the same string hashes, hash tags included", () => {
    expect(keySlot(Buffer.from("user:{42}:profile"))).toBe(keySlot("user:{42}:profile"));
    expect(keySlot("user:{42}:profile")).toBe(keySlot("42"));
    expect(keySlot(Buffer.from([0xff, 0x7b, 0x41, 0x7d]))).toBe(keySlot(Buffer.from("A")));
    expect(keySlot(12345)).toBe(keySlot("12345"));
  });
});
