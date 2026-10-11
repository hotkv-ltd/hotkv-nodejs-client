// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// A fake Executor for unit-testing typed command wrappers with no
// server: every call records its raw wire arguments, and returns a
// canned reply queued for that command name (see when()), so both the
// exact argument list a wrapper method sends and its reply decoding can
// be exercised without a network round trip.

import { installCommands, type AllCommands } from "../../src/commands/index.js";
import type { CommandArgs, RespValue } from "../../src/resp/types.js";

export class RecordingExecutor {
  calls: CommandArgs[] = [];
  private replies = new Map<string, RespValue>();

  /** Queues the raw (server-shaped) reply the next call matching
   * `commandName` should return. `commandName` may be one wire token
   * ("SCACHE.STATS") or two ("LLMSTATS.PRICE GET") for command families
   * whose subcommand is args[1]. */
  when(commandName: string, reply: RespValue): void {
    this.replies.set(commandName, reply);
  }

  async execute(args: CommandArgs): Promise<RespValue> {
    this.calls.push(args);
    const twoToken = `${String(args[0])} ${args[1] === undefined ? "" : String(args[1])}`.trim();
    if (this.replies.has(twoToken)) return this.replies.get(twoToken) as RespValue;
    const oneToken = String(args[0]);
    if (this.replies.has(oneToken)) return this.replies.get(oneToken) as RespValue;
    return null;
  }

  get lastCall(): CommandArgs {
    const call = this.calls.at(-1);
    if (!call) throw new Error("RecordingExecutor: no calls recorded yet");
    return call;
  }
}

/** A `RecordingExecutor` with every typed command method installed, for
 * calling e.g. `client.pcacheSet(...)` directly in a unit test. */
export type RecordingClient = RecordingExecutor & AllCommands;

export function makeRecordingClient(): RecordingClient {
  const executor = new RecordingExecutor();
  installCommands(executor as unknown as object);
  return executor as unknown as RecordingClient;
}
