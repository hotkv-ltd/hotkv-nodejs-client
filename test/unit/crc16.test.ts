// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { describe, expect, it } from "vitest";
import { crc16, keySlot } from "../../src/crc16.js";

describe("crc16", () => {
  it("matches the standard CRC16/XMODEM test vector", () => {
    expect(crc16(Buffer.from("123456789"))).toBe(0x31c3);
  });

  it("accepts a plain string too", () => {
    expect(crc16("123456789")).toBe(0x31c3);
  });
});

describe("keySlot", () => {
  // Known vectors, cross checked against CLUSTER KEYSLOT.
  const vectors: Array<[string, number]> = [
    ["foo", 12182],
    ["bar", 5061],
    ["hello", 866],
    ["{user1000}.following", 3443],
    ["{user1000}.followers", 3443],
    ["{}foo", 9500],
    ["foo{}{bar}", 8363],
    ["foo{{bar}}zap", 4015],
    ["foo{bar}{zap}", 5061],
  ];

  it.each(vectors)("keySlot(%j) === %i", (key, expected) => {
    expect(keySlot(key)).toBe(expected);
  });

  it("hashes the whole key when there is no hash tag", () => {
    expect(keySlot("plainkey")).toBe(keySlot("plainkey"));
  });

  it("two keys sharing a hash tag land on the same slot", () => {
    expect(keySlot("{user1000}.following")).toBe(keySlot("{user1000}.followers"));
  });

  it("stays within the valid slot range", () => {
    for (const key of ["a", "b", "c", "{tag}rest", "another-key-1234"]) {
      const slot = keySlot(key);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(16384);
    }
  });
});
