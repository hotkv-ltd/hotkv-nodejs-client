// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Small, permissive coercion helpers shared by every typed command wrapper.
// HotKV's own command families are free to reply with either a native RESP
// integer or a bulk string for the same logical numeric field, so num()
// and str() accept either wire form rather than assuming one.

import { ProtocolError, ReplyError } from "../errors.js";
import type { RespValue } from "./types.js";

function describe(v: RespValue): string {
  if (v === null) return "null";
  if (Buffer.isBuffer(v)) return "buffer";
  if (Array.isArray(v)) return "array";
  if (v instanceof Map) return "map";
  if (v instanceof ReplyError) return `error(${v.code})`;
  return typeof v;
}

function rethrowIfError(v: RespValue): void {
  if (v instanceof ReplyError) throw v;
}

/** Decodes a text-ish reply (simple string, bulk string, verbatim string, or a scalar). */
export function str(v: RespValue): string {
  rethrowIfError(v);
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  throw new ProtocolError(`expected a string, got ${describe(v)}`);
}

export function strOrNull(v: RespValue): string | null {
  return v === null ? null : str(v);
}

/** Decodes a raw binary payload (used for the few genuinely binary commands, e.g. VSIM.SAVE/LOAD). */
export function buf(v: RespValue): Buffer {
  rethrowIfError(v);
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === "string") return Buffer.from(v, "utf8");
  throw new ProtocolError(`expected a buffer, got ${describe(v)}`);
}

export function bufOrNull(v: RespValue): Buffer | null {
  return v === null ? null : buf(v);
}

/** Decodes a numeric reply, whether sent as a native RESP integer/double or as a bulk string. */
export function num(v: RespValue): number {
  rethrowIfError(v);
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (Buffer.isBuffer(v)) return Number(v.toString("utf8"));
  if (typeof v === "string") return Number(v);
  throw new ProtocolError(`expected a number, got ${describe(v)}`);
}

export function numOrNull(v: RespValue): number | null {
  return v === null ? null : num(v);
}

/** Decodes a 0/1 integer reply, or a native RESP3 boolean, as a JS boolean. */
export function bool01(v: RespValue): boolean {
  rethrowIfError(v);
  if (typeof v === "boolean") return v;
  return num(v) !== 0;
}

export function bigNum(v: RespValue): bigint {
  rethrowIfError(v);
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (Buffer.isBuffer(v)) return BigInt(v.toString("utf8"));
  if (typeof v === "string") return BigInt(v);
  throw new ProtocolError(`expected a big number, got ${describe(v)}`);
}

export function arr(v: RespValue): RespValue[] {
  rethrowIfError(v);
  if (Array.isArray(v)) return v;
  throw new ProtocolError(`expected an array, got ${describe(v)}`);
}

export function arrOrNull(v: RespValue): RespValue[] | null {
  return v === null ? null : arr(v);
}

export function arrOrEmpty(v: RespValue): RespValue[] {
  return v === null ? [] : arr(v);
}

export function strArr(v: RespValue): string[] {
  return arrOrEmpty(v).map(str);
}

export function strArrOrNull(v: RespValue): string[] | null {
  return v === null ? null : arrOrEmpty(v).map(str);
}

/**
 * Turns either a flat `[name, value, name, value, ...]` reply (RESP2, or
 * RESP3 without a native map for that command) or a RESP3 native map
 * (decoded as a `Map`, e.g. `HGETALL`/`XINFO STREAM` under `HELLO 3`)
 * into a plain object keyed by name, so callers never need to know which
 * wire shape the connection's negotiated protocol version produced.
 */
export function pairsToObject(values: RespValue): Record<string, RespValue> {
  rethrowIfError(values);
  const out: Record<string, RespValue> = {};
  if (values instanceof Map) {
    for (const [k, v] of values) out[str(k)] = v;
    return out;
  }
  const flat = arr(values);
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[str(flat[i] as RespValue)] = flat[i + 1] as RespValue;
  }
  return out;
}

/**
 * Reads `key` out of a `pairsToObject()`-decoded reply, defaulting to
 * `fallback` (0) when the field is missing (an older server) or its value
 * cannot be parsed as a number (an unrecognized field this SDK does not
 * know about), instead of throwing. This is what keeps STATS/INFO reply
 * parsing forward compatible with a server that adds fields (parse by
 * field name, tolerate unknown or missing ones).
 */
export function numField(o: Record<string, RespValue>, key: string, fallback = 0): number {
  const v = o[key];
  if (v === undefined) return fallback;
  try {
    return num(v);
  } catch {
    return fallback;
  }
}

/** Like `numField()`, defaulting to `fallback` (`""`) and coercing via `str()`. */
export function strField(o: Record<string, RespValue>, key: string, fallback = ""): string {
  const v = o[key];
  if (v === undefined) return fallback;
  try {
    return str(v);
  } catch {
    return fallback;
  }
}

/** Like `pairsToObject()`, coercing every value to a string too. Accepts the same two wire shapes. */
export function pairsToStrObject(values: RespValue): Record<string, string> {
  rethrowIfError(values);
  const out: Record<string, string> = {};
  if (values instanceof Map) {
    for (const [k, v] of values) out[str(k)] = str(v);
    return out;
  }
  const flat = arr(values);
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[str(flat[i] as RespValue)] = str(flat[i + 1] as RespValue);
  }
  return out;
}

/** Groups a flat array into fixed size chunks, e.g. `[a,b,c,d]` with size 2 -> `[[a,b],[c,d]]`. */
export function chunk(values: RespValue[], size: number): RespValue[][] {
  const out: RespValue[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

/**
 * Recursively converts a reply into plain JS values (strings, numbers,
 * booleans, bigints, arrays, and objects for RESP3 maps), for the handful
 * of replies whose shape is too free form for a fixed decoder (XINFO,
 * OBSERVE INFO, ALERTS INFO). Throws if a ReplyError is found anywhere.
 */
export function toPlain(v: RespValue): unknown {
  rethrowIfError(v);
  if (v === null) return null;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of v) out[str(k)] = toPlain(val);
    return out;
  }
  return v;
}

/** Like pairsToObject, but recursively plain-ifies each value (see toPlain). Accepts the same two wire shapes. */
export function pairsToPlainObject(values: RespValue): Record<string, unknown> {
  rethrowIfError(values);
  const out: Record<string, unknown> = {};
  if (values instanceof Map) {
    for (const [k, v] of values) out[str(k)] = toPlain(v);
    return out;
  }
  const flat = arr(values);
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[str(flat[i] as RespValue)] = toPlain(flat[i + 1] as RespValue);
  }
  return out;
}

/**
 * Turns either a flat `[member, value, member, value, ...]` reply or
 * RESP3's native "array of pairs" reply (each element already a
 * 2-element array, e.g. `ZRANGE ... WITHSCORES`/`HRANDFIELD ...
 * WITHVALUES` under `HELLO 3`) into a uniform list of `[member, value]`
 * tuples, so callers never need to know which wire shape the
 * connection's negotiated protocol version produced.
 */
export function toPairs(values: RespValue[]): Array<[RespValue, RespValue]> {
  if (values.length > 0 && Array.isArray(values[0])) {
    return values as unknown as Array<[RespValue, RespValue]>;
  }
  const out: Array<[RespValue, RespValue]> = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    out.push([values[i] as RespValue, values[i + 1] as RespValue]);
  }
  return out;
}
