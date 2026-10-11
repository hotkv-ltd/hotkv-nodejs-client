// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Official Node.js client for HotKV: a RESP2/RESP3 compatible, in-memory
// data store with HotKV exclusive commands and enterprise AI caching
// commands (prompt cache, semantic cache, agent memory, RAG, LLM stats and
// budgets). Zero runtime dependencies: built on node:net, node:tls,
// node:crypto and node:events only.
//
// Quick start:
//
//   import { HotKV } from "@hotkv/client";
//   const client = new HotKV({ url: "hotkv://127.0.0.1:6379" });
//   await client.set("key", "value");
//   const value = await client.get("key");
//   await client.close();
//
// AI caching helpers (PromptCache, SemanticCache) live in the "@hotkv/client/ai"
// entry point so a plain key/value client never pulls them in.

export { HotKV, createClient } from "./client.js";
export { HotKVCluster } from "./cluster.js";
export type { ClusterNodeAddr, HotKVClusterOptions } from "./cluster.js";
export { CLUSTER_SLOTS, crc16, keySlot } from "./crc16.js";

export * from "./commands/index.js";

export {
  AskError,
  ClusterError,
  ConnectionError,
  errorFromReply,
  HotKVError,
  isAskError,
  isMovedError,
  isNoAuthError,
  isNoScriptError,
  isNotLicensedError,
  isReadOnlyError,
  isReplyError,
  isWrongTypeError,
  MovedError,
  NotLicensedError,
  PoolExhaustedError,
  PoolTimeoutError,
  ProtocolError,
  ReplyError,
  TimeoutError,
} from "./errors.js";

export type {
  HotKVOptions,
  PoolOptions,
  ResolvedOptions,
  ResolvedPoolOptions,
  TLSOptions,
} from "./options.js";

export { Multi, Pipeline } from "./pipeline.js";
export type { PipelineResult } from "./pipeline.js";

export type { PoolStats } from "./pool.js";

export { PubSub } from "./pubsub.js";
export type { PubSubMessage, PubSubMessageKind } from "./pubsub.js";

export type { HScanOptions, ScanOptions } from "./scan.js";

export type { ParsedConnectionURL } from "./url.js";
export { parseConnectionURL } from "./url.js";

export type { CommandArg, CommandArgs, Frame, RespValue } from "./resp/types.js";

export type { TokenUsage } from "./usage.js";
export { tokenUsageArgs } from "./usage.js";
