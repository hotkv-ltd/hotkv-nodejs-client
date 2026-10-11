// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { arr, num, str, strArr, strOrNull } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

export type LMoveWhere = "LEFT" | "RIGHT";

export interface ListCommands {
  /** LPUSH key value [value ...]: new length. */
  lPush(key: string, ...values: CommandArg[]): Promise<number>;
  /** RPUSH key value [value ...]: new length. */
  rPush(key: string, ...values: CommandArg[]): Promise<number>;
  /** LPUSHX key value [value ...]: push only if the key already exists as a list. */
  lPushX(key: string, ...values: CommandArg[]): Promise<number>;
  /** RPUSHX key value [value ...]. */
  rPushX(key: string, ...values: CommandArg[]): Promise<number>;
  /** LPOP key [count]. */
  lPop(key: string, count?: number): Promise<string | string[] | null>;
  /** RPOP key [count]. */
  rPop(key: string, count?: number): Promise<string | string[] | null>;
  /** LLEN key. */
  lLen(key: string): Promise<number>;
  /** LRANGE key start stop. */
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  /** LINDEX key index. */
  lIndex(key: string, index: number): Promise<string | null>;
  /** LSET key index value. */
  lSet(key: string, index: number, value: CommandArg): Promise<void>;
  /** LINSERT key BEFORE|AFTER pivot value: new length, or -1 if the pivot was not found. */
  lInsert(key: string, where: "BEFORE" | "AFTER", pivot: CommandArg, value: CommandArg): Promise<number>;
  /** LREM key count value: number removed. */
  lRem(key: string, count: number, value: CommandArg): Promise<number>;
  /** LTRIM key start stop. */
  lTrim(key: string, start: number, stop: number): Promise<void>;
  /** RPOPLPUSH source destination. */
  rPopLPush(source: string, destination: string): Promise<string | null>;
  /** LMOVE source destination LEFT|RIGHT LEFT|RIGHT. */
  lMove(source: string, destination: string, from: LMoveWhere, to: LMoveWhere): Promise<string | null>;
  /** LPOS key element [RANK rank] [COUNT count] [MAXLEN len]. */
  lPos(
    key: string,
    element: CommandArg,
    opts?: { rank?: number; count?: number; maxLen?: number },
  ): Promise<number | number[] | null>;
  /** BLPOP key [key ...] timeoutSeconds: [key, value], or null on timeout. */
  blPop(keys: string[], timeoutSeconds: number): Promise<[string, string] | null>;
  /** BRPOP key [key ...] timeoutSeconds. */
  brPop(keys: string[], timeoutSeconds: number): Promise<[string, string] | null>;
  /** BLMOVE source destination LEFT|RIGHT LEFT|RIGHT timeoutSeconds. */
  blMove(
    source: string,
    destination: string,
    from: LMoveWhere,
    to: LMoveWhere,
    timeoutSeconds: number,
  ): Promise<string | null>;
}

function decodePop(v: RespValue): string | string[] | null {
  if (v === null) return null;
  if (Array.isArray(v)) return strArr(v);
  return str(v);
}

export function installListCommands(proto: object): void {
  Object.assign(proto, {
    async lPush(this: Executor, key: string, ...values: CommandArg[]) {
      return num(await this.execute(["LPUSH", key, ...values]));
    },
    async rPush(this: Executor, key: string, ...values: CommandArg[]) {
      return num(await this.execute(["RPUSH", key, ...values]));
    },
    async lPushX(this: Executor, key: string, ...values: CommandArg[]) {
      return num(await this.execute(["LPUSHX", key, ...values]));
    },
    async rPushX(this: Executor, key: string, ...values: CommandArg[]) {
      return num(await this.execute(["RPUSHX", key, ...values]));
    },
    async lPop(this: Executor, key: string, count?: number) {
      const args: CommandArg[] = count === undefined ? ["LPOP", key] : ["LPOP", key, count];
      return decodePop(await this.execute(args));
    },
    async rPop(this: Executor, key: string, count?: number) {
      const args: CommandArg[] = count === undefined ? ["RPOP", key] : ["RPOP", key, count];
      return decodePop(await this.execute(args));
    },
    async lLen(this: Executor, key: string) {
      return num(await this.execute(["LLEN", key]));
    },
    async lRange(this: Executor, key: string, start: number, stop: number) {
      return strArr(await this.execute(["LRANGE", key, start, stop]));
    },
    async lIndex(this: Executor, key: string, index: number) {
      return strOrNull(await this.execute(["LINDEX", key, index]));
    },
    async lSet(this: Executor, key: string, index: number, value: CommandArg) {
      await this.execute(["LSET", key, index, value]);
    },
    async lInsert(this: Executor, key: string, where: "BEFORE" | "AFTER", pivot: CommandArg, value: CommandArg) {
      return num(await this.execute(["LINSERT", key, where, pivot, value]));
    },
    async lRem(this: Executor, key: string, count: number, value: CommandArg) {
      return num(await this.execute(["LREM", key, count, value]));
    },
    async lTrim(this: Executor, key: string, start: number, stop: number) {
      await this.execute(["LTRIM", key, start, stop]);
    },
    async rPopLPush(this: Executor, source: string, destination: string) {
      return strOrNull(await this.execute(["RPOPLPUSH", source, destination]));
    },
    async lMove(this: Executor, source: string, destination: string, from: LMoveWhere, to: LMoveWhere) {
      return strOrNull(await this.execute(["LMOVE", source, destination, from, to]));
    },
    async lPos(
      this: Executor,
      key: string,
      element: CommandArg,
      opts?: { rank?: number; count?: number; maxLen?: number },
    ) {
      const args: CommandArg[] = ["LPOS", key, element];
      if (opts?.rank !== undefined) args.push("RANK", opts.rank);
      if (opts?.count !== undefined) args.push("COUNT", opts.count);
      if (opts?.maxLen !== undefined) args.push("MAXLEN", opts.maxLen);
      const reply = await this.execute(args);
      if (reply === null) return null;
      if (Array.isArray(reply)) return arr(reply).map(num);
      return num(reply);
    },
    async blPop(this: Executor, keys: string[], timeoutSeconds: number) {
      const reply = await this.execute(["BLPOP", ...keys, timeoutSeconds]);
      if (reply === null) return null;
      const [k, v] = arr(reply);
      return [str(k as RespValue), str(v as RespValue)] as [string, string];
    },
    async brPop(this: Executor, keys: string[], timeoutSeconds: number) {
      const reply = await this.execute(["BRPOP", ...keys, timeoutSeconds]);
      if (reply === null) return null;
      const [k, v] = arr(reply);
      return [str(k as RespValue), str(v as RespValue)] as [string, string];
    },
    async blMove(
      this: Executor,
      source: string,
      destination: string,
      from: LMoveWhere,
      to: LMoveWhere,
      timeoutSeconds: number,
    ) {
      return strOrNull(await this.execute(["BLMOVE", source, destination, from, to, timeoutSeconds]));
    },
  });
}
