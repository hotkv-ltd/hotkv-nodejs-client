// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { HotKV } from "./client.js";
import type { AllCommands } from "./commands/index.js";
import { installCommands } from "./commands/index.js";
import { commandName, fanoutKind, mergeReplies, routingKey } from "./clusterRouting.js";
import type { FanoutKind } from "./clusterRouting.js";
import { CLUSTER_SLOTS, keySlot } from "./crc16.js";
import { AskError, ClusterError, ConnectionError, MovedError, ReplyError, TimeoutError } from "./errors.js";
import type { HotKVOptions } from "./options.js";
import { isReadOnlyCommand } from "./readonly-commands.js";
import { arr, num, str } from "./resp/decode.js";
import type { CommandArgs, RespValue } from "./resp/types.js";
import {
  type HScanOptions,
  type ScanOptions,
  hscanIterator,
  sscanIterator,
  zscanIterator,
} from "./scan.js";
import type { Executor } from "./executor.js";

export interface ClusterNodeAddr {
  host: string;
  port: number;
}

export interface HotKVClusterOptions extends Omit<HotKVOptions, "host" | "port" | "url" | "path" | "replicaReads"> {
  /** Maximum MOVED/ASK redirects to follow for one command before giving up. Default 16. */
  maxRedirects?: number;
  /** Route read-only commands to a random replica of the owning slot instead of its master. Default false. */
  readFromReplicas?: boolean;
  /**
   * How long one command keeps trying through a failover or a reshard (a lost
   * connection, CLUSTERDOWN, TRYAGAIN, LOADING, a write refused by a node that
   * is no longer a primary) before it gives up with ClusterError. Default 10000.
   */
  retryTimeoutMs?: number;
  /**
   * Whether a command that may have reached a node whose connection then broke
   * is sent again (at least once delivery, as other cluster clients do). A
   * write that did reach the node and was applied is then applied twice, which
   * changes the result of a command that is not idempotent (INCR, RPUSH, XADD,
   * TS.ADD, LLMBUDGET.CONSUME, RATELIMIT.CHECK, LLMSTATS.RECORD,
   * AMEM.CONV.APPEND and the other counters and appends).
   * With false only reads and commands that never left the client (the
   * connection could not be opened) are retried, and the failure of any other
   * write is thrown. Default true.
   */
  retryWrites?: boolean;
}

interface SlotRange {
  master: ClusterNodeAddr;
  replicas: ClusterNodeAddr[];
}

const TRANSIENT_CODES = new Set(["CLUSTERDOWN", "TRYAGAIN", "LOADING", "MASTERDOWN", "READONLY"]);
const SUSPECT_MS = 30_000;

function addrKey(addr: ClusterNodeAddr): string {
  return `${addr.host}:${addr.port}`;
}

function parseAddr(s: string, fallbackHost = ""): ClusterNodeAddr {
  const idx = s.lastIndexOf(":");
  if (idx === -1) throw new ClusterError(`invalid node address "${s}"`);
  const port = Number(s.slice(idx + 1));
  if (!Number.isInteger(port)) throw new ClusterError(`invalid node address "${s}"`);
  return { host: s.slice(0, idx) || fallbackHost, port };
}

function parseNodeEntry(v: RespValue, askedHost: string): ClusterNodeAddr {
  const parts = arr(v);
  const host = parts[0] === null || parts[0] === undefined ? "" : str(parts[0] as RespValue);
  return { host: host || askedHost, port: num(parts[1] as RespValue) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransport(err: unknown): boolean {
  return err instanceof ConnectionError || err instanceof TimeoutError;
}

function isTransient(err: unknown): boolean {
  return err instanceof ReplyError && TRANSIENT_CODES.has(err.code);
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface HotKVCluster extends AllCommands {}

/**
 * A cluster aware HotKV client: builds a slot map from CLUSTER SLOTS,
 * routes each command by its key's CRC16 slot (honoring `{hash tag}`),
 * follows MOVED (refreshing the map) and ASK (sending ASKING first on the
 * same connection, without moving the slot permanently), and keeps one
 * pooled HotKV per node it has talked to. Every typed command method is
 * available exactly as on HotKV; there is no cluster wide pipeline or
 * transaction, since a batch can span slots that live on different nodes.
 *
 * Beyond the redirects it rides out a live cluster: a lost primary
 * (failover), a reshard in flight, CLUSTERDOWN, TRYAGAIN or LOADING make it
 * refresh the slot map and try again with a short backoff for up to
 * `retryTimeoutMs`; a command the server answers from a node's own state (the
 * `*.LIST` commands of the AI engines, TAG.MEMBERS/TAG.INTER, KEYS, DBSIZE,
 * FLUSHALL) is sent to every primary and the answers merged, so `pcacheList()`
 * lists the namespaces of the whole cluster, not of one node; and
 * `scanIterator()` walks the keyspace of every primary.
 *
 * The key of a command is its first key (EVAL's and XREAD's too, where it is
 * not the first argument); a command naming several keys needs them in one
 * slot, as on any cluster: give them a common hash tag.
 */
export class HotKVCluster implements Executor {
  private readonly baseOptions: HotKVOptions;
  private readonly maxRedirects: number;
  private readonly readFromReplicas: boolean;
  private readonly retryTimeoutMs: number;
  private readonly retryWrites: boolean;
  private readonly clients = new Map<string, HotKV>();
  private readonly suspect = new Map<string, number>();
  private slots: Array<SlotRange | undefined> = new Array(CLUSTER_SLOTS);
  private readonly seeds: ClusterNodeAddr[];
  private slotsLoaded = false;
  // The seed answered CLUSTER SLOTS with no range at all: it is not part of a cluster (cluster mode
  // off), and the client talks to it like a plain client.
  private standalone = false;
  private refreshing: Promise<void> | undefined;

  constructor(nodes: Array<string | ClusterNodeAddr>, options?: HotKVClusterOptions) {
    this.seeds = nodes.map((n) => (typeof n === "string" ? parseAddr(n) : n));
    if (this.seeds.length === 0) throw new ClusterError("at least one seed node is required");
    const { maxRedirects, readFromReplicas, retryTimeoutMs, retryWrites, ...rest } = options ?? {};
    this.baseOptions = rest;
    this.maxRedirects = maxRedirects ?? 16;
    this.readFromReplicas = readFromReplicas ?? false;
    this.retryTimeoutMs = retryTimeoutMs ?? 10_000;
    this.retryWrites = retryWrites ?? true;
  }

  /** Sends one command, routed by key slot, following redirects and riding out a failover. */
  async execute(args: CommandArgs): Promise<RespValue> {
    await this.ensureSlots();
    const kind = fanoutKind(args);
    if (kind !== undefined) return this.fanOut(kind, args);
    return this.send(args, isReadOnlyCommand(commandName(args)));
  }

  /** Generic escape hatch: send any command by name, typed or not. */
  async command(...args: Array<string | number | bigint | Buffer>): Promise<RespValue> {
    return this.execute(args);
  }

  /** Loads the slot map ahead of the first command. Optional: it loads lazily anyway. */
  async connect(): Promise<void> {
    await this.ensureSlots();
  }

  /** Re-fetches CLUSTER SLOTS, asking the seeds and every node it has learned of, the ones that failed lately last. */
  async refreshSlots(): Promise<void> {
    let lastErr: unknown;
    for (const node of this.knownNodes()) {
      try {
        const reply = arr(await this.clientFor(node).executeOnce(["CLUSTER", "SLOTS"]));
        this.applySlots(reply, node.host);
        this.slotsLoaded = true;
        return;
      } catch (err) {
        this.suspect.set(addrKey(node), Date.now());
        lastErr = err;
      }
    }
    throw new ClusterError(`could not fetch CLUSTER SLOTS from any node: ${String(lastErr)}`);
  }

  /** A read-only view of the current slot -> node routing table (index = slot, 0..16383). */
  slotMap(): ReadonlyArray<Readonly<SlotRange> | undefined> {
    return this.slots;
  }

  /** The distinct primaries that serve at least one slot, sorted by address. */
  masters(): ClusterNodeAddr[] {
    const seen = new Map<string, ClusterNodeAddr>();
    for (const range of this.slots) {
      if (range) seen.set(addrKey(range.master), range.master);
    }
    return [...seen.values()].sort((a, b) => addrKey(a).localeCompare(addrKey(b)));
  }

  /**
   * Sends one command to one specific node (a primary or a replica), with no
   * routing and no redirect following: for per-node administration and scans.
   */
  async executeOnNode(addr: ClusterNodeAddr, args: CommandArgs): Promise<RespValue> {
    return this.clientFor(addr).executeOnce(args);
  }

  /** Sends one command to every primary that serves slots; the reply of each, by `host:port`. */
  async executeOnPrimaries(args: CommandArgs): Promise<Map<string, RespValue>> {
    await this.ensureSlots();
    const out = new Map<string, RespValue>();
    for (const node of this.primaries()) out.set(addrKey(node), await this.executeOnNode(node, args));
    return out;
  }

  /** Iterates every key of the cluster: SCAN pages through each primary in turn. */
  async *scanIterator(opts?: ScanOptions): AsyncGenerator<string> {
    await this.ensureSlots();
    for (const node of this.primaries()) {
      let cursor = "0";
      do {
        const args: string[] = ["SCAN", cursor];
        if (opts?.match !== undefined) args.push("MATCH", opts.match);
        if (opts?.count !== undefined) args.push("COUNT", String(opts.count));
        if (opts?.type !== undefined) args.push("TYPE", opts.type);
        const reply = arr(await this.executeOnNode(node, args));
        cursor = str(reply[0] as RespValue);
        for (const key of arr(reply[1] as RespValue)) yield str(key);
      } while (cursor !== "0");
    }
  }

  hscanIterator(key: string, opts?: HScanOptions): AsyncGenerator<[string, string] | string> {
    return hscanIterator(this, key, opts);
  }

  sscanIterator(key: string, opts?: ScanOptions): AsyncGenerator<string> {
    return sscanIterator(this, key, opts);
  }

  zscanIterator(key: string, opts?: ScanOptions): AsyncGenerator<[string, string]> {
    return zscanIterator(this, key, opts);
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }

  // -- routing ------------------------------------------------------------------

  private slotOf(args: CommandArgs): number | undefined {
    const key = routingKey(args);
    return key === undefined ? undefined : keySlot(key);
  }

  /** The nodes a command for every primary goes to: the seed itself when it is not in a cluster. */
  private primaries(): ClusterNodeAddr[] {
    return this.standalone ? [this.seeds[0] as ClusterNodeAddr] : this.masters();
  }

  private anyNode(): ClusterNodeAddr {
    for (const range of this.slots) {
      if (range) return range.master;
    }
    return this.seeds[0] as ClusterNodeAddr;
  }

  private async pick(
    args: CommandArgs,
    readonly: boolean,
    avoidReplicas: boolean,
  ): Promise<{ node: ClusterNodeAddr; replica: boolean }> {
    const slot = this.slotOf(args);
    if (slot === undefined) return { node: this.anyNode(), replica: false };
    // A node that is not part of a cluster answers CLUSTER SLOTS with no
    // ranges at all: the client then talks to its seed like a plain client,
    // and asks for the map again only when a command fails.
    if (this.standalone) return { node: this.seeds[0] as ClusterNodeAddr, replica: false };
    let range = this.slots[slot];
    if (!range) {
      await this.refreshSlots();
      if (this.standalone) return { node: this.seeds[0] as ClusterNodeAddr, replica: false };
      range = this.slots[slot];
    }
    if (!range) throw new ClusterError(`no node is known to own slot ${slot}`);
    if (readonly && this.readFromReplicas && !avoidReplicas && range.replicas.length > 0) {
      const i = Math.floor(Math.random() * range.replicas.length);
      return { node: range.replicas[i] as ClusterNodeAddr, replica: true };
    }
    return { node: range.master, replica: false };
  }

  private noteMoved(args: CommandArgs, node: ClusterNodeAddr): void {
    const slot = this.slotOf(args);
    if (slot === undefined) return;
    const prev = this.slots[slot];
    this.slots[slot] = { master: node, replicas: prev?.replicas ?? [] };
  }

  private async backoff(attempt: number, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(50 * 2 ** Math.min(attempt, 4), 500, remaining));
    return true;
  }

  private async refreshQuietly(): Promise<void> {
    try {
      await this.refreshSlotsShared();
    } catch (err) {
      if (!(err instanceof ClusterError)) throw err;
    }
  }

  private mayRetry(err: unknown, readonly: boolean): boolean {
    if (readonly || this.retryWrites) return true;
    return (err as { sent?: boolean }).sent === false;
  }

  private async send(args: CommandArgs, readonly: boolean): Promise<RespValue> {
    const name = commandName(args);
    const deadline = Date.now() + this.retryTimeoutMs;
    let redirects = 0;
    let attempt = 0;
    let askTarget: ClusterNodeAddr | undefined;
    let avoidReplicas = false;
    let lastError: unknown;
    for (;;) {
      let node: ClusterNodeAddr;
      let replica = false;
      let asking = false;
      if (askTarget) {
        node = askTarget;
        asking = true;
        askTarget = undefined;
      } else {
        try {
          ({ node, replica } = await this.pick(args, readonly, avoidReplicas));
        } catch (err) {
          if (!(err instanceof ClusterError)) throw err;
          // The slot has no owner in the map: the cluster is mid-change.
          lastError = err;
          if (!(await this.backoff(attempt++, deadline))) throw err;
          await this.refreshQuietly();
          continue;
        }
      }
      try {
        return await this.clientFor(node, replica).executeOnce(args, asking);
      } catch (err) {
        lastError = err;
        if (err instanceof MovedError) {
          if (++redirects > this.maxRedirects) break;
          await this.refreshQuietly();
          // The node that answered MOVED knows where the slot went before
          // CLUSTER SLOTS may show it: follow it.
          this.noteMoved(args, parseAddr(err.address, node.host));
          avoidReplicas = true;
          continue;
        }
        if (err instanceof AskError) {
          if (++redirects > this.maxRedirects) break;
          askTarget = parseAddr(err.address, node.host);
          continue;
        }
        if (isTransient(err)) {
          if (!(await this.backoff(attempt++, deadline))) throw err;
          avoidReplicas = avoidReplicas || replica;
          await this.refreshQuietly();
          continue;
        }
        if (isTransport(err)) {
          this.suspect.set(addrKey(node), Date.now());
          if (!this.mayRetry(err, readonly)) throw err;
          if (!(await this.backoff(attempt++, deadline))) {
            throw new ClusterError(`giving up on ${name} after ${this.retryTimeoutMs}ms of retries: ${String(err)}`);
          }
          avoidReplicas = avoidReplicas || replica;
          await this.refreshQuietly();
          continue;
        }
        throw err;
      }
    }
    throw new ClusterError(`too many redirects (${this.maxRedirects}) executing ${name}: ${String(lastError)}`);
  }

  private async fanOut(kind: FanoutKind, args: CommandArgs): Promise<RespValue> {
    const deadline = Date.now() + this.retryTimeoutMs;
    let attempt = 0;
    for (;;) {
      try {
        const replies: RespValue[] = [];
        for (const node of this.primaries()) {
          replies.push(await this.clientFor(node).executeOnce(args));
        }
        if (replies.length === 0) throw new ClusterError("the cluster has no primary with slots");
        return mergeReplies(kind, replies);
      } catch (err) {
        const stale =
          err instanceof MovedError ||
          err instanceof ClusterError ||
          isTransient(err) ||
          (isTransport(err) && (this.retryWrites || (err as { sent?: boolean }).sent === false));
        if (!stale) throw err;
        if (!(await this.backoff(attempt++, deadline))) {
          throw err instanceof ClusterError ? err : new ClusterError(`giving up on ${commandName(args)}: ${String(err)}`);
        }
        await this.refreshQuietly();
      }
    }
  }

  // -- slot map -----------------------------------------------------------------

  private knownNodes(): ClusterNodeAddr[] {
    const seen = new Set<string>();
    const out: ClusterNodeAddr[] = [];
    const add = (n: ClusterNodeAddr) => {
      const k = addrKey(n);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(n);
      }
    };
    this.seeds.forEach(add);
    for (const range of this.slots) {
      if (range) {
        add(range.master);
        range.replicas.forEach(add);
      }
    }
    const now = Date.now();
    const recentlyFailed = (n: ClusterNodeAddr) => now - (this.suspect.get(addrKey(n)) ?? -Infinity) < SUSPECT_MS;
    // Stable: the nodes that did not fail lately keep their order, the others go last.
    return [...out.filter((n) => !recentlyFailed(n)), ...out.filter(recentlyFailed)];
  }

  private applySlots(reply: RespValue[], askedHost: string): void {
    const slots: Array<SlotRange | undefined> = new Array(CLUSTER_SLOTS);
    for (const entry of reply) {
      const parts = arr(entry);
      const start = num(parts[0] as RespValue);
      const end = num(parts[1] as RespValue);
      const master = parseNodeEntry(parts[2] as RespValue, askedHost);
      const replicas: ClusterNodeAddr[] = [];
      for (let i = 3; i < parts.length; i++) {
        replicas.push(parseNodeEntry(parts[i] as RespValue, askedHost));
      }
      for (let s = start; s <= end && s < CLUSTER_SLOTS; s++) {
        slots[s] = { master, replicas };
      }
    }
    this.slots = slots;
    this.standalone = reply.length === 0;
  }

  private refreshSlotsShared(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.refreshSlots().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async ensureSlots(): Promise<void> {
    if (this.slotsLoaded) return;
    await this.refreshSlotsShared();
  }

  private clientFor(addr: ClusterNodeAddr, replica = false): HotKV {
    const key = replica ? `${addrKey(addr)}|ro` : addrKey(addr);
    let client = this.clients.get(key);
    if (!client) {
      client = new HotKV({ ...this.baseOptions, host: addr.host, port: addr.port, replicaReads: replica });
      this.clients.set(key, client);
    }
    return client;
  }
}

installCommands(HotKVCluster.prototype as unknown as Record<string, unknown>);
