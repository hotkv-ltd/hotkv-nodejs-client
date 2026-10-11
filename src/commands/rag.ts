// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Typed wrappers for RAG.* (retrieval augmented generation pipelines). They need a
// server license that includes the rag-pipeline feature.

import type { Executor } from "../executor.js";
import { arr, num, pairsToObject, str, strArr } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

export interface RagCreateOptions {
  strategy?: "fixed" | "fixed_size" | "sentence" | "paragraph";
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface RagIngestOptions {
  meta?: Record<string, string>;
  /** One float vector per chunk produced from the text, in order. */
  vectors?: number[][];
}

export interface RagSearchOptions {
  k?: number;
  /** Vector-vs-BM25 blend, 0 (pure BM25) to 1 (pure vector). */
  alpha?: number;
  vector?: number[];
  filter?: Record<string, string>;
}

export interface RagSearchResult {
  chunkId: string;
  docId: string;
  text: string;
  score: number;
  vectorScore: number;
  bm25Score: number;
  meta: Record<string, string>;
}

export interface RagStats {
  name: string;
  dimensions: number;
  totalDocs: number;
  totalChunks: number;
  totalIngested: number;
  totalQueries: number;
  chunkSize: number;
  chunkStrategy: string;
  chunkOverlap: number;
}

function decodeRagResult(v: RespValue): RagSearchResult {
  const parts = arr(v);
  const meta: Record<string, string> = {};
  for (let i = 6; i + 1 < parts.length; i += 2) {
    meta[str(parts[i] as RespValue)] = str(parts[i + 1] as RespValue);
  }
  return {
    chunkId: str(parts[0] as RespValue),
    docId: str(parts[1] as RespValue),
    text: str(parts[2] as RespValue),
    score: num(parts[3] as RespValue),
    vectorScore: num(parts[4] as RespValue),
    bm25Score: num(parts[5] as RespValue),
    meta,
  };
}

export interface RagCommands {
  /** RAG.CREATE name dimensions [STRATEGY ...] [CHUNK_SIZE ...] [CHUNK_OVERLAP ...]. */
  ragCreate(name: string, dimensions: number, opts?: RagCreateOptions): Promise<void>;
  /** RAG.INGEST pipeline docId text [META ...] [VECTORS ...]: chunks ingested. */
  ragIngest(pipeline: string, docId: string, text: string, opts?: RagIngestOptions): Promise<number>;
  /** RAG.SEARCH pipeline queryText [K] [ALPHA] [VECTOR] [FILTER]. */
  ragSearch(pipeline: string, queryText: string, opts?: RagSearchOptions): Promise<RagSearchResult[]>;
  /** RAG.STATS pipeline. */
  ragStats(pipeline: string): Promise<RagStats>;
  /** RAG.DROP pipeline. */
  ragDrop(pipeline: string): Promise<void>;
  /** RAG.LIST. */
  ragList(): Promise<string[]>;
}

export function installRagCommands(proto: object): void {
  Object.assign(proto, {
    async ragCreate(this: Executor, name: string, dimensions: number, opts?: RagCreateOptions) {
      const args: CommandArg[] = ["RAG.CREATE", name, dimensions];
      if (opts?.strategy) args.push("STRATEGY", opts.strategy);
      if (opts?.chunkSize !== undefined) args.push("CHUNK_SIZE", opts.chunkSize);
      if (opts?.chunkOverlap !== undefined) args.push("CHUNK_OVERLAP", opts.chunkOverlap);
      await this.execute(args);
    },
    async ragIngest(this: Executor, pipeline: string, docId: string, text: string, opts?: RagIngestOptions) {
      const args: CommandArg[] = ["RAG.INGEST", pipeline, docId, text];
      if (opts?.meta) {
        args.push("META");
        for (const [k, v] of Object.entries(opts.meta)) args.push(k, v);
      }
      if (opts?.vectors && opts.vectors.length > 0) {
        args.push("VECTORS", ...opts.vectors.map((vec) => vec.join(",")));
      }
      return num(await this.execute(args));
    },
    async ragSearch(this: Executor, pipeline: string, queryText: string, opts?: RagSearchOptions) {
      const args: CommandArg[] = ["RAG.SEARCH", pipeline, queryText];
      if (opts?.k !== undefined) args.push("K", opts.k);
      if (opts?.alpha !== undefined) args.push("ALPHA", opts.alpha);
      if (opts?.vector) args.push("VECTOR", opts.vector.join(","));
      if (opts?.filter) {
        args.push("FILTER");
        for (const [k, v] of Object.entries(opts.filter)) args.push(k, v);
      }
      return arr(await this.execute(args)).map(decodeRagResult);
    },
    async ragStats(this: Executor, pipeline: string) {
      const o = pairsToObject((await this.execute(["RAG.STATS", pipeline])));
      return {
        name: str(o.name as RespValue),
        dimensions: num(o.dimensions as RespValue),
        totalDocs: num(o.totalDocs as RespValue),
        totalChunks: num(o.totalChunks as RespValue),
        totalIngested: num(o.totalIngested as RespValue),
        totalQueries: num(o.totalQueries as RespValue),
        chunkSize: num(o.chunkSize as RespValue),
        chunkStrategy: str(o.chunkStrategy as RespValue),
        chunkOverlap: num(o.chunkOverlap as RespValue),
      } satisfies RagStats;
    },
    async ragDrop(this: Executor, pipeline: string) {
      await this.execute(["RAG.DROP", pipeline]);
    },
    async ragList(this: Executor) {
      return strArr(await this.execute(["RAG.LIST"]));
    },
  });
}
