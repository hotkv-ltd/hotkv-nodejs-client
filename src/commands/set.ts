// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { arr, bool01, num, str, strArr } from "../resp/decode.js";
import type { CommandArg } from "../resp/types.js";

export interface SetCommands {
  /** SADD key member [member ...]: number newly added. */
  sAdd(key: string, ...members: CommandArg[]): Promise<number>;
  /** SREM key member [member ...]: number removed. */
  sRem(key: string, ...members: CommandArg[]): Promise<number>;
  /** SMEMBERS key. */
  sMembers(key: string): Promise<string[]>;
  /** SISMEMBER key member. */
  sIsMember(key: string, member: CommandArg): Promise<boolean>;
  /** SMISMEMBER key member [member ...]. */
  sMIsMember(key: string, ...members: CommandArg[]): Promise<boolean[]>;
  /** SCARD key. */
  sCard(key: string): Promise<number>;
  /** SPOP key [count]. */
  sPop(key: string, count?: number): Promise<string | string[] | null>;
  /** SRANDMEMBER key [count]. */
  sRandMember(key: string, count?: number): Promise<string | string[] | null>;
  /** SMOVE source destination member. */
  sMove(source: string, destination: string, member: CommandArg): Promise<boolean>;
  /** SINTER key [key ...]. */
  sInter(...keys: string[]): Promise<string[]>;
  /** SUNION key [key ...]. */
  sUnion(...keys: string[]): Promise<string[]>;
  /** SDIFF key [key ...]. */
  sDiff(...keys: string[]): Promise<string[]>;
  /** SINTERSTORE destination key [key ...]: size of the stored result. */
  sInterStore(destination: string, ...keys: string[]): Promise<number>;
  /** SUNIONSTORE destination key [key ...]. */
  sUnionStore(destination: string, ...keys: string[]): Promise<number>;
  /** SDIFFSTORE destination key [key ...]. */
  sDiffStore(destination: string, ...keys: string[]): Promise<number>;
  /** SINTERCARD numkeys key [key ...] [LIMIT limit]. */
  sInterCard(keys: string[], limit?: number): Promise<number>;
}

export function installSetCommands(proto: object): void {
  Object.assign(proto, {
    async sAdd(this: Executor, key: string, ...members: CommandArg[]) {
      return num(await this.execute(["SADD", key, ...members]));
    },
    async sRem(this: Executor, key: string, ...members: CommandArg[]) {
      return num(await this.execute(["SREM", key, ...members]));
    },
    async sMembers(this: Executor, key: string) {
      return strArr(await this.execute(["SMEMBERS", key]));
    },
    async sIsMember(this: Executor, key: string, member: CommandArg) {
      return bool01(await this.execute(["SISMEMBER", key, member]));
    },
    async sMIsMember(this: Executor, key: string, ...members: CommandArg[]) {
      return arr(await this.execute(["SMISMEMBER", key, ...members])).map(bool01);
    },
    async sCard(this: Executor, key: string) {
      return num(await this.execute(["SCARD", key]));
    },
    async sPop(this: Executor, key: string, count?: number) {
      const args: CommandArg[] = count === undefined ? ["SPOP", key] : ["SPOP", key, count];
      const reply = await this.execute(args);
      if (reply === null) return null;
      return Array.isArray(reply) ? strArr(reply) : str(reply);
    },
    async sRandMember(this: Executor, key: string, count?: number) {
      const args: CommandArg[] = count === undefined ? ["SRANDMEMBER", key] : ["SRANDMEMBER", key, count];
      const reply = await this.execute(args);
      if (reply === null) return null;
      return Array.isArray(reply) ? strArr(reply) : str(reply);
    },
    async sMove(this: Executor, source: string, destination: string, member: CommandArg) {
      return bool01(await this.execute(["SMOVE", source, destination, member]));
    },
    async sInter(this: Executor, ...keys: string[]) {
      return strArr(await this.execute(["SINTER", ...keys]));
    },
    async sUnion(this: Executor, ...keys: string[]) {
      return strArr(await this.execute(["SUNION", ...keys]));
    },
    async sDiff(this: Executor, ...keys: string[]) {
      return strArr(await this.execute(["SDIFF", ...keys]));
    },
    async sInterStore(this: Executor, destination: string, ...keys: string[]) {
      return num(await this.execute(["SINTERSTORE", destination, ...keys]));
    },
    async sUnionStore(this: Executor, destination: string, ...keys: string[]) {
      return num(await this.execute(["SUNIONSTORE", destination, ...keys]));
    },
    async sDiffStore(this: Executor, destination: string, ...keys: string[]) {
      return num(await this.execute(["SDIFFSTORE", destination, ...keys]));
    },
    async sInterCard(this: Executor, keys: string[], limit?: number) {
      const args: CommandArg[] = ["SINTERCARD", keys.length, ...keys];
      if (limit !== undefined) args.push("LIMIT", limit);
      return num(await this.execute(args));
    },
  });
}
