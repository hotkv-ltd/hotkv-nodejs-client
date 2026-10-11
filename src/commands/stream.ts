// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { arr, arrOrEmpty, num, pairsToPlainObject, pairsToStrObject, str, strArr, strOrNull } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export interface TrimOptions {
  strategy: "MAXLEN" | "MINID";
  threshold: string | number;
  /** Exact trimming ('='), the default, or approximate/faster trimming ('~'). */
  exact?: boolean;
  limit?: number;
}

export interface XAddOptions extends Partial<TrimOptions> {
  id?: string;
  noMkStream?: boolean;
}

export interface PendingSummary {
  count: number;
  minId: string | null;
  maxId: string | null;
  consumers: Array<{ name: string; count: number }>;
}

export interface PendingEntry {
  id: string;
  consumer: string;
  idleMs: number;
  deliveryCount: number;
}

function decodeEntry(v: RespValue): StreamEntry {
  const [id, fields] = arr(v);
  return { id: str(id as RespValue), fields: pairsToStrObject((fields as RespValue)) };
}

function decodeEntries(v: RespValue): StreamEntry[] {
  return arrOrEmpty(v).map(decodeEntry);
}

function decodeStreamsReply(v: RespValue): Record<string, StreamEntry[]> | null {
  if (v === null) return null;
  const out: Record<string, StreamEntry[]> = {};
  if (v instanceof Map) {
    for (const [k, val] of v) out[str(k)] = decodeEntries(val);
    return out;
  }
  for (const pair of arr(v)) {
    const [name, entries] = arr(pair);
    out[str(name as RespValue)] = decodeEntries(entries as RespValue);
  }
  return out;
}

function trimArgs(opts: Partial<TrimOptions> | undefined): CommandArg[] {
  if (!opts?.strategy || opts.threshold === undefined) return [];
  const args: CommandArg[] = [opts.strategy, opts.exact === false ? "~" : "=", opts.threshold];
  if (opts.limit !== undefined) args.push("LIMIT", opts.limit);
  return args;
}

export interface StreamCommands {
  /** XADD key [NOMKSTREAM] [MAXLEN|MINID ...] id-or-* field value [...]: the entry ID. */
  xAdd(key: string, fields: Record<string, CommandArg>, opts?: XAddOptions): Promise<string>;
  /** XLEN key. */
  xLen(key: string): Promise<number>;
  /** XRANGE key start end [COUNT count]. */
  xRange(key: string, start: string, end: string, count?: number): Promise<StreamEntry[]>;
  /** XREVRANGE key end start [COUNT count]. */
  xRevRange(key: string, end: string, start: string, count?: number): Promise<StreamEntry[]>;
  /** XDEL key id [id ...]. */
  xDel(key: string, ...ids: string[]): Promise<number>;
  /** XTRIM key MAXLEN|MINID ... */
  xTrim(key: string, opts: TrimOptions): Promise<number>;
  /** XREAD [COUNT n] [BLOCK ms] STREAMS key [key ...] id [id ...]. */
  xRead(
    streams: Record<string, string>,
    opts?: { count?: number; blockMs?: number },
  ): Promise<Record<string, StreamEntry[]> | null>;
  /** XREADGROUP GROUP group consumer [COUNT n] [BLOCK ms] [NOACK] STREAMS key [key ...] id [id ...]. */
  xReadGroup(
    group: string,
    consumer: string,
    streams: Record<string, string>,
    opts?: { count?: number; blockMs?: number; noAck?: boolean },
  ): Promise<Record<string, StreamEntry[]> | null>;
  /** XACK key group id [id ...]. */
  xAck(key: string, group: string, ...ids: string[]): Promise<number>;
  /** XGROUP CREATE key group id-or-$ [MKSTREAM]. */
  xGroupCreate(key: string, group: string, id?: string, mkStream?: boolean): Promise<void>;
  /** XGROUP DESTROY key group. */
  xGroupDestroy(key: string, group: string): Promise<boolean>;
  /** XGROUP CREATECONSUMER key group consumer. */
  xGroupCreateConsumer(key: string, group: string, consumer: string): Promise<boolean>;
  /** XGROUP DELCONSUMER key group consumer: pending entries that consumer owned. */
  xGroupDelConsumer(key: string, group: string, consumer: string): Promise<number>;
  /** XGROUP SETID key group id-or-$. */
  xGroupSetId(key: string, group: string, id: string): Promise<void>;
  /** XPENDING key group: the summary form. */
  xPending(key: string, group: string): Promise<PendingSummary>;
  /** XPENDING key group start end count [consumer] [IDLE min-idle]: the detailed form. */
  xPendingRange(
    key: string,
    group: string,
    start: string,
    end: string,
    count: number,
    opts?: { consumer?: string; idleMs?: number },
  ): Promise<PendingEntry[]>;
  /** XCLAIM key group consumer min-idle-time id [id ...] [options]. */
  xClaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    ids: string[],
    opts?: { idle?: number; time?: number; retryCount?: number; force?: boolean; justId?: boolean },
  ): Promise<StreamEntry[] | string[]>;
  /** XAUTOCLAIM key group consumer min-idle-time start [COUNT n] [JUSTID]. */
  xAutoClaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    start: string,
    opts?: { count?: number; justId?: boolean },
  ): Promise<{ cursor: string; entries: StreamEntry[] | string[]; deletedIds: string[] }>;
  /** XINFO STREAM key [FULL]. */
  xInfoStream(key: string, full?: boolean): Promise<Record<string, unknown>>;
  /** XINFO GROUPS key. */
  xInfoGroups(key: string): Promise<Array<Record<string, unknown>>>;
  /** XINFO CONSUMERS key group. */
  xInfoConsumers(key: string, group: string): Promise<Array<Record<string, unknown>>>;
}

export function installStreamCommands(proto: object): void {
  Object.assign(proto, {
    async xAdd(this: Executor, key: string, fields: Record<string, CommandArg>, opts?: XAddOptions) {
      const args: CommandArg[] = ["XADD", key];
      if (opts?.noMkStream) args.push("NOMKSTREAM");
      args.push(...trimArgs(opts));
      args.push(opts?.id ?? "*");
      for (const [f, v] of Object.entries(fields)) args.push(f, v);
      return str(await this.execute(args));
    },
    async xLen(this: Executor, key: string) {
      return num(await this.execute(["XLEN", key]));
    },
    async xRange(this: Executor, key: string, start: string, end: string, count?: number) {
      const args: CommandArg[] = ["XRANGE", key, start, end];
      if (count !== undefined) args.push("COUNT", count);
      return decodeEntries(await this.execute(args));
    },
    async xRevRange(this: Executor, key: string, end: string, start: string, count?: number) {
      const args: CommandArg[] = ["XREVRANGE", key, end, start];
      if (count !== undefined) args.push("COUNT", count);
      return decodeEntries(await this.execute(args));
    },
    async xDel(this: Executor, key: string, ...ids: string[]) {
      return num(await this.execute(["XDEL", key, ...ids]));
    },
    async xTrim(this: Executor, key: string, opts: TrimOptions) {
      return num(await this.execute(["XTRIM", key, ...trimArgs(opts)]));
    },
    async xRead(this: Executor, streams: Record<string, string>, opts?: { count?: number; blockMs?: number }) {
      const args: CommandArg[] = ["XREAD"];
      if (opts?.count !== undefined) args.push("COUNT", opts.count);
      if (opts?.blockMs !== undefined) args.push("BLOCK", opts.blockMs);
      const names = Object.keys(streams);
      args.push("STREAMS", ...names, ...names.map((n) => streams[n] as string));
      return decodeStreamsReply(await this.execute(args));
    },
    async xReadGroup(
      this: Executor,
      group: string,
      consumer: string,
      streams: Record<string, string>,
      opts?: { count?: number; blockMs?: number; noAck?: boolean },
    ) {
      const args: CommandArg[] = ["XREADGROUP", "GROUP", group, consumer];
      if (opts?.count !== undefined) args.push("COUNT", opts.count);
      if (opts?.blockMs !== undefined) args.push("BLOCK", opts.blockMs);
      if (opts?.noAck) args.push("NOACK");
      const names = Object.keys(streams);
      args.push("STREAMS", ...names, ...names.map((n) => streams[n] as string));
      return decodeStreamsReply(await this.execute(args));
    },
    async xAck(this: Executor, key: string, group: string, ...ids: string[]) {
      return num(await this.execute(["XACK", key, group, ...ids]));
    },
    async xGroupCreate(this: Executor, key: string, group: string, id?: string, mkStream?: boolean) {
      const args: CommandArg[] = ["XGROUP", "CREATE", key, group, id ?? "$"];
      if (mkStream) args.push("MKSTREAM");
      await this.execute(args);
    },
    async xGroupDestroy(this: Executor, key: string, group: string) {
      return num(await this.execute(["XGROUP", "DESTROY", key, group])) === 1;
    },
    async xGroupCreateConsumer(this: Executor, key: string, group: string, consumer: string) {
      return num(await this.execute(["XGROUP", "CREATECONSUMER", key, group, consumer])) === 1;
    },
    async xGroupDelConsumer(this: Executor, key: string, group: string, consumer: string) {
      return num(await this.execute(["XGROUP", "DELCONSUMER", key, group, consumer]));
    },
    async xGroupSetId(this: Executor, key: string, group: string, id: string) {
      await this.execute(["XGROUP", "SETID", key, group, id]);
    },
    async xPending(this: Executor, key: string, group: string) {
      const [count, minId, maxId, consumers] = arr(await this.execute(["XPENDING", key, group]));
      return {
        count: num(count as RespValue),
        minId: minId === null ? null : str(minId as RespValue),
        maxId: maxId === null ? null : str(maxId as RespValue),
        consumers: arrOrEmpty(consumers as RespValue).map((c) => {
          const [name, cnt] = arr(c);
          return { name: str(name as RespValue), count: num(cnt as RespValue) };
        }),
      } satisfies PendingSummary;
    },
    async xPendingRange(
      this: Executor,
      key: string,
      group: string,
      start: string,
      end: string,
      count: number,
      opts?: { consumer?: string; idleMs?: number },
    ) {
      const args: CommandArg[] = ["XPENDING", key, group];
      if (opts?.idleMs !== undefined) args.push("IDLE", opts.idleMs);
      args.push(start, end, count);
      if (opts?.consumer !== undefined) args.push(opts.consumer);
      return arrOrEmpty(await this.execute(args)).map((e) => {
        const [id, consumer, idle, delivered] = arr(e);
        return {
          id: str(id as RespValue),
          consumer: str(consumer as RespValue),
          idleMs: num(idle as RespValue),
          deliveryCount: num(delivered as RespValue),
        } satisfies PendingEntry;
      });
    },
    async xClaim(
      this: Executor,
      key: string,
      group: string,
      consumer: string,
      minIdleMs: number,
      ids: string[],
      opts?: { idle?: number; time?: number; retryCount?: number; force?: boolean; justId?: boolean },
    ) {
      const args: CommandArg[] = ["XCLAIM", key, group, consumer, minIdleMs, ...ids];
      if (opts?.idle !== undefined) args.push("IDLE", opts.idle);
      if (opts?.time !== undefined) args.push("TIME", opts.time);
      if (opts?.retryCount !== undefined) args.push("RETRYCOUNT", opts.retryCount);
      if (opts?.force) args.push("FORCE");
      if (opts?.justId) args.push("JUSTID");
      const reply = await this.execute(args);
      return opts?.justId ? strArr(reply) : decodeEntries(reply);
    },
    async xAutoClaim(
      this: Executor,
      key: string,
      group: string,
      consumer: string,
      minIdleMs: number,
      start: string,
      opts?: { count?: number; justId?: boolean },
    ) {
      const args: CommandArg[] = ["XAUTOCLAIM", key, group, consumer, minIdleMs, start];
      if (opts?.count !== undefined) args.push("COUNT", opts.count);
      if (opts?.justId) args.push("JUSTID");
      const reply = arr(await this.execute(args));
      const cursor = str(reply[0] as RespValue);
      const entries = opts?.justId ? strArr(reply[1] as RespValue) : decodeEntries(reply[1] as RespValue);
      const deletedIds = reply.length > 2 ? strArr(reply[2] as RespValue) : [];
      return { cursor, entries, deletedIds };
    },
    async xInfoStream(this: Executor, key: string, full?: boolean) {
      const args: CommandArg[] = ["XINFO", "STREAM", key];
      if (full) args.push("FULL");
      return pairsToPlainObject((await this.execute(args)));
    },
    async xInfoGroups(this: Executor, key: string) {
      return arr(await this.execute(["XINFO", "GROUPS", key])).map((g) => pairsToPlainObject((g)));
    },
    async xInfoConsumers(this: Executor, key: string, group: string) {
      return arr(await this.execute(["XINFO", "CONSUMERS", key, group])).map((c) => pairsToPlainObject((c)));
    },
  });
}
