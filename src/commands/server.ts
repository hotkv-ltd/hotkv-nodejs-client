// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { num, pairsToStrObject, str, strOrNull } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

function decodeConfigMap(v: RespValue): Record<string, string> {
  if (v instanceof Map) {
    const out: Record<string, string> = {};
    for (const [k, val] of v) out[str(k)] = str(val);
    return out;
  }
  return pairsToStrObject(v as RespValue[]);
}

export interface ServerCommands {
  /** PING [message]. */
  ping(message?: string): Promise<string>;
  /** ECHO message. */
  echo(message: string): Promise<string>;
  /** INFO [section]: the raw multi section report. */
  info(section?: string): Promise<string>;
  /** DBSIZE. */
  dbSize(): Promise<number>;
  /** FLUSHDB [ASYNC|SYNC]. */
  flushDB(mode?: "ASYNC" | "SYNC"): Promise<void>;
  /** FLUSHALL [ASYNC|SYNC]. */
  flushAll(mode?: "ASYNC" | "SYNC"): Promise<void>;
  /** TIME: [unix seconds, microseconds] as strings. */
  time(): Promise<[string, string]>;
  /** CONFIG GET pattern. */
  configGet(pattern: string): Promise<Record<string, string>>;
  /** CONFIG SET parameter value. */
  configSet(parameter: string, value: CommandArg): Promise<void>;
  /** CLIENT SETNAME name. */
  clientSetName(name: string): Promise<void>;
  /** CLIENT GETNAME. */
  clientGetName(): Promise<string | null>;
  /** CLIENT ID. */
  clientId(): Promise<number>;
  /** SELECT index: switch the connection's database (also settable at connect time via Options.db). */
  select(db: number): Promise<void>;
  /** LASTSAVE: Unix time of the last successful save to disk. */
  lastSave(): Promise<number>;
  /** PUBLISH channel message: number of subscribers that received it. */
  publish(channel: string, message: CommandArg): Promise<number>;
  /** SPUBLISH channel message: the sharded pub/sub equivalent of PUBLISH. */
  sPublish(channel: string, message: CommandArg): Promise<number>;
  /** PUBSUB CHANNELS [pattern]: currently active channels. */
  pubsubChannels(pattern?: string): Promise<string[]>;
  /** PUBSUB NUMSUB [channel ...]: flat [channel, count, ...] turned into a map. */
  pubsubNumSub(...channels: string[]): Promise<Record<string, number>>;
  /** PUBSUB NUMPAT: number of active pattern subscriptions. */
  pubsubNumPat(): Promise<number>;
}

export function installServerCommands(proto: object): void {
  Object.assign(proto, {
    async ping(this: Executor, message?: string) {
      return str(await this.execute(message === undefined ? ["PING"] : ["PING", message]));
    },
    async echo(this: Executor, message: string) {
      return str(await this.execute(["ECHO", message]));
    },
    async info(this: Executor, section?: string) {
      return str(await this.execute(section === undefined ? ["INFO"] : ["INFO", section]));
    },
    async dbSize(this: Executor) {
      return num(await this.execute(["DBSIZE"]));
    },
    async flushDB(this: Executor, mode?: "ASYNC" | "SYNC") {
      await this.execute(mode === undefined ? ["FLUSHDB"] : ["FLUSHDB", mode]);
    },
    async flushAll(this: Executor, mode?: "ASYNC" | "SYNC") {
      await this.execute(mode === undefined ? ["FLUSHALL"] : ["FLUSHALL", mode]);
    },
    async time(this: Executor) {
      const [seconds, micros] = (await this.execute(["TIME"])) as [RespValue, RespValue];
      return [str(seconds), str(micros)] as [string, string];
    },
    async configGet(this: Executor, pattern: string) {
      return decodeConfigMap(await this.execute(["CONFIG", "GET", pattern]));
    },
    async configSet(this: Executor, parameter: string, value: CommandArg) {
      await this.execute(["CONFIG", "SET", parameter, value]);
    },
    async clientSetName(this: Executor, name: string) {
      await this.execute(["CLIENT", "SETNAME", name]);
    },
    async clientGetName(this: Executor) {
      return strOrNull(await this.execute(["CLIENT", "GETNAME"]));
    },
    async clientId(this: Executor) {
      return num(await this.execute(["CLIENT", "ID"]));
    },
    async select(this: Executor, db: number) {
      await this.execute(["SELECT", db]);
    },
    async lastSave(this: Executor) {
      return num(await this.execute(["LASTSAVE"]));
    },
    async publish(this: Executor, channel: string, message: CommandArg) {
      return num(await this.execute(["PUBLISH", channel, message]));
    },
    async sPublish(this: Executor, channel: string, message: CommandArg) {
      return num(await this.execute(["SPUBLISH", channel, message]));
    },
    async pubsubChannels(this: Executor, pattern?: string) {
      const args: CommandArg[] = pattern === undefined ? ["PUBSUB", "CHANNELS"] : ["PUBSUB", "CHANNELS", pattern];
      return (await this.execute(args) as RespValue[]).map(str);
    },
    async pubsubNumSub(this: Executor, ...channels: string[]) {
      const flat = (await this.execute(["PUBSUB", "NUMSUB", ...channels])) as RespValue[];
      const out: Record<string, number> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) out[str(flat[i] as RespValue)] = num(flat[i + 1] as RespValue);
      return out;
    },
    async pubsubNumPat(this: Executor) {
      return num(await this.execute(["PUBSUB", "NUMPAT"]));
    },
  });
}
