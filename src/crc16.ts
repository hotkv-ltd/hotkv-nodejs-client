// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { formatNumberArg } from "./internal/numbers.js";

/** Number of hash slots a HotKV cluster is divided into. */
export const CLUSTER_SLOTS = 16384;

/**
 * CRC16/XMODEM checksum (polynomial 0x1021, initial value 0, no
 * reflection): the variant HotKV cluster mode uses for key slot hashing.
 * crc16(Buffer.from("123456789")) === 0x31c3.
 */
export function crc16(data: Buffer | string): number {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= ((buf[i] as number) << 8) & 0xffff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Cluster hash slot (0..16383) for a key, honoring `{hash tag}`
 * substrings exactly like CLUSTER KEYSLOT: when the key contains a '{'
 * followed by a '}' with at least one byte between them, only the bytes
 * between the first such pair are hashed; otherwise the whole key is
 * hashed.
 */
export function keySlot(key: string | Buffer | number | bigint): number {
  // A numeric key is hashed as the text the writer sends (formatNumberArg), not as String() prints it.
  const text = typeof key === "number" ? formatNumberArg(key) : String(key);
  const bytes = Buffer.isBuffer(key) ? key : Buffer.from(text, "utf8");
  let hashed = bytes;
  const open = bytes.indexOf(0x7b);
  if (open >= 0) {
    const close = bytes.indexOf(0x7d, open + 1);
    if (close > open + 1) {
      hashed = bytes.subarray(open + 1, close);
    }
  }
  return crc16(hashed) % CLUSTER_SLOTS;
}
