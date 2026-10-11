// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { bool01, bufOrNull, num, strArr, strOrNull } from "../resp/decode.js";
import type { CommandArg } from "../resp/types.js";

export interface GenericCommands {
  /** DEL key [key ...]: number of keys removed. */
  del(...keys: string[]): Promise<number>;
  /** UNLINK key [key ...]: like DEL but reclaims memory asynchronously on the server. */
  unlink(...keys: string[]): Promise<number>;
  /** EXISTS key [key ...]: how many of the given keys exist (a key repeated twice counts twice). */
  exists(...keys: string[]): Promise<number>;
  /** EXPIRE key seconds: set a TTL. Returns whether it was set. */
  expire(key: string, seconds: number): Promise<boolean>;
  /** PEXPIRE key milliseconds. */
  pExpire(key: string, milliseconds: number): Promise<boolean>;
  /** EXPIREAT key unix-seconds. */
  expireAt(key: string, unixSeconds: number): Promise<boolean>;
  /** PEXPIREAT key unix-milliseconds. */
  pExpireAt(key: string, unixMilliseconds: number): Promise<boolean>;
  /** TTL key: seconds remaining, -1 if no TTL, -2 if the key does not exist. */
  ttl(key: string): Promise<number>;
  /** PTTL key: milliseconds remaining. */
  pTtl(key: string): Promise<number>;
  /** EXPIRETIME key: Unix time in seconds the key expires at. */
  expireTime(key: string): Promise<number>;
  /** PEXPIRETIME key: Unix time in milliseconds. */
  pExpireTime(key: string): Promise<number>;
  /** PERSIST key: remove its TTL. Returns whether one was removed. */
  persist(key: string): Promise<boolean>;
  /** TYPE key: the value's type name ("none" if absent). */
  type(key: string): Promise<string>;
  /** RENAME key newkey. */
  rename(key: string, newKey: string): Promise<void>;
  /** RENAMENX key newkey: rename only if newkey does not exist. */
  renameNX(key: string, newKey: string): Promise<boolean>;
  /** COPY source destination [REPLACE]. */
  copy(source: string, destination: string, opts?: { db?: number; replace?: boolean }): Promise<boolean>;
  /** KEYS pattern: matching key names. Prefer scanIterator() on a large keyspace. */
  keys(pattern: string): Promise<string[]>;
  /** RANDOMKEY: a random key name, or null if the database is empty. */
  randomKey(): Promise<string | null>;
  /** TOUCH key [key ...]: refresh access time, returns how many keys existed. */
  touch(...keys: string[]): Promise<number>;
  /** DUMP key: a serialized representation, or null. */
  dump(key: string): Promise<Buffer | null>;
  /** RESTORE key ttl serialized-value [REPLACE]. */
  restore(key: string, ttlMs: number, value: Buffer, opts?: { replace?: boolean }): Promise<void>;
  /** MOVE key db. */
  move(key: string, db: number): Promise<boolean>;
}

export function installGenericCommands(proto: object): void {
  Object.assign(proto, {
    async del(this: Executor, ...keys: string[]) {
      return num(await this.execute(["DEL", ...keys]));
    },
    async unlink(this: Executor, ...keys: string[]) {
      return num(await this.execute(["UNLINK", ...keys]));
    },
    async exists(this: Executor, ...keys: string[]) {
      return num(await this.execute(["EXISTS", ...keys]));
    },
    async expire(this: Executor, key: string, seconds: number) {
      return bool01(await this.execute(["EXPIRE", key, seconds]));
    },
    async pExpire(this: Executor, key: string, milliseconds: number) {
      return bool01(await this.execute(["PEXPIRE", key, milliseconds]));
    },
    async expireAt(this: Executor, key: string, unixSeconds: number) {
      return bool01(await this.execute(["EXPIREAT", key, unixSeconds]));
    },
    async pExpireAt(this: Executor, key: string, unixMilliseconds: number) {
      return bool01(await this.execute(["PEXPIREAT", key, unixMilliseconds]));
    },
    async ttl(this: Executor, key: string) {
      return num(await this.execute(["TTL", key]));
    },
    async pTtl(this: Executor, key: string) {
      return num(await this.execute(["PTTL", key]));
    },
    async expireTime(this: Executor, key: string) {
      return num(await this.execute(["EXPIRETIME", key]));
    },
    async pExpireTime(this: Executor, key: string) {
      return num(await this.execute(["PEXPIRETIME", key]));
    },
    async persist(this: Executor, key: string) {
      return bool01(await this.execute(["PERSIST", key]));
    },
    async type(this: Executor, key: string) {
      return strOrNull(await this.execute(["TYPE", key])) ?? "none";
    },
    async rename(this: Executor, key: string, newKey: string) {
      await this.execute(["RENAME", key, newKey]);
    },
    async renameNX(this: Executor, key: string, newKey: string) {
      return bool01(await this.execute(["RENAMENX", key, newKey]));
    },
    async copy(this: Executor, source: string, destination: string, opts?: { db?: number; replace?: boolean }) {
      const args: CommandArg[] = ["COPY", source, destination];
      if (opts?.db !== undefined) args.push("DB", opts.db);
      if (opts?.replace) args.push("REPLACE");
      return bool01(await this.execute(args));
    },
    async keys(this: Executor, pattern: string) {
      return strArr(await this.execute(["KEYS", pattern]));
    },
    async randomKey(this: Executor) {
      return strOrNull(await this.execute(["RANDOMKEY"]));
    },
    async touch(this: Executor, ...keys: string[]) {
      return num(await this.execute(["TOUCH", ...keys]));
    },
    async dump(this: Executor, key: string) {
      return bufOrNull(await this.execute(["DUMP", key]));
    },
    async restore(this: Executor, key: string, ttlMs: number, value: Buffer, opts?: { replace?: boolean }) {
      const args: CommandArg[] = ["RESTORE", key, ttlMs, value];
      if (opts?.replace) args.push("REPLACE");
      await this.execute(args);
    },
    async move(this: Executor, key: string, db: number) {
      return bool01(await this.execute(["MOVE", key, db]));
    },
  });
}
