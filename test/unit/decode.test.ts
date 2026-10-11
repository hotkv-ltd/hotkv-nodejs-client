// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Under HELLO 3 (the default), some replies arrive as RESP3's native map
// type (decoded as a `Map`) or its native "array of pairs" shape, instead
// of RESP2's flat alternating array. These helpers must handle both
// shapes identically, since which one a given command uses is a server
// implementation detail, not something callers should need to know.

import { describe, expect, it } from "vitest";
import { pairsToObject, pairsToPlainObject, pairsToStrObject, toPairs } from "../../src/resp/decode.js";

describe("pairsToObject", () => {
  it("decodes a flat RESP2-style array", () => {
    expect(pairsToObject(["a", 1, "b", 2])).toEqual({ a: 1, b: 2 });
  });

  it("decodes a native RESP3 map", () => {
    expect(pairsToObject(new Map<unknown, unknown>([["a", 1], ["b", 2]]))).toEqual({ a: 1, b: 2 });
  });

  it("decodes Buffer keys the same way in both shapes", () => {
    const flat = pairsToObject([Buffer.from("a"), 1]);
    const map = pairsToObject(new Map<unknown, unknown>([[Buffer.from("a"), 1]]));
    expect(flat).toEqual({ a: 1 });
    expect(map).toEqual({ a: 1 });
  });
});

describe("pairsToStrObject", () => {
  it("decodes a flat array, coercing values to strings", () => {
    expect(pairsToStrObject(["entries", 3, "hits", 1])).toEqual({ entries: "3", hits: "1" });
  });

  it("decodes a native RESP3 map, coercing values to strings", () => {
    expect(pairsToStrObject(new Map<unknown, unknown>([["entries", 3], ["hits", 1]]))).toEqual({
      entries: "3",
      hits: "1",
    });
  });
});

describe("pairsToPlainObject", () => {
  it("decodes a flat array with nested plain-ified values", () => {
    expect(pairsToPlainObject(["length", 2, "groups", ["g1"]])).toEqual({ length: 2, groups: ["g1"] });
  });

  it("decodes a native RESP3 map, recursively plain-ifying nested maps", () => {
    const nested = new Map<unknown, unknown>([["length", 2], ["labels", new Map<unknown, unknown>([["env", "prod"]])]]);
    expect(pairsToPlainObject(nested)).toEqual({ length: 2, labels: { env: "prod" } });
  });
});

describe("toPairs", () => {
  it("groups a flat RESP2-style alternating array into tuples", () => {
    expect(toPairs(["a", 1, "b", 2])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("passes through RESP3's native array-of-pairs shape unchanged", () => {
    const input = [
      ["a", 1],
      ["b", 2],
    ];
    expect(toPairs(input)).toEqual(input);
  });

  it("returns an empty list for an empty reply", () => {
    expect(toPairs([])).toEqual([]);
  });
});
