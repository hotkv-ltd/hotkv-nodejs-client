// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { formatFloat } from "../internal/numbers.js";
import { arr, bufOrNull, num, str, strOrNull } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

export interface SetOptions {
  /** Expire after this many seconds. */
  ex?: number;
  /** Expire after this many milliseconds. */
  px?: number;
  /** Expire at this Unix time, in seconds. */
  exat?: number;
  /** Expire at this Unix time, in milliseconds. */
  pxat?: number;
  /** Keep the key's current TTL instead of clearing it. */
  keepTtl?: boolean;
  /** Only set if the key does not already exist. */
  nx?: boolean;
  /** Only set if the key already exists. */
  xx?: boolean;
  /** Return the previous value instead of the usual OK/nil reply. */
  get?: boolean;
}

function setArgs(key: string, value: CommandArg, opts?: SetOptions): CommandArg[] {
  const args: CommandArg[] = ["SET", key, value];
  if (opts?.ex !== undefined) args.push("EX", opts.ex);
  if (opts?.px !== undefined) args.push("PX", opts.px);
  if (opts?.exat !== undefined) args.push("EXAT", opts.exat);
  if (opts?.pxat !== undefined) args.push("PXAT", opts.pxat);
  if (opts?.keepTtl) args.push("KEEPTTL");
  if (opts?.nx) args.push("NX");
  if (opts?.xx) args.push("XX");
  if (opts?.get) args.push("GET");
  return args;
}

export interface StringCommands {
  /** GET key: the value, or null if the key does not exist. */
  get(key: string): Promise<string | null>;
  /** GET key, returning the raw bytes instead of decoding UTF-8. */
  getBuffer(key: string): Promise<Buffer | null>;
  /** SET key value [options]. Returns the previous value when `get` is set, else "OK" or null (NX/XX not satisfied). */
  set(key: string, value: string | Buffer, opts?: SetOptions): Promise<string | null>;
  /** SETNX key value: set only if absent. Returns whether it was set. */
  setNX(key: string, value: string | Buffer): Promise<boolean>;
  /** SETEX key seconds value. */
  setEX(key: string, seconds: number, value: string | Buffer): Promise<void>;
  /** PSETEX key milliseconds value. */
  pSetEX(key: string, milliseconds: number, value: string | Buffer): Promise<void>;
  /** GETSET key value: set a new value, returning the old one. */
  getSet(key: string, value: string | Buffer): Promise<string | null>;
  /** GETDEL key: return the value and delete the key atomically. */
  getDel(key: string): Promise<string | null>;
  /** GETEX key [EX/PX/EXAT/PXAT/PERSIST]: read a value while adjusting its TTL. */
  getEX(key: string, opts?: { ex?: number; px?: number; exat?: number; pxat?: number; persist?: boolean }): Promise<string | null>;
  /** APPEND key value: append to the string, returning the new length. */
  append(key: string, value: string | Buffer): Promise<number>;
  /** STRLEN key. */
  strLen(key: string): Promise<number>;
  /** GETRANGE key start end. */
  getRange(key: string, start: number, end: number): Promise<string>;
  /** SETRANGE key offset value. */
  setRange(key: string, offset: number, value: string | Buffer): Promise<number>;
  /** INCR key. */
  incr(key: string): Promise<number>;
  /** DECR key. */
  decr(key: string): Promise<number>;
  /** INCRBY key increment. */
  incrBy(key: string, increment: number): Promise<number>;
  /** DECRBY key decrement. */
  decrBy(key: string, decrement: number): Promise<number>;
  /** INCRBYFLOAT key increment. */
  incrByFloat(key: string, increment: number): Promise<string>;
  /** MGET key [key ...]: values in the same order as the keys, null where absent. */
  mGet(...keys: string[]): Promise<Array<string | null>>;
  /** MSET key value [key value ...]. */
  mSet(entries: Record<string, string | Buffer>): Promise<void>;
  /** MSETNX key value [key value ...]: set all, only if none of the keys already exist. */
  mSetNX(entries: Record<string, string | Buffer>): Promise<boolean>;
}

export function installStringCommands(proto: object): void {
  Object.assign(proto, {
    async get(this: Executor, key: string) {
      return strOrNull(await this.execute(["GET", key]));
    },
    async getBuffer(this: Executor, key: string) {
      return bufOrNull(await this.execute(["GET", key]));
    },
    async set(this: Executor, key: string, value: CommandArg, opts?: SetOptions) {
      return strOrNull(await this.execute(setArgs(key, value, opts)));
    },
    async setNX(this: Executor, key: string, value: CommandArg) {
      return strOrNull(await this.execute(["SET", key, value, "NX"])) !== null;
    },
    async setEX(this: Executor, key: string, seconds: number, value: CommandArg) {
      await this.execute(["SETEX", key, seconds, value]);
    },
    async pSetEX(this: Executor, key: string, milliseconds: number, value: CommandArg) {
      await this.execute(["PSETEX", key, milliseconds, value]);
    },
    async getSet(this: Executor, key: string, value: CommandArg) {
      return strOrNull(await this.execute(["GETSET", key, value]));
    },
    async getDel(this: Executor, key: string) {
      return strOrNull(await this.execute(["GETDEL", key]));
    },
    async getEX(
      this: Executor,
      key: string,
      opts?: { ex?: number; px?: number; exat?: number; pxat?: number; persist?: boolean },
    ) {
      const args: CommandArg[] = ["GETEX", key];
      if (opts?.ex !== undefined) args.push("EX", opts.ex);
      if (opts?.px !== undefined) args.push("PX", opts.px);
      if (opts?.exat !== undefined) args.push("EXAT", opts.exat);
      if (opts?.pxat !== undefined) args.push("PXAT", opts.pxat);
      if (opts?.persist) args.push("PERSIST");
      return strOrNull(await this.execute(args));
    },
    async append(this: Executor, key: string, value: CommandArg) {
      return num(await this.execute(["APPEND", key, value]));
    },
    async strLen(this: Executor, key: string) {
      return num(await this.execute(["STRLEN", key]));
    },
    async getRange(this: Executor, key: string, start: number, end: number) {
      return strOrNull(await this.execute(["GETRANGE", key, start, end])) ?? "";
    },
    async setRange(this: Executor, key: string, offset: number, value: CommandArg) {
      return num(await this.execute(["SETRANGE", key, offset, value]));
    },
    async incr(this: Executor, key: string) {
      return num(await this.execute(["INCR", key]));
    },
    async decr(this: Executor, key: string) {
      return num(await this.execute(["DECR", key]));
    },
    async incrBy(this: Executor, key: string, increment: number) {
      return num(await this.execute(["INCRBY", key, increment]));
    },
    async decrBy(this: Executor, key: string, decrement: number) {
      return num(await this.execute(["DECRBY", key, decrement]));
    },
    async incrByFloat(this: Executor, key: string, increment: number) {
      return strOrNull(await this.execute(["INCRBYFLOAT", key, formatFloat(increment, "increment")])) ?? "0";
    },
    async mGet(this: Executor, ...keys: string[]) {
      return arr(await this.execute(["MGET", ...keys])).map((v: RespValue) => (v === null ? null : str(v)));
    },
    async mSet(this: Executor, entries: Record<string, CommandArg>) {
      const args: CommandArg[] = ["MSET"];
      for (const [k, v] of Object.entries(entries)) args.push(k, v);
      await this.execute(args);
    },
    async mSetNX(this: Executor, entries: Record<string, CommandArg>) {
      const args: CommandArg[] = ["MSETNX"];
      for (const [k, v] of Object.entries(entries)) args.push(k, v);
      return num(await this.execute(args)) === 1;
    },
  });
}
