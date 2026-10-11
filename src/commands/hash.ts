// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { formatFloat } from "../internal/numbers.js";
import { arr, bool01, num, pairsToStrObject, str, strArr, strOrNull, toPairs } from "../resp/decode.js";
import type { CommandArg } from "../resp/types.js";

function fieldExpireArgs(
  command: string,
  key: string,
  amount: number,
  fields: string[],
  condition?: "NX" | "XX" | "GT" | "LT",
): CommandArg[] {
  const args: CommandArg[] = [command, key, amount];
  if (condition !== undefined) args.push(condition);
  args.push("FIELDS", fields.length, ...fields);
  return args;
}

export interface HashCommands {
  /** HSET key field value [field value ...]: number of new fields added. */
  hSet(key: string, entries: Record<string, CommandArg>): Promise<number>;
  /** HSETNX key field value. */
  hSetNX(key: string, field: string, value: CommandArg): Promise<boolean>;
  /** HGET key field. */
  hGet(key: string, field: string): Promise<string | null>;
  /** HMGET key field [field ...]. */
  hmGet(key: string, ...fields: string[]): Promise<Array<string | null>>;
  /** HGETALL key. */
  hGetAll(key: string): Promise<Record<string, string>>;
  /** HDEL key field [field ...]. */
  hDel(key: string, ...fields: string[]): Promise<number>;
  /** HEXISTS key field. */
  hExists(key: string, field: string): Promise<boolean>;
  /** HLEN key. */
  hLen(key: string): Promise<number>;
  /** HKEYS key. */
  hKeys(key: string): Promise<string[]>;
  /** HVALS key. */
  hVals(key: string): Promise<string[]>;
  /** HINCRBY key field increment. */
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  /** HINCRBYFLOAT key field increment. */
  hIncrByFloat(key: string, field: string, increment: number): Promise<string>;
  /** HSTRLEN key field. */
  hStrLen(key: string, field: string): Promise<number>;
  /** HRANDFIELD key [count [WITHVALUES]]. */
  hRandField(key: string, count?: number, withValues?: boolean): Promise<string | string[] | Array<[string, string]> | null>;
  /** HEXPIRE key seconds [NX|XX|GT|LT] FIELDS numfields field [field ...]: 1/0/-2 per field. */
  hExpire(key: string, seconds: number, fields: string[], condition?: "NX" | "XX" | "GT" | "LT"): Promise<number[]>;
  /** HPEXPIRE key milliseconds ... FIELDS ... */
  hpExpire(key: string, milliseconds: number, fields: string[], condition?: "NX" | "XX" | "GT" | "LT"): Promise<number[]>;
  /** HEXPIREAT key unix-seconds ... FIELDS ... */
  hExpireAt(key: string, unixSeconds: number, fields: string[], condition?: "NX" | "XX" | "GT" | "LT"): Promise<number[]>;
  /** HPEXPIREAT key unix-milliseconds ... FIELDS ... */
  hpExpireAt(key: string, unixMilliseconds: number, fields: string[], condition?: "NX" | "XX" | "GT" | "LT"): Promise<number[]>;
  /** HPERSIST key FIELDS numfields field [field ...]. */
  hPersist(key: string, fields: string[]): Promise<number[]>;
  /** HTTL key FIELDS numfields field [field ...]: seconds remaining per field. */
  hTtl(key: string, fields: string[]): Promise<number[]>;
  /** HPTTL key FIELDS numfields field [field ...]. */
  hpTtl(key: string, fields: string[]): Promise<number[]>;
  /** HEXPIRETIME key FIELDS numfields field [field ...]. */
  hExpireTime(key: string, fields: string[]): Promise<number[]>;
  /** HPEXPIRETIME key FIELDS numfields field [field ...]. */
  hpExpireTime(key: string, fields: string[]): Promise<number[]>;
}

export function installHashCommands(proto: object): void {
  Object.assign(proto, {
    async hSet(this: Executor, key: string, entries: Record<string, CommandArg>) {
      const args: CommandArg[] = ["HSET", key];
      for (const [f, v] of Object.entries(entries)) args.push(f, v);
      return num(await this.execute(args));
    },
    async hSetNX(this: Executor, key: string, field: string, value: CommandArg) {
      return bool01(await this.execute(["HSETNX", key, field, value]));
    },
    async hGet(this: Executor, key: string, field: string) {
      return strOrNull(await this.execute(["HGET", key, field]));
    },
    async hmGet(this: Executor, key: string, ...fields: string[]) {
      return arr(await this.execute(["HMGET", key, ...fields])).map((v) => (v === null ? null : str(v)));
    },
    async hGetAll(this: Executor, key: string) {
      return pairsToStrObject(await this.execute(["HGETALL", key]));
    },
    async hDel(this: Executor, key: string, ...fields: string[]) {
      return num(await this.execute(["HDEL", key, ...fields]));
    },
    async hExists(this: Executor, key: string, field: string) {
      return bool01(await this.execute(["HEXISTS", key, field]));
    },
    async hLen(this: Executor, key: string) {
      return num(await this.execute(["HLEN", key]));
    },
    async hKeys(this: Executor, key: string) {
      return strArr(await this.execute(["HKEYS", key]));
    },
    async hVals(this: Executor, key: string) {
      return strArr(await this.execute(["HVALS", key]));
    },
    async hIncrBy(this: Executor, key: string, field: string, increment: number) {
      return num(await this.execute(["HINCRBY", key, field, increment]));
    },
    async hIncrByFloat(this: Executor, key: string, field: string, increment: number) {
      return strOrNull(await this.execute(["HINCRBYFLOAT", key, field, formatFloat(increment, "increment")])) ?? "0";
    },
    async hStrLen(this: Executor, key: string, field: string) {
      return num(await this.execute(["HSTRLEN", key, field]));
    },
    async hRandField(this: Executor, key: string, count?: number, withValues?: boolean) {
      if (count === undefined) return strOrNull(await this.execute(["HRANDFIELD", key]));
      const args: CommandArg[] = ["HRANDFIELD", key, count];
      if (withValues) args.push("WITHVALUES");
      const reply = await this.execute(args);
      if (!withValues) return strArr(reply);
      return toPairs(arr(reply)).map(([field, value]) => [str(field), str(value)] as [string, string]);
    },
    async hExpire(this: Executor, key: string, seconds: number, fields: string[], condition?: "NX" | "XX" | "GT" | "LT") {
      return arr(await this.execute(fieldExpireArgs("HEXPIRE", key, seconds, fields, condition))).map(num);
    },
    async hpExpire(this: Executor, key: string, milliseconds: number, fields: string[], condition?: "NX" | "XX" | "GT" | "LT") {
      return arr(await this.execute(fieldExpireArgs("HPEXPIRE", key, milliseconds, fields, condition))).map(num);
    },
    async hExpireAt(this: Executor, key: string, unixSeconds: number, fields: string[], condition?: "NX" | "XX" | "GT" | "LT") {
      return arr(await this.execute(fieldExpireArgs("HEXPIREAT", key, unixSeconds, fields, condition))).map(num);
    },
    async hpExpireAt(this: Executor, key: string, unixMilliseconds: number, fields: string[], condition?: "NX" | "XX" | "GT" | "LT") {
      return arr(await this.execute(fieldExpireArgs("HPEXPIREAT", key, unixMilliseconds, fields, condition))).map(num);
    },
    async hPersist(this: Executor, key: string, fields: string[]) {
      return arr(await this.execute(["HPERSIST", key, "FIELDS", fields.length, ...fields])).map(num);
    },
    async hTtl(this: Executor, key: string, fields: string[]) {
      return arr(await this.execute(["HTTL", key, "FIELDS", fields.length, ...fields])).map(num);
    },
    async hpTtl(this: Executor, key: string, fields: string[]) {
      return arr(await this.execute(["HPTTL", key, "FIELDS", fields.length, ...fields])).map(num);
    },
    async hExpireTime(this: Executor, key: string, fields: string[]) {
      return arr(await this.execute(["HEXPIRETIME", key, "FIELDS", fields.length, ...fields])).map(num);
    },
    async hpExpireTime(this: Executor, key: string, fields: string[]) {
      return arr(await this.execute(["HPEXPIRETIME", key, "FIELDS", fields.length, ...fields])).map(num);
    },
  });
}
