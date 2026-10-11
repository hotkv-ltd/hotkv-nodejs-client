// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Routing rules of the cluster client: which argument of a command is its
// key, which commands the server answers from the node's own state (so they
// are sent to every primary and merged), and how those per-node answers
// merge. Pure functions, no I/O.

import { formatNumberArg } from "./internal/numbers.js";
import type { CommandArg, CommandArgs, RespValue } from "./resp/types.js";

/**
 * How the per-node answers of a fanned-out command are merged: "union" (arrays
 * concatenated, a repeated element once), "sum" (integers added), "all" (the
 * command runs on every primary, the first reply is returned) and "first" (the
 * first reply that is not nil: a value only one node may hold).
 */
export type FanoutKind = "union" | "sum" | "all" | "first";

// Commands answered from a node's own state, not from a slot: on one node
// they list only what that node holds.
const FANOUT = new Map<string, FanoutKind>([
  ["KEYS", "union"],
  ["DBSIZE", "sum"],
  ["FLUSHALL", "all"],
  ["FLUSHDB", "all"],
  ["TAG.MEMBERS", "union"],
  ["TAG.INTER", "union"],
  ["TS.LIST", "union"],
  ["SCRIPT LOAD", "all"],
  ["SCRIPT FLUSH", "all"],
  // A function library has to be on every node for FCALL to find it there.
  ["FUNCTION LOAD", "all"],
  ["FUNCTION DELETE", "all"],
  ["FUNCTION FLUSH", "all"],
  ["FUNCTION RESTORE", "all"],
  // A vector snapshot sits on the node it was saved on: asked of every
  // primary, so one VSIM.LIST shows is found and dropped wherever it is.
  ["VSIM.LOAD", "first"],
  ["VSIM.DROP", "sum"],
]);
// <family>.LIST of the AI and side-store engines: one name per cache
// namespace, index, bucket, budget, limiter, template, pipeline or feature
// group, listed from the node the command lands on.
for (const family of [
  "SCACHE",
  "PCACHE",
  "NCACHE",
  "TOOL.CACHE",
  "GUARD",
  "RERANK",
  "LLMSTATS",
  "LLMBUDGET",
  "RATELIMIT",
  "PROMPT",
  "EMBED.DEDUP",
  "FEATURE",
  "RAG",
  "VSIM",
  "AMEM.SUMMARY",
]) {
  FANOUT.set(`${family}.LIST`, "union");
}

// Commands whose first argument is not a key: they run on any node.
const KEYLESS = new Set<string>([
  "PING",
  "ECHO",
  "INFO",
  "TIME",
  "LASTSAVE",
  "SAVE",
  "BGSAVE",
  "BGREWRITEAOF",
  "CONFIG",
  "CLIENT",
  "COMMAND",
  "CLUSTER",
  "READONLY",
  "READWRITE",
  "HELLO",
  "AUTH",
  "SCRIPT",
  "FUNCTION",
  "SLOWLOG",
  "LATENCY",
  "MODULE",
  "ACL",
  "WAIT",
  "SELECT",
  "RANDOMKEY",
  "SCAN",
  "LLMSTATS.PRICE",
  "OBSERVE",
  "ALERTS",
  "HOTKEYS",
  "REPLICATION.INFO",
]);
const KEYLESS_PREFIXES = ["TENANT.", "IAM.", "AUDIT.", "ENCRYPTION."];

// <command> numkeys key [key ...]
const NUMKEYS_AT_1 = new Set(["ZUNION", "ZINTER", "ZDIFF", "ZINTERCARD", "SINTERCARD", "LMPOP", "ZMPOP"]);
// <command> timeout|arg numkeys key [key ...]
const NUMKEYS_AT_2 = new Set(["BLMPOP", "BZMPOP", "EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO"]);
// <command> <subcommand> key ...
const KEY_AT_2 = new Set(["OBJECT", "XINFO", "XGROUP", "DEBUG"]);

function text(arg: CommandArg | undefined): string {
  if (arg === undefined) return "";
  if (typeof arg === "number") return formatNumberArg(arg);
  return Buffer.isBuffer(arg) ? arg.toString("utf8") : String(arg);
}

/** The upper-case name of a command, from its first argument. */
export function commandName(args: CommandArgs): string {
  return text(args[0]).toUpperCase();
}

function numkeys(arg: CommandArg | undefined): number {
  const n = Number(text(arg));
  return Number.isInteger(n) ? n : 0;
}

/**
 * The argument of `args` (a full command, name first) whose hash slot decides
 * the node, or undefined when the command has no key and can run on any
 * node. A command that names several keys (they must share one slot) is
 * routed by its first key.
 */
export function routingKey(args: CommandArgs): CommandArg | undefined {
  const name = commandName(args);
  const n = args.length;
  if (KEYLESS.has(name) || KEYLESS_PREFIXES.some((p) => name.startsWith(p))) return undefined;
  if (FANOUT.has(name) || (name === "VSIM.INFO" && n === 1)) return undefined;
  if (NUMKEYS_AT_1.has(name)) return n > 2 && numkeys(args[1]) > 0 ? args[2] : undefined;
  if (NUMKEYS_AT_2.has(name)) return n > 3 && numkeys(args[2]) > 0 ? args[3] : undefined;
  if (name === "MEMORY") return n > 2 && text(args[1]).toUpperCase() === "USAGE" ? args[2] : undefined;
  if (KEY_AT_2.has(name)) return n > 2 && text(args[1]).toUpperCase() !== "HELP" ? args[2] : undefined;
  if (name === "BITOP") return n > 2 ? args[2] : undefined;
  if (name === "XREAD" || name === "XREADGROUP") {
    for (let i = 1; i < n - 1; i++) {
      if (text(args[i]).toUpperCase() === "STREAMS") return args[i + 1];
    }
    return undefined;
  }
  return n > 1 ? args[1] : undefined;
}

/** How `args` must be fanned out to every primary, or undefined for a command that goes to one node. */
export function fanoutKind(args: CommandArgs): FanoutKind | undefined {
  const name = commandName(args);
  if ((name === "SCRIPT" || name === "FUNCTION") && args.length > 1) {
    return FANOUT.get(`${name} ${text(args[1]).toUpperCase()}`);
  }
  if (name === "VSIM.INFO" && args.length === 1) return "union";
  return FANOUT.get(name);
}

function marker(value: RespValue): string {
  if (Buffer.isBuffer(value)) return `b:${value.toString("latin1")}`;
  if (typeof value === "string") return `b:${Buffer.from(value, "utf8").toString("latin1")}`;
  if (Array.isArray(value)) return `a:${value.map(marker).join("\u0000")}`;
  return `o:${String(value)}`;
}

/** Merges the raw per-node replies of a fanned-out command. */
export function mergeReplies(kind: FanoutKind, replies: RespValue[]): RespValue {
  if (replies.length === 0) return kind === "union" ? [] : kind === "sum" ? 0 : null;
  if (kind === "sum") return replies.reduce<number>((total, r) => total + Number(r), 0);
  if (kind === "all") return replies[0] as RespValue;
  if (kind === "first") return replies.find((r) => r !== null && r !== undefined) ?? null;
  const merged: RespValue[] = [];
  const seen = new Set<string>();
  for (const reply of replies) {
    if (!Array.isArray(reply)) continue;
    for (const item of reply) {
      const m = marker(item);
      if (seen.has(m)) continue;
      seen.add(m);
      merged.push(item);
    }
  }
  return merged;
}
