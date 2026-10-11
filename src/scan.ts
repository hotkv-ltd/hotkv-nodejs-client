// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "./executor.js";
import { arr, str, strArr } from "./resp/decode.js";
import type { RespValue } from "./resp/types.js";

export interface ScanOptions {
  /** Only return keys/fields/members matching this glob pattern. */
  match?: string;
  /** A hint for how many entries the server examines per call. */
  count?: number;
  /** SCAN only: restrict to keys of this type (e.g. "string", "hash"). */
  type?: string;
}

export interface HScanOptions extends ScanOptions {
  /** HSCAN only: return field names without their values. */
  noValues?: boolean;
}

function cursorArgs(cursor: string, opts: ScanOptions | undefined, withType: boolean): string[] {
  const args: string[] = [cursor];
  if (opts?.match !== undefined) args.push("MATCH", opts.match);
  if (opts?.count !== undefined) args.push("COUNT", String(opts.count));
  if (withType && opts?.type !== undefined) args.push("TYPE", opts.type);
  return args;
}

async function* cursorIterator(
  exec: Executor,
  command: string,
  keyArg: string[],
  opts: ScanOptions | undefined,
  withType: boolean,
  extra: string[] = [],
): AsyncGenerator<string[]> {
  let cursor = "0";
  do {
    const reply = arr(
      await exec.execute([command, ...keyArg, ...cursorArgs(cursor, opts, withType), ...extra]),
    );
    cursor = str(reply[0] as RespValue);
    yield strArr(reply[1] as RespValue);
  } while (cursor !== "0");
}

/** Incrementally iterates the keyspace with SCAN, honoring MATCH/COUNT/TYPE. */
export async function* scanIterator(exec: Executor, opts?: ScanOptions): AsyncGenerator<string> {
  for await (const page of cursorIterator(exec, "SCAN", [], opts, true)) {
    yield* page;
  }
}

/** Incrementally iterates a hash's fields with HSCAN. Yields [field, value] pairs, or bare field names with noValues. */
export function hscanIterator(
  exec: Executor,
  key: string,
  opts?: HScanOptions,
): AsyncGenerator<[string, string] | string> {
  const extra = opts?.noValues ? ["NOVALUES"] : [];
  async function* gen(): AsyncGenerator<[string, string] | string> {
    for await (const page of cursorIterator(exec, "HSCAN", [key], opts, false, extra)) {
      if (opts?.noValues) {
        yield* page;
      } else {
        for (let i = 0; i + 1 < page.length; i += 2) {
          yield [page[i] as string, page[i + 1] as string];
        }
      }
    }
  }
  return gen();
}

/** Incrementally iterates a set's members with SSCAN. */
export async function* sscanIterator(exec: Executor, key: string, opts?: ScanOptions): AsyncGenerator<string> {
  for await (const page of cursorIterator(exec, "SSCAN", [key], opts, false)) {
    yield* page;
  }
}

/** Incrementally iterates a sorted set's members with ZSCAN. Yields [member, score] pairs. */
export async function* zscanIterator(
  exec: Executor,
  key: string,
  opts?: ScanOptions,
): AsyncGenerator<[string, string]> {
  for await (const page of cursorIterator(exec, "ZSCAN", [key], opts, false)) {
    for (let i = 0; i + 1 < page.length; i += 2) {
      yield [page[i] as string, page[i + 1] as string];
    }
  }
}
