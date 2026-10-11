// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Typed wrappers for HotKV's own core command families (no license needed):
// TAG.*, NEXPIRE/NTTL/NEXPIREAT, HOTKEYS, GCRA.*, VSIM.* (including the
// license gated persistence subcommands).

import type { Executor } from "../executor.js";
import { formatVectorComponent } from "../internal/numbers.js";
import { arr, bool01, bufOrNull, num, pairsToObject, str, strArr } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

export type VectorMetric = "cosine" | "l2" | "ip";

export interface VSimCreateIndexOptions {
  metric?: VectorMetric;
  m?: number;
  efConstruction?: number;
  efSearch?: number;
}

export interface VSimSearchOptions {
  filter?: string[];
  ef?: number;
}

export interface VSimIndexInfo {
  name: string;
  dimensions: number;
  metric: string;
  vectors: number;
  m: number;
  efConstruction: number;
  efSearch: number;
}

export interface VSimSearchResult {
  key: string;
  distance: number;
}

export interface GcraResult {
  denied: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  resetAfterMs: number;
}

export interface HotKeyEntry {
  key: string;
  count: number;
}

function vecArgs(values: number[]): CommandArg[] {
  return values.map((v) => formatVectorComponent(v));
}

export interface HotKVCoreCommands {
  // TAG.*
  /** TAG.SET key tag [tag ...]: number of tags newly added. Errors if key does not exist. */
  tagSet(key: string, ...tags: string[]): Promise<number>;
  /** TAG.REM key tag [tag ...]: number of tags removed. */
  tagRem(key: string, ...tags: string[]): Promise<number>;
  /** TAG.GET key: all tags on key. */
  tagGet(key: string): Promise<string[]>;
  /** TAG.MEMBERS tag: all keys carrying tag. */
  tagMembers(tag: string): Promise<string[]>;
  /** TAG.INTER tag [tag ...]: keys carrying every given tag. */
  tagInter(...tags: string[]): Promise<string[]>;
  /** TAG.COUNT key: number of tags on key. */
  tagCount(key: string): Promise<number>;
  /** TAG.EXISTS key tag. */
  tagExists(key: string, tag: string): Promise<boolean>;

  // NEXPIRE / NTTL / NEXPIREAT
  /** NEXPIRE key nanoseconds: a relative, nanosecond resolution TTL. */
  nExpire(key: string, nanoseconds: bigint | number): Promise<boolean>;
  /** NTTL key: remaining TTL in nanoseconds, -2 if absent, -1 if no TTL. */
  nTtl(key: string): Promise<bigint>;
  /** NEXPIREAT key nanosecond-unix-timestamp. */
  nExpireAt(key: string, nanosecondUnixTimestamp: bigint | number): Promise<boolean>;

  // HOTKEYS
  /** HOTKEYS TOP [count]: the most frequently accessed keys, most first. */
  hotKeysTop(count?: number): Promise<HotKeyEntry[]>;
  /** HOTKEYS RESET. */
  hotKeysReset(): Promise<void>;

  // GCRA.*
  /** GCRA.LIMIT key periodMs burst [count]. */
  gcraLimit(key: string, periodMs: number, burst: number, count?: number): Promise<GcraResult>;
  /** GCRA.RESET key [key ...]: number of keys that had state and were reset. */
  gcraReset(...keys: string[]): Promise<number>;

  // VSIM.* (core)
  /** VSIM.CREATEINDEX name dims [METRIC ...] [M ...] [EF_CONSTRUCTION ...] [EF_SEARCH ...]. */
  vsimCreateIndex(name: string, dims: number, opts?: VSimCreateIndexOptions): Promise<void>;
  /** VSIM.DROPINDEX name. */
  vsimDropIndex(name: string): Promise<void>;
  /** VSIM.SET index key val1 ... valN: whether it was newly inserted. */
  vsimSet(index: string, key: string, vector: number[]): Promise<boolean>;
  /** VSIM.GET index key. */
  vsimGet(index: string, key: string): Promise<number[] | null>;
  /** VSIM.DEL index key. */
  vsimDel(index: string, key: string): Promise<boolean>;
  /** VSIM.SEARCH index k val1 ... valN [FILTER tag ...] [EF ef]. */
  vsimSearch(index: string, k: number, vector: number[], opts?: VSimSearchOptions): Promise<VSimSearchResult[]>;
  /** VSIM.INFO: every index name. */
  vsimInfoNames(): Promise<string[]>;
  /** VSIM.INFO index: that index's configuration and size. */
  vsimInfo(index: string): Promise<VSimIndexInfo>;

  // VSIM persistence (needs a license with the vsimpersist feature)
  /** VSIM.SAVE snapshotName blob: bytes written. */
  vsimSave(snapshotName: string, blob: Buffer): Promise<number>;
  /** VSIM.LOAD snapshotName. */
  vsimLoad(snapshotName: string): Promise<Buffer | null>;
  /** VSIM.LIST: snapshot names. */
  vsimList(): Promise<string[]>;
  /** VSIM.DROP snapshotName. */
  vsimSnapshotDrop(snapshotName: string): Promise<boolean>;
}

export function installHotKVCoreCommands(proto: object): void {
  Object.assign(proto, {
    async tagSet(this: Executor, key: string, ...tags: string[]) {
      return num(await this.execute(["TAG.SET", key, ...tags]));
    },
    async tagRem(this: Executor, key: string, ...tags: string[]) {
      return num(await this.execute(["TAG.REM", key, ...tags]));
    },
    async tagGet(this: Executor, key: string) {
      return strArr(await this.execute(["TAG.GET", key]));
    },
    async tagMembers(this: Executor, tag: string) {
      return strArr(await this.execute(["TAG.MEMBERS", tag]));
    },
    async tagInter(this: Executor, ...tags: string[]) {
      return strArr(await this.execute(["TAG.INTER", ...tags]));
    },
    async tagCount(this: Executor, key: string) {
      return num(await this.execute(["TAG.COUNT", key]));
    },
    async tagExists(this: Executor, key: string, tag: string) {
      return bool01(await this.execute(["TAG.EXISTS", key, tag]));
    },

    async nExpire(this: Executor, key: string, nanoseconds: bigint | number) {
      return bool01(await this.execute(["NEXPIRE", key, String(nanoseconds)]));
    },
    async nTtl(this: Executor, key: string) {
      const v = await this.execute(["NTTL", key]);
      return typeof v === "bigint" ? v : BigInt(num(v));
    },
    async nExpireAt(this: Executor, key: string, nanosecondUnixTimestamp: bigint | number) {
      return bool01(await this.execute(["NEXPIREAT", key, String(nanosecondUnixTimestamp)]));
    },

    async hotKeysTop(this: Executor, count?: number) {
      const args: CommandArg[] = count === undefined ? ["HOTKEYS", "TOP"] : ["HOTKEYS", "TOP", count];
      return arr(await this.execute(args)).map((pair) => {
        const [key, cnt] = arr(pair);
        return { key: str(key as RespValue), count: num(cnt as RespValue) } satisfies HotKeyEntry;
      });
    },
    async hotKeysReset(this: Executor) {
      await this.execute(["HOTKEYS", "RESET"]);
    },

    async gcraLimit(this: Executor, key: string, periodMs: number, burst: number, count?: number) {
      const args: CommandArg[] = ["GCRA.LIMIT", key, periodMs, burst];
      if (count !== undefined) args.push(count);
      const [denied, limit, remaining, retryAfterMs, resetAfterMs] = arr(await this.execute(args));
      return {
        denied: num(denied as RespValue) === 1,
        limit: num(limit as RespValue),
        remaining: num(remaining as RespValue),
        retryAfterMs: num(retryAfterMs as RespValue),
        resetAfterMs: num(resetAfterMs as RespValue),
      } satisfies GcraResult;
    },
    async gcraReset(this: Executor, ...keys: string[]) {
      return num(await this.execute(["GCRA.RESET", ...keys]));
    },

    async vsimCreateIndex(this: Executor, name: string, dims: number, opts?: VSimCreateIndexOptions) {
      const args: CommandArg[] = ["VSIM.CREATEINDEX", name, dims];
      if (opts?.metric) args.push("METRIC", opts.metric);
      if (opts?.m !== undefined) args.push("M", opts.m);
      if (opts?.efConstruction !== undefined) args.push("EF_CONSTRUCTION", opts.efConstruction);
      if (opts?.efSearch !== undefined) args.push("EF_SEARCH", opts.efSearch);
      await this.execute(args);
    },
    async vsimDropIndex(this: Executor, name: string) {
      await this.execute(["VSIM.DROPINDEX", name]);
    },
    async vsimSet(this: Executor, index: string, key: string, vector: number[]) {
      return num(await this.execute(["VSIM.SET", index, key, ...vecArgs(vector)])) === 1;
    },
    async vsimGet(this: Executor, index: string, key: string) {
      const reply = await this.execute(["VSIM.GET", index, key]);
      return reply === null ? null : arr(reply).map(num);
    },
    async vsimDel(this: Executor, index: string, key: string) {
      return num(await this.execute(["VSIM.DEL", index, key])) === 1;
    },
    async vsimSearch(this: Executor, index: string, k: number, vector: number[], opts?: VSimSearchOptions) {
      const args: CommandArg[] = ["VSIM.SEARCH", index, k, ...vecArgs(vector)];
      if (opts?.filter && opts.filter.length > 0) args.push("FILTER", ...opts.filter);
      if (opts?.ef !== undefined) args.push("EF", opts.ef);
      const flat = arr(await this.execute(args));
      const out: VSimSearchResult[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        out.push({ key: str(flat[i] as RespValue), distance: num(flat[i + 1] as RespValue) });
      }
      return out;
    },
    async vsimInfoNames(this: Executor) {
      return strArr(await this.execute(["VSIM.INFO"]));
    },
    async vsimInfo(this: Executor, index: string) {
      const o = pairsToObject((await this.execute(["VSIM.INFO", index])));
      return {
        name: str(o.name as RespValue),
        dimensions: num(o.dimensions as RespValue),
        metric: str(o.metric as RespValue),
        vectors: num(o.vectors as RespValue),
        m: num(o.M as RespValue),
        efConstruction: num(o.ef_construction as RespValue),
        efSearch: num(o.ef_search as RespValue),
      } satisfies VSimIndexInfo;
    },

    async vsimSave(this: Executor, snapshotName: string, blob: Buffer) {
      return num(await this.execute(["VSIM.SAVE", snapshotName, blob]));
    },
    async vsimLoad(this: Executor, snapshotName: string) {
      return bufOrNull(await this.execute(["VSIM.LOAD", snapshotName]));
    },
    async vsimList(this: Executor) {
      return strArr(await this.execute(["VSIM.LIST"]));
    },
    async vsimSnapshotDrop(this: Executor, snapshotName: string) {
      return num(await this.execute(["VSIM.DROP", snapshotName])) === 1;
    },
  });
}
