// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Typed wrappers for AMEM.* (AI agent memory: conversation, semantic,
// working and episodic memory, plus cross-memory search) and AMEM.SUMMARY.*.
// These commands need a server license that includes the agent-memory
// feature (AMEM.SUMMARY.* the amem-summary feature).

import type { Executor } from "../executor.js";
import { formatVectorComponent } from "../internal/numbers.js";
import { arr, arrOrEmpty, num, pairsToStrObject, str, strArr } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

function vecArgs(values: number[]): CommandArg[] {
  return values.map((v) => formatVectorComponent(v));
}

export interface ConvTurn {
  role: string;
  content: string;
}

export interface SemanticRecall {
  key: string;
  content: string;
  similarity: string;
}

export interface EpisodicEvent {
  type: string;
  content: string;
  metadata: string;
  /** Nanosecond Unix timestamp, kept as a decimal string (exceeds Number.MAX_SAFE_INTEGER). */
  timestampNs: string;
}

export interface EpisodicStats {
  totalEvents: number;
  oldestTs: string;
  newestTs: string;
}

export interface CrossMemoryResult {
  source: string;
  key: string;
  content: string;
  similarity: string;
}

export interface SummaryRecord {
  summary: string;
  version: number;
  updatedUnix: number;
}

function decodeTurns(v: RespValue): ConvTurn[] {
  return arrOrEmpty(v).map((turn) => {
    const o = pairsToStrObject((turn));
    return { role: o.role as string, content: o.content as string };
  });
}

export interface AMemCommands {
  // Conversation memory
  amemConvCreate(sessionId: string, opts?: { window?: number; ttlSeconds?: number; pxat?: number }): Promise<void>;
  amemConvAppend(sessionId: string, role: string, content: string): Promise<void>;
  amemConvGet(sessionId: string): Promise<ConvTurn[]>;
  amemConvWindow(sessionId: string, n: number): Promise<ConvTurn[]>;
  amemConvClear(sessionId: string): Promise<boolean>;
  amemConvDrop(sessionId: string): Promise<boolean>;

  // Semantic memory
  amemSemCreate(agentId: string, dimensions: number): Promise<void>;
  amemSemStore(agentId: string, key: string, content: string, vector: number[], ttlSeconds?: number | { pxat: number }): Promise<void>;
  amemSemRecall(agentId: string, k: number, vector: number[]): Promise<SemanticRecall[]>;
  amemSemForget(agentId: string, key: string): Promise<boolean>;
  amemSemList(agentId: string): Promise<string[]>;

  // Working memory
  amemWorkSet(sessionId: string, key: string, value: CommandArg, ttlSeconds?: number | { pxat: number }): Promise<void>;
  amemWorkGet(sessionId: string, key: string): Promise<string | null>;
  amemWorkDel(sessionId: string, key: string): Promise<boolean>;
  amemWorkClear(sessionId: string): Promise<boolean>;
  amemWorkList(sessionId: string): Promise<string[]>;

  // Episodic memory
  amemEpisLog(agentId: string, eventType: string, content: string, metadataJson?: string): Promise<void>;
  amemEpisQuery(
    agentId: string,
    opts?: { type?: string; from?: number; to?: number; limit?: number },
  ): Promise<EpisodicEvent[]>;
  amemEpisClear(agentId: string): Promise<boolean>;
  amemEpisStats(agentId: string): Promise<EpisodicStats>;

  // Cross-memory search
  amemSearch(agentId: string, k: number, vector: number[]): Promise<CrossMemoryResult[]>;

  // AMEM.SUMMARY.*
  amemSummarySet(agentId: string, summary: string): Promise<number>;
  amemSummaryAppend(agentId: string, extra: string): Promise<number>;
  amemSummaryGet(agentId: string): Promise<SummaryRecord | null>;
  amemSummaryDrop(agentId: string): Promise<boolean>;
  amemSummaryList(): Promise<string[]>;
}

export function installAMemCommands(proto: object): void {
  Object.assign(proto, {
    async amemConvCreate(this: Executor, sessionId: string, opts?: { window?: number; ttlSeconds?: number; pxat?: number }) {
      const args: CommandArg[] = ["AMEM.CONV.CREATE", sessionId];
      if (opts?.window !== undefined) args.push("WINDOW", opts.window);
      if (opts?.ttlSeconds !== undefined) args.push("TTL", opts.ttlSeconds);
      if (opts?.pxat !== undefined) args.push("PXAT", opts.pxat);
      await this.execute(args);
    },
    async amemConvAppend(this: Executor, sessionId: string, role: string, content: string) {
      await this.execute(["AMEM.CONV.APPEND", sessionId, role, content]);
    },
    async amemConvGet(this: Executor, sessionId: string) {
      return decodeTurns(await this.execute(["AMEM.CONV.GET", sessionId]));
    },
    async amemConvWindow(this: Executor, sessionId: string, n: number) {
      return decodeTurns(await this.execute(["AMEM.CONV.WINDOW", sessionId, n]));
    },
    async amemConvClear(this: Executor, sessionId: string) {
      return num(await this.execute(["AMEM.CONV.CLEAR", sessionId])) === 1;
    },
    async amemConvDrop(this: Executor, sessionId: string) {
      return num(await this.execute(["AMEM.CONV.DROP", sessionId])) === 1;
    },

    async amemSemCreate(this: Executor, agentId: string, dimensions: number) {
      await this.execute(["AMEM.SEM.CREATE", agentId, dimensions]);
    },
    async amemSemStore(this: Executor, agentId: string, key: string, content: string, vector: number[], ttlSeconds?: number | { pxat: number }) {
      const args: CommandArg[] = ["AMEM.SEM.STORE", agentId, key, content, ...vecArgs(vector)];
      if (typeof ttlSeconds === "object") args.push("PXAT", ttlSeconds.pxat);
      else if (ttlSeconds !== undefined) args.push("TTL", ttlSeconds);
      await this.execute(args);
    },
    async amemSemRecall(this: Executor, agentId: string, k: number, vector: number[]) {
      const reply = await this.execute(["AMEM.SEM.RECALL", agentId, k, ...vecArgs(vector)]);
      return arrOrEmpty(reply).map((r) => {
        const o = pairsToStrObject((r));
        return { key: o.key as string, content: o.content as string, similarity: o.similarity as string };
      });
    },
    async amemSemForget(this: Executor, agentId: string, key: string) {
      return num(await this.execute(["AMEM.SEM.FORGET", agentId, key])) === 1;
    },
    async amemSemList(this: Executor, agentId: string) {
      return strArr(await this.execute(["AMEM.SEM.LIST", agentId]));
    },

    async amemWorkSet(this: Executor, sessionId: string, key: string, value: CommandArg, ttlSeconds?: number | { pxat: number }) {
      const args: CommandArg[] = ["AMEM.WORK.SET", sessionId, key, value];
      if (typeof ttlSeconds === "object") args.push("PXAT", ttlSeconds.pxat);
      else if (ttlSeconds !== undefined) args.push("TTL", ttlSeconds);
      await this.execute(args);
    },
    async amemWorkGet(this: Executor, sessionId: string, key: string) {
      const reply = await this.execute(["AMEM.WORK.GET", sessionId, key]);
      return reply === null ? null : str(reply);
    },
    async amemWorkDel(this: Executor, sessionId: string, key: string) {
      return num(await this.execute(["AMEM.WORK.DEL", sessionId, key])) === 1;
    },
    async amemWorkClear(this: Executor, sessionId: string) {
      return num(await this.execute(["AMEM.WORK.CLEAR", sessionId])) === 1;
    },
    async amemWorkList(this: Executor, sessionId: string) {
      return strArr(await this.execute(["AMEM.WORK.LIST", sessionId]));
    },

    async amemEpisLog(this: Executor, agentId: string, eventType: string, content: string, metadataJson?: string) {
      const args: CommandArg[] = ["AMEM.EPIS.LOG", agentId, eventType, content];
      if (metadataJson !== undefined) args.push("METADATA", metadataJson);
      await this.execute(args);
    },
    async amemEpisQuery(
      this: Executor,
      agentId: string,
      opts?: { type?: string; from?: number; to?: number; limit?: number },
    ) {
      const args: CommandArg[] = ["AMEM.EPIS.QUERY", agentId];
      if (opts?.type !== undefined) args.push("TYPE", opts.type);
      if (opts?.from !== undefined) args.push("FROM", opts.from);
      if (opts?.to !== undefined) args.push("TO", opts.to);
      if (opts?.limit !== undefined) args.push("LIMIT", opts.limit);
      return arrOrEmpty(await this.execute(args)).map((e) => {
        const o = pairsToStrObject((e));
        return {
          type: o.type as string,
          content: o.content as string,
          metadata: o.metadata as string,
          timestampNs: o.timestamp as string,
        } satisfies EpisodicEvent;
      });
    },
    async amemEpisClear(this: Executor, agentId: string) {
      return num(await this.execute(["AMEM.EPIS.CLEAR", agentId])) === 1;
    },
    async amemEpisStats(this: Executor, agentId: string) {
      const o = pairsToStrObject((await this.execute(["AMEM.EPIS.STATS", agentId])));
      return {
        totalEvents: num(o.total_events as string),
        oldestTs: o.oldest_ts as string,
        newestTs: o.newest_ts as string,
      } satisfies EpisodicStats;
    },

    async amemSearch(this: Executor, agentId: string, k: number, vector: number[]) {
      const reply = await this.execute(["AMEM.SEARCH", agentId, k, ...vecArgs(vector)]);
      return arrOrEmpty(reply).map((r) => {
        const o = pairsToStrObject((r));
        return {
          source: o.source as string,
          key: o.key as string,
          content: o.content as string,
          similarity: o.similarity as string,
        } satisfies CrossMemoryResult;
      });
    },

    async amemSummarySet(this: Executor, agentId: string, summary: string) {
      return num(await this.execute(["AMEM.SUMMARY.SET", agentId, summary]));
    },
    async amemSummaryAppend(this: Executor, agentId: string, extra: string) {
      return num(await this.execute(["AMEM.SUMMARY.APPEND", agentId, extra]));
    },
    async amemSummaryGet(this: Executor, agentId: string) {
      const reply = await this.execute(["AMEM.SUMMARY.GET", agentId]);
      if (reply === null) return null;
      const [summary, version, updated] = arr(reply);
      return {
        summary: str(summary as RespValue),
        version: num(version as RespValue),
        updatedUnix: num(updated as RespValue),
      } satisfies SummaryRecord;
    },
    async amemSummaryDrop(this: Executor, agentId: string) {
      return num(await this.execute(["AMEM.SUMMARY.DROP", agentId])) === 1;
    },
    async amemSummaryList(this: Executor) {
      return strArr(await this.execute(["AMEM.SUMMARY.LIST"]));
    },
  });
}
