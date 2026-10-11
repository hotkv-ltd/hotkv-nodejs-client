// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Typed wrappers for RATELIMIT.*, TS.*, FEATURE.* and OBSERVE / ALERTS
// (admin). OBSERVE and ALERTS are single command names with a subcommand as args[1], not
// dotted names like the rest of this file.

import type { Executor } from "../executor.js";
import { formatFloat } from "../internal/numbers.js";
import { arr, bool01, num, pairsToObject, pairsToStrObject, str, strArr } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

function numField(o: Record<string, RespValue>, key: string): number {
  return num(o[key] as RespValue);
}
function strField(o: Record<string, RespValue>, key: string): string {
  return str(o[key] as RespValue);
}

// ---------------------------------------------------------------------------
// RATELIMIT.*

export type RateLimitAlgo = "sliding_window" | "token_bucket" | "leaky_bucket";

export interface RateLimitCreateOptions {
  algo?: RateLimitAlgo;
  refill?: number;
  drain?: number;
}

export interface RateLimitCheck {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
  current: number;
}

export interface RateLimitStats {
  name: string;
  algo: string;
  limit: number;
  windowMs: number;
  uniqueKeys: number;
  totalAllowed: number;
  totalDenied: number;
}

function decodeRateLimitCheck(v: RespValue): RateLimitCheck {
  const [allowed, remaining, retryAfterMs, limit, current] = arr(v);
  return {
    allowed: num(allowed as RespValue) === 1,
    remaining: num(remaining as RespValue),
    retryAfterMs: num(retryAfterMs as RespValue),
    limit: num(limit as RespValue),
    current: num(current as RespValue),
  };
}

// ---------------------------------------------------------------------------
// TS.*

export interface TsCreateOptions {
  retentionMs?: number;
  labels?: Record<string, string>;
}

export type TsAggType = "avg" | "min" | "max" | "sum" | "count";

export interface TsSample {
  timestampMs: number;
  value: string;
}

export interface TsInfo {
  key: string;
  totalSamples: number;
  firstTimestamp: number;
  lastTimestamp: number;
  lastValue: string;
  retentionMs: number;
  memoryBytes: number;
  labels: Array<[string, string]>;
  rules: number;
}

function decodeSamples(v: RespValue): TsSample[] {
  return arr(v).map((pair) => {
    const [ts, val] = arr(pair);
    return { timestampMs: num(ts as RespValue), value: str(val as RespValue) };
  });
}

// ---------------------------------------------------------------------------
// FEATURE.*

export type FeatureType = "int64" | "double" | "float" | "string" | "int_array" | "double_array" | "float_array";

export interface FeatureSchemaField {
  name: string;
  type: FeatureType | string;
}

export interface FeatureRecord {
  values: Record<string, string>;
  updatedAtMs: number;
  freshnessMs: number;
}

export interface FeatureStats {
  entities: number;
  totalReads: number;
  totalWrites: number;
  memoryBytes: number;
}

function decodeFeatureRecord(v: RespValue): FeatureRecord | null {
  if (v === null) return null;
  const [flat, updated, freshness] = arr(v);
  return {
    values: pairsToStrObject((flat as RespValue)),
    updatedAtMs: num(updated as RespValue),
    freshnessMs: num(freshness as RespValue),
  };
}

// ---------------------------------------------------------------------------
// OBSERVE / ALERTS

export interface ObserveInfo {
  uptimeSeconds: number;
  connectedClients: number;
  totalCommands: number;
  usedMemoryBytes: number;
  peakMemoryBytes: number;
  totalConnections: number;
  enterpriseFeatures: string;
}

export interface ObserveMetrics {
  uptimeSeconds: number;
  connectedClients: number;
  totalCommands: number;
  totalConnections: number;
  usedMemoryBytes: number;
  peakMemoryBytes: number;
  slowlogLength: number;
  alertsSent: number;
  alertsFailed: number;
  numWorkers: number;
}

export interface AlertsInfo {
  enabled: boolean;
  flagEnabled: boolean;
  webhookUrl: string;
  provider: string;
  supportedProviders: string;
  minSeverity: string;
  alertsSent: number;
  alertsFailed: number;
  alertsDropped: number;
  alertsRateLimited: number;
  alertsDeduped: number;
  alertsFiltered: number;
  alertsQueued: number;
}

export type AlertSeverity = "info" | "warning" | "critical";

export interface OpsCommands {
  // RATELIMIT.*
  rateLimitCreate(name: string, limit: number, windowMs: number, opts?: RateLimitCreateOptions): Promise<void>;
  rateLimitCheck(name: string, key: string, cost?: number): Promise<RateLimitCheck>;
  rateLimitPeek(name: string, key: string): Promise<RateLimitCheck>;
  rateLimitReset(name: string, key: string): Promise<void>;
  rateLimitStats(name: string): Promise<RateLimitStats>;
  rateLimitDrop(name: string): Promise<void>;
  rateLimitList(): Promise<string[]>;

  // TS.*
  tsCreate(key: string, opts?: TsCreateOptions): Promise<void>;
  tsAdd(key: string, timestamp: number | "*", value: CommandArg): Promise<number>;
  tsRange(key: string, fromMs: number | "-" | "+", toMs: number | "-" | "+", count?: number): Promise<TsSample[]>;
  tsAgg(
    key: string,
    fromMs: number | "-" | "+",
    toMs: number | "-" | "+",
    bucketMs: number,
    aggType: TsAggType,
  ): Promise<TsSample[]>;
  tsInfo(key: string): Promise<TsInfo>;
  tsDelete(key: string): Promise<void>;
  tsRetention(key: string, retentionMs: number): Promise<void>;
  tsDownsample(srcKey: string, destKey: string, aggType: TsAggType, bucketMs: number): Promise<void>;
  tsList(label?: { key: string; value: string }): Promise<string[]>;

  // FEATURE.*
  featureCreate(group: string, description: string, schema: FeatureSchemaField[]): Promise<void>;
  featureSet(group: string, entity: string, values: Record<string, CommandArg>): Promise<void>;
  /** FEATURE.SETAT group entity unix-ms feature value ...: like featureSet(), stamped with the given time (ms since the Unix epoch) instead of the server's clock. */
  featureSetAt(group: string, entity: string, atMs: number, values: Record<string, CommandArg>): Promise<void>;
  featureGet(group: string, entity: string, features?: string[]): Promise<FeatureRecord | null>;
  featureBatch(group: string, entities: string[], features?: string[]): Promise<Array<FeatureRecord | null>>;
  featureSchema(group: string): Promise<FeatureSchemaField[]>;
  featureList(): Promise<string[]>;
  featureDrop(group: string): Promise<void>;
  featureStats(group: string): Promise<FeatureStats>;

  // OBSERVE / ALERTS
  observeInfo(): Promise<ObserveInfo>;
  observeMetrics(): Promise<ObserveMetrics>;
  alertsInfo(): Promise<AlertsInfo>;
  alertsTest(severity?: AlertSeverity, message?: string): Promise<string>;
  alertsSetUrl(url: string): Promise<string>;
  alertsSetSeverity(severity: AlertSeverity): Promise<string>;
  alertsOn(): Promise<string>;
  alertsOff(): Promise<string>;
}

export function installOpsCommands(proto: object): void {
  Object.assign(proto, {
    async rateLimitCreate(this: Executor, name: string, limit: number, windowMs: number, opts?: RateLimitCreateOptions) {
      const args: CommandArg[] = ["RATELIMIT.CREATE", name, limit, windowMs];
      if (opts?.algo) args.push("ALGO", opts.algo);
      if (opts?.refill !== undefined) args.push("REFILL", formatFloat(opts.refill, "refill"));
      if (opts?.drain !== undefined) args.push("DRAIN", formatFloat(opts.drain, "drain"));
      await this.execute(args);
    },
    async rateLimitCheck(this: Executor, name: string, key: string, cost?: number) {
      const args: CommandArg[] = ["RATELIMIT.CHECK", name, key];
      if (cost !== undefined) args.push("COST", cost);
      return decodeRateLimitCheck(await this.execute(args));
    },
    async rateLimitPeek(this: Executor, name: string, key: string) {
      return decodeRateLimitCheck(await this.execute(["RATELIMIT.PEEK", name, key]));
    },
    async rateLimitReset(this: Executor, name: string, key: string) {
      await this.execute(["RATELIMIT.RESET", name, key]);
    },
    async rateLimitStats(this: Executor, name: string) {
      const o = pairsToObject((await this.execute(["RATELIMIT.STATS", name])));
      return {
        name: strField(o, "name"),
        algo: strField(o, "algo"),
        limit: numField(o, "limit"),
        windowMs: numField(o, "window_ms"),
        uniqueKeys: numField(o, "unique_keys"),
        totalAllowed: numField(o, "total_allowed"),
        totalDenied: numField(o, "total_denied"),
      } satisfies RateLimitStats;
    },
    async rateLimitDrop(this: Executor, name: string) {
      await this.execute(["RATELIMIT.DROP", name]);
    },
    async rateLimitList(this: Executor) {
      return strArr(await this.execute(["RATELIMIT.LIST"]));
    },

    async tsCreate(this: Executor, key: string, opts?: TsCreateOptions) {
      const args: CommandArg[] = ["TS.CREATE", key];
      if (opts?.retentionMs !== undefined) args.push("RETENTION", opts.retentionMs);
      if (opts?.labels) {
        args.push("LABELS");
        for (const [l, v] of Object.entries(opts.labels)) args.push(l, v);
      }
      await this.execute(args);
    },
    async tsAdd(this: Executor, key: string, timestamp: number | "*", value: CommandArg) {
      return num(await this.execute(["TS.ADD", key, timestamp, value]));
    },
    async tsRange(this: Executor, key: string, fromMs: number | "-" | "+", toMs: number | "-" | "+", count?: number) {
      const args: CommandArg[] = ["TS.RANGE", key, fromMs, toMs];
      if (count !== undefined) args.push("COUNT", count);
      return decodeSamples(await this.execute(args));
    },
    async tsAgg(
      this: Executor,
      key: string,
      fromMs: number | "-" | "+",
      toMs: number | "-" | "+",
      bucketMs: number,
      aggType: TsAggType,
    ) {
      return decodeSamples(await this.execute(["TS.AGG", key, fromMs, toMs, bucketMs, aggType]));
    },
    async tsInfo(this: Executor, key: string) {
      const o = pairsToObject((await this.execute(["TS.INFO", key])));
      return {
        key: strField(o, "key"),
        totalSamples: numField(o, "totalSamples"),
        firstTimestamp: numField(o, "firstTimestamp"),
        lastTimestamp: numField(o, "lastTimestamp"),
        lastValue: strField(o, "lastValue"),
        retentionMs: numField(o, "retentionMs"),
        memoryBytes: numField(o, "memoryBytes"),
        labels: arr(o.labels as RespValue).map((p) => {
          const [l, v] = arr(p);
          return [str(l as RespValue), str(v as RespValue)] as [string, string];
        }),
        rules: numField(o, "rules"),
      } satisfies TsInfo;
    },
    async tsDelete(this: Executor, key: string) {
      await this.execute(["TS.DELETE", key]);
    },
    async tsRetention(this: Executor, key: string, retentionMs: number) {
      await this.execute(["TS.RETENTION", key, retentionMs]);
    },
    async tsDownsample(this: Executor, srcKey: string, destKey: string, aggType: TsAggType, bucketMs: number) {
      await this.execute(["TS.DOWNSAMPLE", srcKey, destKey, aggType, bucketMs]);
    },
    async tsList(this: Executor, label?: { key: string; value: string }) {
      const args: CommandArg[] = ["TS.LIST"];
      if (label) args.push("LABEL", label.key, label.value);
      return strArr(await this.execute(args));
    },

    async featureCreate(this: Executor, group: string, description: string, schema: FeatureSchemaField[]) {
      const args: CommandArg[] = ["FEATURE.CREATE", group, description, "SCHEMA"];
      for (const f of schema) args.push(f.name, f.type);
      await this.execute(args);
    },
    async featureSetAt(this: Executor, group: string, entity: string, atMs: number, values: Record<string, CommandArg>) {
      const args: CommandArg[] = ["FEATURE.SETAT", group, entity, atMs];
      for (const [f, v] of Object.entries(values)) args.push(f, v);
      await this.execute(args);
    },
    async featureSet(this: Executor, group: string, entity: string, values: Record<string, CommandArg>) {
      const args: CommandArg[] = ["FEATURE.SET", group, entity];
      for (const [f, v] of Object.entries(values)) args.push(f, v);
      await this.execute(args);
    },
    async featureGet(this: Executor, group: string, entity: string, features?: string[]) {
      const args: CommandArg[] = ["FEATURE.GET", group, entity, ...(features ?? [])];
      return decodeFeatureRecord(await this.execute(args));
    },
    async featureBatch(this: Executor, group: string, entities: string[], features?: string[]) {
      const args: CommandArg[] = ["FEATURE.BATCH", group, ...entities];
      if (features && features.length > 0) args.push("FEATURES", ...features);
      return arr(await this.execute(args)).map(decodeFeatureRecord);
    },
    async featureSchema(this: Executor, group: string) {
      return arr(await this.execute(["FEATURE.SCHEMA", group])).map((p) => {
        const [name, type] = arr(p);
        return { name: str(name as RespValue), type: str(type as RespValue) } satisfies FeatureSchemaField;
      });
    },
    async featureList(this: Executor) {
      return strArr(await this.execute(["FEATURE.LIST"]));
    },
    async featureDrop(this: Executor, group: string) {
      await this.execute(["FEATURE.DROP", group]);
    },
    async featureStats(this: Executor, group: string) {
      const o = pairsToObject((await this.execute(["FEATURE.STATS", group])));
      return {
        entities: numField(o, "entities"),
        totalReads: numField(o, "totalReads"),
        totalWrites: numField(o, "totalWrites"),
        memoryBytes: numField(o, "memoryBytes"),
      } satisfies FeatureStats;
    },

    async observeInfo(this: Executor) {
      const o = pairsToObject((await this.execute(["OBSERVE", "INFO"])));
      return {
        uptimeSeconds: numField(o, "uptime_seconds"),
        connectedClients: numField(o, "connected_clients"),
        totalCommands: numField(o, "total_commands"),
        usedMemoryBytes: numField(o, "used_memory_bytes"),
        peakMemoryBytes: numField(o, "peak_memory_bytes"),
        totalConnections: numField(o, "total_connections"),
        enterpriseFeatures: strField(o, "enterprise_features"),
      } satisfies ObserveInfo;
    },
    async observeMetrics(this: Executor) {
      const o = pairsToObject((await this.execute(["OBSERVE", "METRICS"])));
      return {
        uptimeSeconds: numField(o, "uptime_seconds"),
        connectedClients: numField(o, "connected_clients"),
        totalCommands: numField(o, "total_commands"),
        totalConnections: numField(o, "total_connections"),
        usedMemoryBytes: numField(o, "used_memory_bytes"),
        peakMemoryBytes: numField(o, "peak_memory_bytes"),
        slowlogLength: numField(o, "slowlog_length"),
        alertsSent: numField(o, "alerts_sent"),
        alertsFailed: numField(o, "alerts_failed"),
        numWorkers: numField(o, "num_workers"),
      } satisfies ObserveMetrics;
    },
    async alertsInfo(this: Executor) {
      const o = pairsToObject((await this.execute(["ALERTS", "INFO"])));
      return {
        enabled: bool01(o.enabled as RespValue),
        flagEnabled: bool01(o.flag_enabled as RespValue),
        webhookUrl: strField(o, "webhook_url"),
        provider: strField(o, "provider"),
        supportedProviders: strField(o, "supported_providers"),
        minSeverity: strField(o, "min_severity"),
        alertsSent: numField(o, "alerts_sent"),
        alertsFailed: numField(o, "alerts_failed"),
        alertsDropped: numField(o, "alerts_dropped"),
        alertsRateLimited: numField(o, "alerts_rate_limited"),
        alertsDeduped: numField(o, "alerts_deduped"),
        alertsFiltered: numField(o, "alerts_filtered"),
        alertsQueued: numField(o, "alerts_queued"),
      } satisfies AlertsInfo;
    },
    async alertsTest(this: Executor, severity?: AlertSeverity, message?: string) {
      const args: CommandArg[] = ["ALERTS", "TEST"];
      if (severity !== undefined) args.push(severity);
      if (message !== undefined) args.push(...message.split(" "));
      return str(await this.execute(args));
    },
    async alertsSetUrl(this: Executor, url: string) {
      return str(await this.execute(["ALERTS", "SETURL", url]));
    },
    async alertsSetSeverity(this: Executor, severity: AlertSeverity) {
      return str(await this.execute(["ALERTS", "SETSEVERITY", severity]));
    },
    async alertsOn(this: Executor) {
      return str(await this.execute(["ALERTS", "ON"]));
    },
    async alertsOff(this: Executor) {
      return str(await this.execute(["ALERTS", "OFF"]));
    },
  });
}
