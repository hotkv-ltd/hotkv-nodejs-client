// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { EventEmitter } from "node:events";
import type { AllCommands } from "./commands/index.js";
import { installCommands } from "./commands/index.js";
import { ConnectionError, ReplyError } from "./errors.js";
import type { HotKVOptions, ResolvedOptions } from "./options.js";
import { resolveOptions } from "./options.js";
import { Multi, Pipeline } from "./pipeline.js";
import { Pool, type PoolStats } from "./pool.js";
import { PubSub } from "./pubsub.js";
import { isReadOnlyCommand } from "./readonly-commands.js";
import type { CommandArg, CommandArgs, RespValue } from "./resp/types.js";
import {
  type HScanOptions,
  type ScanOptions,
  hscanIterator,
  scanIterator,
  sscanIterator,
  zscanIterator,
} from "./scan.js";

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface HotKV extends AllCommands {}

/**
 * The HotKV client: a pooled connection to one HotKV node with a typed
 * method for every supported command, plus
 * pipelines, transactions, pub/sub and SCAN family iterators. Connection
 * is lazy: the pool opens sockets on first use, not in the constructor.
 */
export class HotKV extends EventEmitter {
  readonly options: ResolvedOptions;
  private readonly pool: Pool;
  private closed = false;

  constructor(options?: string | HotKVOptions) {
    super();
    this.options = resolveOptions(options);
    this.pool = new Pool(this.options);
  }

  /** Opens (and health checks) one connection ahead of time. Optional: commands connect lazily anyway. */
  async connect(): Promise<void> {
    const conn = await this.pool.acquire();
    this.pool.release(conn);
  }

  /** Sends one command and returns its decoded reply. Every typed method below is a thin wrapper over this. */
  async execute(args: CommandArgs): Promise<RespValue> {
    return this.executeWithRetry(args, this.options.maxRetries);
  }

  /** Generic escape hatch: send any command by name, typed or not. */
  async command(...args: CommandArg[]): Promise<RespValue> {
    return this.execute(args);
  }

  /**
   * One attempt at a command, with no retry of its own (HotKVCluster owns the
   * retry policy). With `asking`, ASKING goes first on the very same pooled
   * connection, as an ASK redirect needs. A connection error carries `sent`:
   * false when the command never left (the connection could not be opened),
   * true when it may have reached the server.
   */
  async executeOnce(args: CommandArgs, asking = false): Promise<RespValue> {
    let conn;
    try {
      conn = await this.pool.acquire();
    } catch (err) {
      (err as { sent?: boolean }).sent = false;
      throw err;
    }
    try {
      if (asking) await conn.sendCommand(["ASKING"]);
      const result = await conn.sendCommand(args);
      this.pool.release(conn);
      return result;
    } catch (err) {
      if (err instanceof ReplyError) {
        this.pool.release(conn);
        throw err;
      }
      this.pool.discard(conn);
      (err as { sent?: boolean }).sent = true;
      throw err;
    }
  }

  /** A batch of commands sent in one round trip. See Pipeline. */
  pipeline(): Pipeline {
    return new Pipeline(this.pool);
  }

  /** A batch of commands run atomically inside MULTI/EXEC. See Multi. */
  multi(): Multi {
    return new Multi(this.pool);
  }

  /**
   * Issues WATCH on a dedicated connection and returns a Multi bound to it,
   * so the eventual EXEC observes the same connection WATCH ran on. Call
   * .exec() to run the transaction, or .unwatch()/.discard() to release the
   * watch without running one.
   */
  async watch(...keys: string[]): Promise<Multi> {
    const conn = await this.pool.acquire();
    try {
      await conn.sendCommand(["WATCH", ...keys]);
    } catch (err) {
      this.pool.discard(conn);
      throw err;
    }
    return new Multi(this.pool, conn);
  }

  /** Subscribes to channels on a new dedicated connection. Add more with the returned PubSub's own methods. */
  subscribe(...channels: string[]): PubSub {
    const ps = new PubSub(this.options);
    if (channels.length > 0) {
      ps.subscribe(...channels).catch((err: unknown) => ps.emit("error", err));
    }
    return ps;
  }

  /** Like subscribe(), but for glob patterns (PSUBSCRIBE). */
  psubscribe(...patterns: string[]): PubSub {
    const ps = new PubSub(this.options);
    if (patterns.length > 0) {
      ps.psubscribe(...patterns).catch((err: unknown) => ps.emit("error", err));
    }
    return ps;
  }

  /** Like subscribe(), but for sharded pub/sub channels (SSUBSCRIBE). */
  ssubscribe(...channels: string[]): PubSub {
    const ps = new PubSub(this.options);
    if (channels.length > 0) {
      ps.ssubscribe(...channels).catch((err: unknown) => ps.emit("error", err));
    }
    return ps;
  }

  /** Iterates the whole keyspace with SCAN, honoring MATCH/COUNT/TYPE, without blocking the server. */
  scanIterator(opts?: ScanOptions): AsyncGenerator<string> {
    return scanIterator(this, opts);
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

  poolStats(): PoolStats {
    return this.pool.stats();
  }

  /** A second, independent client with the same (or overridden) options. */
  duplicate(overrides?: HotKVOptions): HotKV {
    return new HotKV({ ...this.options, ...overrides } as HotKVOptions);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.close();
  }

  private async executeWithRetry(args: CommandArgs, retriesLeft: number): Promise<RespValue> {
    const conn = await this.pool.acquire();
    try {
      const result = await conn.sendCommand(args);
      this.pool.release(conn);
      return result;
    } catch (err) {
      if (err instanceof ReplyError) {
        // The connection itself is fine; only the command failed.
        this.pool.release(conn);
        throw err;
      }
      this.pool.discard(conn);
      const name = typeof args[0] === "string" ? args[0] : "";
      if (retriesLeft > 0 && err instanceof ConnectionError && isReadOnlyCommand(name)) {
        return this.executeWithRetry(args, retriesLeft - 1);
      }
      throw err;
    }
  }
}

installCommands(HotKV.prototype as unknown as Record<string, unknown>);

/** Creates a HotKV client. Equivalent to `new HotKV(options)`. */
export function createClient(options?: string | HotKVOptions): HotKV {
  return new HotKV(options);
}
