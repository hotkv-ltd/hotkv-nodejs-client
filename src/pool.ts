// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { Connection } from "./connection.js";
import { PoolExhaustedError, PoolTimeoutError } from "./errors.js";
import type { ResolvedOptions } from "./options.js";

export interface PoolStats {
  total: number;
  idle: number;
  inUse: number;
  waiting: number;
}

interface Waiter {
  resolve: (conn: Connection) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A bounded pool of Connections to one HotKV node: borrowed connections are
 * health checked with PING if they have sat idle past idleTimeoutMs, callers
 * that arrive once the pool is at maxSize wait in FIFO order for a release,
 * and every method here is safe to call from many concurrent async
 * operations (single threaded, but interleaving safe).
 */
export class Pool {
  private readonly idle: Connection[] = [];
  private readonly inUse = new Set<Connection>();
  private readonly all = new Set<Connection>();
  private readonly waiters: Waiter[] = [];
  private closed = false;

  constructor(private readonly opts: ResolvedOptions) {}

  async acquire(): Promise<Connection> {
    if (this.closed) throw new PoolTimeoutError("pool is closed");

    while (this.idle.length > 0) {
      const conn = this.idle.pop() as Connection;
      if (conn.closed) continue;
      if (Date.now() - conn.lastUsedAt > this.opts.pool.idleTimeoutMs) {
        try {
          await conn.ping();
        } catch {
          continue;
        }
      }
      this.inUse.add(conn);
      return conn;
    }

    if (this.all.size < this.opts.pool.maxSize) {
      return this.createConnection();
    }

    return this.wait();
  }

  /** Returns a healthy connection to the idle pool, or hands it straight to a waiter. */
  release(conn: Connection): void {
    if (!this.all.has(conn)) return;
    this.inUse.delete(conn);
    if (this.closed || conn.closed) {
      this.forget(conn);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      this.inUse.add(conn);
      waiter.resolve(conn);
      return;
    }
    this.idle.push(conn);
  }

  /** Drops a broken connection instead of returning it to the pool. */
  discard(conn: Connection): void {
    this.forget(conn);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new PoolTimeoutError("pool closed while waiting for a connection"));
    }
    for (const conn of [...this.all]) conn.close();
  }

  stats(): PoolStats {
    return {
      total: this.all.size,
      idle: this.idle.length,
      inUse: this.inUse.size,
      waiting: this.waiters.length,
    };
  }

  private async createConnection(): Promise<Connection> {
    const conn = new Connection(this.opts);
    this.all.add(conn);
    conn.once("close", () => this.forget(conn));
    try {
      await conn.connect();
    } catch (err) {
      this.forget(conn);
      throw err;
    }
    this.inUse.add(conn);
    return conn;
  }

  private wait(): Promise<Connection> {
    if (this.opts.pool.acquireTimeoutMs <= 0) {
      return Promise.reject(new PoolExhaustedError());
    }
    return new Promise<Connection>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new PoolTimeoutError());
      }, this.opts.pool.acquireTimeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private forget(conn: Connection): void {
    if (!this.all.delete(conn)) return;
    this.inUse.delete(conn);
    const idx = this.idle.indexOf(conn);
    if (idx >= 0) this.idle.splice(idx, 1);
    if (!conn.closed) conn.close();
    this.dispatchWaiter();
  }

  private dispatchWaiter(): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.createConnection().then(
      (conn) => waiter.resolve(conn),
      (err: unknown) => waiter.reject(err instanceof Error ? err : new PoolTimeoutError(String(err))),
    );
  }
}
