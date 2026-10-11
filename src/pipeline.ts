// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { AllCommands } from "./commands/index.js";
import { installCommands } from "./commands/index.js";
import type { Connection } from "./connection.js";
import type { Pool } from "./pool.js";
import type { CommandArgs, RespValue } from "./resp/types.js";

interface QueuedCommand {
  args: CommandArgs;
  resolve: (v: RespValue) => void;
  reject: (err: Error) => void;
}

/**
 * Wraps every method installCommands() added to proto so the promise each
 * one returns gets a silent rejection handler attached as soon as it
 * exists. Queuing a command on a Pipeline/Multi is normally consumed
 * through exec()'s aggregate result, not by awaiting each call, so without
 * this a batch with one failed (or, for Multi, aborted) command would
 * crash the process with an unhandled rejection for every other queued
 * call nobody happened to await individually. Callers that do await or
 * .catch() a call still observe its rejection exactly as usual: this only
 * stops Node from also treating it as unhandled.
 */
function silenceUnhandledRejections(proto: object): void {
  const target = proto as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(target)) {
    if (key === "constructor") continue;
    const original = target[key];
    if (typeof original !== "function") continue;
    target[key] = function (this: unknown, ...args: unknown[]): unknown {
      const result = original.apply(this, args) as unknown;
      if (result instanceof Promise) result.catch(() => undefined);
      return result;
    };
  }
}

/** `[error, value]` for one queued command, node callback style: exactly one of the two is set. */
export type PipelineResult = readonly [Error | null, RespValue | undefined];

/**
 * Shared queueing behind Pipeline and Multi. Not exported: the two differ
 * only in how exec() flushes the queue (a plain batch vs a MULTI/EXEC
 * transaction), which is easiest to keep as two unrelated exec() signatures
 * rather than one overridden method.
 */
abstract class CommandQueue {
  protected readonly queue: QueuedCommand[] = [];

  constructor(protected readonly pool: Pool) {}

  execute(args: CommandArgs): Promise<RespValue> {
    const promise = new Promise<RespValue>((resolve, reject) => {
      this.queue.push({ args, resolve, reject });
    });
    // Queuing a command is normally consumed through exec()'s aggregate
    // result, not by awaiting the individual call; attach a silent handler
    // so one failed command in a batch nobody awaited individually never
    // crashes the process with an unhandled rejection. The real promise
    // returned below is unaffected: callers that do await/catch it still
    // observe the rejection normally.
    promise.catch(() => undefined);
    return promise;
  }

  /** Number of commands queued so far. */
  get length(): number {
    return this.queue.length;
  }

  protected settle(batch: QueuedCommand[], results: Array<RespValue | Error>): PipelineResult[] {
    const out: PipelineResult[] = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i] as QueuedCommand;
      const result = results[i];
      if (result instanceof Error) {
        item.reject(result);
        out.push([result, undefined]);
      } else {
        const value = result as RespValue;
        item.resolve(value);
        out.push([null, value]);
      }
    }
    return out;
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Pipeline extends AllCommands {}

/**
 * Batches commands for a single round trip. Every typed command method
 * (get, set, tagSet, ...) is available exactly as on HotKV: calling one
 * queues it and returns a real Promise of the usual decoded type, which
 * settles once exec() runs. exec() itself resolves with one [error, value]
 * pair per command, in order, where value is the raw reply (a bulk string is
 * a Buffer, not the decoded string of the queued promise), and a failed
 * command never aborts the rest of the batch.
 */
export class Pipeline extends CommandQueue {
  /** Sends every queued command in one round trip and returns [error, value] per command, in order. */
  async exec(): Promise<PipelineResult[]> {
    const batch = this.queue.splice(0);
    if (batch.length === 0) return [];

    const conn = await this.pool.acquire();
    let results: Array<RespValue | Error>;
    try {
      results = await conn.sendBatch(batch.map((c) => c.args));
    } catch (err) {
      this.pool.discard(conn);
      const asError = err instanceof Error ? err : new Error(String(err));
      for (const item of batch) item.reject(asError);
      throw err;
    }
    this.pool.release(conn);
    return this.settle(batch, results);
  }

  /** Drops any queued, not yet sent commands without contacting the server. */
  clear(): void {
    for (const item of this.queue.splice(0)) {
      item.reject(new Error("hotkv: pipeline discarded before exec()"));
    }
  }
}

installCommands(Pipeline.prototype as unknown as Record<string, unknown>);
silenceUnhandledRejections(Pipeline.prototype);

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Multi extends AllCommands {}

/**
 * A pipeline wrapped in MULTI/EXEC. If created via HotKV.watch(), it is
 * bound to the connection WATCH ran on, so the whole
 * WATCH -> queue -> EXEC sequence observes one consistent connection.
 * exec() resolves to null if the transaction was aborted because a
 * watched key changed, matching EXEC's own null reply.
 */
export class Multi extends CommandQueue {
  private reservedConn: Connection | undefined;

  constructor(pool: Pool, reservedConn?: Connection) {
    super(pool);
    this.reservedConn = reservedConn;
  }

  async exec(): Promise<PipelineResult[] | null> {
    const batch = this.queue.splice(0);
    const conn = this.reservedConn ?? (await this.pool.acquire());
    this.reservedConn = undefined;

    const commands: CommandArgs[] = [["MULTI"], ...batch.map((c) => c.args), ["EXEC"]];
    let results: Array<RespValue | Error>;
    try {
      results = await conn.sendBatch(commands);
    } catch (err) {
      this.pool.discard(conn);
      const asError = err instanceof Error ? err : new Error(String(err));
      for (const item of batch) item.reject(asError);
      throw err;
    }
    this.pool.release(conn);

    const execResult = results[results.length - 1];
    if (execResult === null) {
      const abortErr = new Error("hotkv: transaction aborted (a watched key changed)");
      for (const item of batch) item.reject(abortErr);
      return null;
    }
    if (execResult instanceof Error) {
      for (const item of batch) item.reject(execResult);
      throw execResult;
    }
    return this.settle(batch, execResult as RespValue[]);
  }

  /**
   * Abandons this transaction: clears anything queued and, if a WATCH is
   * pinning a reserved connection (from HotKV.watch()), sends UNWATCH and
   * releases it. Safe to call even if nothing was ever queued or watched.
   */
  async discard(): Promise<void> {
    for (const item of this.queue.splice(0)) {
      item.reject(new Error("hotkv: transaction discarded"));
    }
    const conn = this.reservedConn;
    this.reservedConn = undefined;
    if (!conn) return;
    try {
      await conn.sendCommand(["UNWATCH"]);
      this.pool.release(conn);
    } catch (err) {
      this.pool.discard(conn);
      throw err;
    }
  }

  /** Alias for discard(): releases any WATCH without running the transaction. */
  async unwatch(): Promise<void> {
    return this.discard();
  }
}

installCommands(Multi.prototype as unknown as Record<string, unknown>);
silenceUnhandledRejections(Multi.prototype);
