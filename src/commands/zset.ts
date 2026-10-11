// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { arr, num, numOrNull, str, strArr, strOrNull, toPairs } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

export interface ZAddOptions {
  nx?: boolean;
  xx?: boolean;
  gt?: boolean;
  lt?: boolean;
  ch?: boolean;
  incr?: boolean;
}

export interface ZRangeOptions {
  byScore?: boolean;
  byLex?: boolean;
  rev?: boolean;
  limit?: { offset: number; count: number };
  withScores?: boolean;
}

export interface ZRangeStoreOptions {
  byScore?: boolean;
  byLex?: boolean;
  rev?: boolean;
  limit?: { offset: number; count: number };
}

function zAddArgs(key: string, entries: Array<[CommandArg, string | number]>, opts?: ZAddOptions): CommandArg[] {
  const args: CommandArg[] = ["ZADD", key];
  if (opts?.nx) args.push("NX");
  if (opts?.xx) args.push("XX");
  if (opts?.gt) args.push("GT");
  if (opts?.lt) args.push("LT");
  if (opts?.ch) args.push("CH");
  if (opts?.incr) args.push("INCR");
  for (const [member, score] of entries) args.push(score, member);
  return args;
}

function pairsToTuples(v: RespValue, withScores: boolean): string[] | Array<[string, string]> {
  if (!withScores) return strArr(v);
  return toPairs(arr(v)).map(([member, score]) => [str(member), str(score)] as [string, string]);
}

export interface ZSetCommands {
  /**
   * ZADD key [NX|XX] [GT|LT] [CH] [INCR] score member [score member ...].
   * Without `incr`: the number of newly added members (plus changed
   * members, with `ch`). With `incr` (and exactly one entry): the
   * member's new score, or null if NX/XX/GT/LT aborted the update.
   */
  zAdd(key: string, entries: Array<[CommandArg, string | number]>, opts?: ZAddOptions): Promise<number | null>;
  /** ZINCRBY key increment member. */
  zIncrBy(key: string, increment: number, member: CommandArg): Promise<string>;
  /** ZREM key member [member ...]. */
  zRem(key: string, ...members: CommandArg[]): Promise<number>;
  /** ZSCORE key member. */
  zScore(key: string, member: CommandArg): Promise<string | null>;
  /** ZMSCORE key member [member ...]. */
  zmScore(key: string, ...members: CommandArg[]): Promise<Array<string | null>>;
  /** ZCARD key. */
  zCard(key: string): Promise<number>;
  /** ZCOUNT key min max. */
  zCount(key: string, min: string | number, max: string | number): Promise<number>;
  /** ZLEXCOUNT key min max. */
  zLexCount(key: string, min: string, max: string): Promise<number>;
  /** ZRANK key member [WITHSCORE]. */
  zRank(key: string, member: CommandArg, withScore?: boolean): Promise<number | [number, string] | null>;
  /** ZREVRANK key member [WITHSCORE]. */
  zRevRank(key: string, member: CommandArg, withScore?: boolean): Promise<number | [number, string] | null>;
  /** ZRANGE key start stop [BYSCORE|BYLEX] [REV] [LIMIT off count] [WITHSCORES]. */
  zRange(key: string, start: string, stop: string, opts?: ZRangeOptions): Promise<string[] | Array<[string, string]>>;
  /** ZRANGESTORE destination source min max [BYSCORE|BYLEX] [REV] [LIMIT off count]. Returns the number of elements stored. */
  zRangeStore(destination: string, source: string, min: string, max: string, opts?: ZRangeStoreOptions): Promise<number>;
  /** ZRANGEBYSCORE key min max [LIMIT off count] [WITHSCORES]. */
  zRangeByScore(
    key: string,
    min: string | number,
    max: string | number,
    opts?: { limit?: { offset: number; count: number }; withScores?: boolean },
  ): Promise<string[] | Array<[string, string]>>;
  /** ZREVRANGEBYSCORE key max min [LIMIT off count] [WITHSCORES]. */
  zRevRangeByScore(
    key: string,
    max: string | number,
    min: string | number,
    opts?: { limit?: { offset: number; count: number }; withScores?: boolean },
  ): Promise<string[] | Array<[string, string]>>;
  /** ZREVRANGE key start stop [WITHSCORES]. */
  zRevRange(key: string, start: number, stop: number, withScores?: boolean): Promise<string[] | Array<[string, string]>>;
  /** ZRANGEBYLEX key min max [LIMIT off count]. */
  zRangeByLex(key: string, min: string, max: string, limit?: { offset: number; count: number }): Promise<string[]>;
  /** ZREVRANGEBYLEX key max min [LIMIT off count]. */
  zRevRangeByLex(key: string, max: string, min: string, limit?: { offset: number; count: number }): Promise<string[]>;
  /** ZPOPMIN key [count]. */
  zPopMin(key: string, count?: number): Promise<Array<[string, string]>>;
  /** ZPOPMAX key [count]. */
  zPopMax(key: string, count?: number): Promise<Array<[string, string]>>;
  /** BZPOPMIN key [key ...] timeoutSeconds. */
  bzPopMin(keys: string[], timeoutSeconds: number): Promise<[string, string, string] | null>;
  /** BZPOPMAX key [key ...] timeoutSeconds. */
  bzPopMax(keys: string[], timeoutSeconds: number): Promise<[string, string, string] | null>;
  /** ZRANDMEMBER key [count [WITHSCORES]]. */
  zRandMember(key: string, count?: number, withScores?: boolean): Promise<string | string[] | Array<[string, string]> | null>;
  /** ZREMRANGEBYRANK key start stop. */
  zRemRangeByRank(key: string, start: number, stop: number): Promise<number>;
  /** ZREMRANGEBYSCORE key min max. */
  zRemRangeByScore(key: string, min: string | number, max: string | number): Promise<number>;
  /** ZREMRANGEBYLEX key min max. */
  zRemRangeByLex(key: string, min: string, max: string): Promise<number>;
  /** ZDIFF numkeys key [key ...] [WITHSCORES]. */
  zDiff(keys: string[], withScores?: boolean): Promise<string[] | Array<[string, string]>>;
  /** ZINTER numkeys key [key ...] [WITHSCORES]. */
  zInter(keys: string[], withScores?: boolean): Promise<string[] | Array<[string, string]>>;
  /** ZUNION numkeys key [key ...] [WITHSCORES]. */
  zUnion(keys: string[], withScores?: boolean): Promise<string[] | Array<[string, string]>>;
  /** ZDIFFSTORE destination numkeys key [key ...]. */
  zDiffStore(destination: string, keys: string[]): Promise<number>;
  /** ZINTERSTORE destination numkeys key [key ...] [WEIGHTS w ...] [AGGREGATE SUM|MIN|MAX]. */
  zInterStore(destination: string, keys: string[], opts?: { weights?: number[]; aggregate?: "SUM" | "MIN" | "MAX" }): Promise<number>;
  /** ZUNIONSTORE destination numkeys key [key ...] [WEIGHTS w ...] [AGGREGATE SUM|MIN|MAX]. */
  zUnionStore(destination: string, keys: string[], opts?: { weights?: number[]; aggregate?: "SUM" | "MIN" | "MAX" }): Promise<number>;
  /** ZINTERCARD numkeys key [key ...] [LIMIT limit]. */
  zInterCard(keys: string[], limit?: number): Promise<number>;
}

export function installZSetCommands(proto: object): void {
  Object.assign(proto, {
    async zAdd(this: Executor, key: string, entries: Array<[CommandArg, string | number]>, opts?: ZAddOptions) {
      const reply = await this.execute(zAddArgs(key, entries, opts));
      // Plain ZADD replies with a count; INCR replies with the member's
      // new score (a double, possibly fractional) or nil if NX/XX/GT/LT
      // aborted the update.
      return opts?.incr ? numOrNull(reply) : num(reply);
    },
    async zIncrBy(this: Executor, key: string, increment: number, member: CommandArg) {
      return strOrNull(await this.execute(["ZINCRBY", key, increment, member])) ?? "0";
    },
    async zRem(this: Executor, key: string, ...members: CommandArg[]) {
      return num(await this.execute(["ZREM", key, ...members]));
    },
    async zScore(this: Executor, key: string, member: CommandArg) {
      return strOrNull(await this.execute(["ZSCORE", key, member]));
    },
    async zmScore(this: Executor, key: string, ...members: CommandArg[]) {
      return arr(await this.execute(["ZMSCORE", key, ...members])).map((v) => (v === null ? null : str(v)));
    },
    async zCard(this: Executor, key: string) {
      return num(await this.execute(["ZCARD", key]));
    },
    async zCount(this: Executor, key: string, min: string | number, max: string | number) {
      return num(await this.execute(["ZCOUNT", key, min, max]));
    },
    async zLexCount(this: Executor, key: string, min: string, max: string) {
      return num(await this.execute(["ZLEXCOUNT", key, min, max]));
    },
    async zRank(this: Executor, key: string, member: CommandArg, withScore?: boolean) {
      const args: CommandArg[] = ["ZRANK", key, member];
      if (withScore) args.push("WITHSCORE");
      const reply = await this.execute(args);
      if (reply === null) return null;
      if (withScore) {
        const [rank, score] = arr(reply);
        return [num(rank as RespValue), str(score as RespValue)] as [number, string];
      }
      return num(reply);
    },
    async zRevRank(this: Executor, key: string, member: CommandArg, withScore?: boolean) {
      const args: CommandArg[] = ["ZREVRANK", key, member];
      if (withScore) args.push("WITHSCORE");
      const reply = await this.execute(args);
      if (reply === null) return null;
      if (withScore) {
        const [rank, score] = arr(reply);
        return [num(rank as RespValue), str(score as RespValue)] as [number, string];
      }
      return num(reply);
    },
    async zRange(this: Executor, key: string, start: string, stop: string, opts?: ZRangeOptions) {
      const args: CommandArg[] = ["ZRANGE", key, start, stop];
      if (opts?.byScore) args.push("BYSCORE");
      if (opts?.byLex) args.push("BYLEX");
      if (opts?.rev) args.push("REV");
      if (opts?.limit) args.push("LIMIT", opts.limit.offset, opts.limit.count);
      if (opts?.withScores) args.push("WITHSCORES");
      return pairsToTuples(await this.execute(args), Boolean(opts?.withScores));
    },
    async zRangeStore(this: Executor, destination: string, source: string, min: string, max: string, opts?: ZRangeStoreOptions) {
      const args: CommandArg[] = ["ZRANGESTORE", destination, source, min, max];
      if (opts?.byScore) args.push("BYSCORE");
      if (opts?.byLex) args.push("BYLEX");
      if (opts?.rev) args.push("REV");
      if (opts?.limit) args.push("LIMIT", opts.limit.offset, opts.limit.count);
      return num(await this.execute(args));
    },
    async zRangeByScore(
      this: Executor,
      key: string,
      min: string | number,
      max: string | number,
      opts?: { limit?: { offset: number; count: number }; withScores?: boolean },
    ) {
      const args: CommandArg[] = ["ZRANGEBYSCORE", key, min, max];
      if (opts?.limit) args.push("LIMIT", opts.limit.offset, opts.limit.count);
      if (opts?.withScores) args.push("WITHSCORES");
      return pairsToTuples(await this.execute(args), Boolean(opts?.withScores));
    },
    async zRevRangeByScore(
      this: Executor,
      key: string,
      max: string | number,
      min: string | number,
      opts?: { limit?: { offset: number; count: number }; withScores?: boolean },
    ) {
      const args: CommandArg[] = ["ZREVRANGEBYSCORE", key, max, min];
      if (opts?.limit) args.push("LIMIT", opts.limit.offset, opts.limit.count);
      if (opts?.withScores) args.push("WITHSCORES");
      return pairsToTuples(await this.execute(args), Boolean(opts?.withScores));
    },
    async zRevRange(this: Executor, key: string, start: number, stop: number, withScores?: boolean) {
      const args: CommandArg[] = ["ZREVRANGE", key, start, stop];
      if (withScores) args.push("WITHSCORES");
      return pairsToTuples(await this.execute(args), Boolean(withScores));
    },
    async zRangeByLex(this: Executor, key: string, min: string, max: string, limit?: { offset: number; count: number }) {
      const args: CommandArg[] = ["ZRANGEBYLEX", key, min, max];
      if (limit) args.push("LIMIT", limit.offset, limit.count);
      return strArr(await this.execute(args));
    },
    async zRevRangeByLex(this: Executor, key: string, max: string, min: string, limit?: { offset: number; count: number }) {
      const args: CommandArg[] = ["ZREVRANGEBYLEX", key, max, min];
      if (limit) args.push("LIMIT", limit.offset, limit.count);
      return strArr(await this.execute(args));
    },
    async zPopMin(this: Executor, key: string, count?: number) {
      const args: CommandArg[] = count === undefined ? ["ZPOPMIN", key] : ["ZPOPMIN", key, count];
      return pairsToTuples(await this.execute(args), true) as Array<[string, string]>;
    },
    async zPopMax(this: Executor, key: string, count?: number) {
      const args: CommandArg[] = count === undefined ? ["ZPOPMAX", key] : ["ZPOPMAX", key, count];
      return pairsToTuples(await this.execute(args), true) as Array<[string, string]>;
    },
    async bzPopMin(this: Executor, keys: string[], timeoutSeconds: number) {
      const reply = await this.execute(["BZPOPMIN", ...keys, timeoutSeconds]);
      if (reply === null) return null;
      const [k, m, s] = arr(reply);
      return [str(k as RespValue), str(m as RespValue), str(s as RespValue)] as [string, string, string];
    },
    async bzPopMax(this: Executor, keys: string[], timeoutSeconds: number) {
      const reply = await this.execute(["BZPOPMAX", ...keys, timeoutSeconds]);
      if (reply === null) return null;
      const [k, m, s] = arr(reply);
      return [str(k as RespValue), str(m as RespValue), str(s as RespValue)] as [string, string, string];
    },
    async zRandMember(this: Executor, key: string, count?: number, withScores?: boolean) {
      if (count === undefined) return strOrNull(await this.execute(["ZRANDMEMBER", key]));
      const args: CommandArg[] = ["ZRANDMEMBER", key, count];
      if (withScores) args.push("WITHSCORES");
      return pairsToTuples(await this.execute(args), Boolean(withScores));
    },
    async zRemRangeByRank(this: Executor, key: string, start: number, stop: number) {
      return num(await this.execute(["ZREMRANGEBYRANK", key, start, stop]));
    },
    async zRemRangeByScore(this: Executor, key: string, min: string | number, max: string | number) {
      return num(await this.execute(["ZREMRANGEBYSCORE", key, min, max]));
    },
    async zRemRangeByLex(this: Executor, key: string, min: string, max: string) {
      return num(await this.execute(["ZREMRANGEBYLEX", key, min, max]));
    },
    async zDiff(this: Executor, keys: string[], withScores?: boolean) {
      const args: CommandArg[] = ["ZDIFF", keys.length, ...keys];
      if (withScores) args.push("WITHSCORES");
      return pairsToTuples(await this.execute(args), Boolean(withScores));
    },
    async zInter(this: Executor, keys: string[], withScores?: boolean) {
      const args: CommandArg[] = ["ZINTER", keys.length, ...keys];
      if (withScores) args.push("WITHSCORES");
      return pairsToTuples(await this.execute(args), Boolean(withScores));
    },
    async zUnion(this: Executor, keys: string[], withScores?: boolean) {
      const args: CommandArg[] = ["ZUNION", keys.length, ...keys];
      if (withScores) args.push("WITHSCORES");
      return pairsToTuples(await this.execute(args), Boolean(withScores));
    },
    async zDiffStore(this: Executor, destination: string, keys: string[]) {
      return num(await this.execute(["ZDIFFSTORE", destination, keys.length, ...keys]));
    },
    async zInterStore(
      this: Executor,
      destination: string,
      keys: string[],
      opts?: { weights?: number[]; aggregate?: "SUM" | "MIN" | "MAX" },
    ) {
      const args: CommandArg[] = ["ZINTERSTORE", destination, keys.length, ...keys];
      if (opts?.weights) args.push("WEIGHTS", ...opts.weights);
      if (opts?.aggregate) args.push("AGGREGATE", opts.aggregate);
      return num(await this.execute(args));
    },
    async zUnionStore(
      this: Executor,
      destination: string,
      keys: string[],
      opts?: { weights?: number[]; aggregate?: "SUM" | "MIN" | "MAX" },
    ) {
      const args: CommandArg[] = ["ZUNIONSTORE", destination, keys.length, ...keys];
      if (opts?.weights) args.push("WEIGHTS", ...opts.weights);
      if (opts?.aggregate) args.push("AGGREGATE", opts.aggregate);
      return num(await this.execute(args));
    },
    async zInterCard(this: Executor, keys: string[], limit?: number) {
      const args: CommandArg[] = ["ZINTERCARD", keys.length, ...keys];
      if (limit !== undefined) args.push("LIMIT", limit);
      return num(await this.execute(args));
    },
  });
}
